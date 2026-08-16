import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { getMeepoDb } from "./db.js";
import { getRpcBridgeSocketPath, readRpcBridgeStatus, sendRpcBridgeCommand } from "./rpc-client.js";
import {
	applyNoWaitSystemPrompt,
	classifyNoWaitBashCommand,
	formatNoWaitPolicyViolation,
	getBashCommandFromToolInput,
	noWaitBashBlockReason,
	type NoWaitMode,
} from "./no-wait-policy.js";
import { TASK_STATES, TASK_WAITING_ON_VALUES } from "./task-types.js";
import { applyChildPublishToLinkedTask } from "./task-registry.js";
import {
	createAgentAttentionItemV2,
	createAgentEvent,
	createMessageWithRecipients,
	getAgent,
	listActiveAgentEdges,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessages,
	resolveAgentActorContext,
	updateAgent,
} from "./registry.js";
import { truncateText } from "./text-util.js";
import type {
	AgentMessageRecord,
	AgentRecipientRef,
	AgentThreadKind,
	AgentTransportState,
	ChildDownwardDeliveryMode,
	ChildRuntimeEnvironment,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	RuntimeStatusSnapshot,
	SubagentPublishPayload,
} from "./types.js";

import {
	deliverQueuedParentMessagesViaBridge,
	formatDownwardMessage,
	getAssistantText,
	getDeliveryOptions,
	isAssistantMessage,
	markV2RecipientStatusForLegacyMessage,
} from "./child-downward.js";
import { publishChildUpdate, recipientLabel } from "./child-publish.js";
import {
	appendRunEvent,
	readLatestStatusFromDisk,
	resolveDownwardDeliveryMode,
	updateStatus,
	writeLatestStatus,
} from "./child-status.js";

const CHILD_PUBLISH_KIND = StringEnum(["milestone", "blocked", "question", "question_for_user", "note", "complete"] as const, {
	description: "Type of child-originated update to publish to the registry.",
});
const TASK_STATUS = StringEnum(TASK_STATES, {
	description: "Optional linked-task status recommendation for this update.",
});
const TASK_WAITING_ON = StringEnum(TASK_WAITING_ON_VALUES, {
	description: "Optional linked-task waiting-on target when blocked.",
});

const DOWNWARD_MESSAGE_POLL_MS = 2000;
const BRIDGE_STATUS_STALE_MS = 10_000;
const POLL_FALLBACK_TRANSPORT_STATES = new Set<AgentTransportState>(["fallback", "disconnected", "stopped", "error", "lost"]);
// Terminal states owned by the bridge on rpc_bridge children. Child-runtime writes must not
// regress these back to running/launching, since the bridge observed the authoritative exit.
const BRIDGE_TERMINAL_STATES = new Set<RuntimeStatusSnapshot["state"]>(["error", "stopped"]);
const CHILD_LOCAL_TERMINAL_STATES = new Set<RuntimeStatusSnapshot["state"]>(["done", "error", "stopped"]);
// States the child itself owns via subagent_publish. Routine lifecycle events (tool start,
// message end, agent start) must not clobber these back to `running`.
const CHILD_SELF_OWNED_STATES = new Set<RuntimeStatusSnapshot["state"]>(["blocked", "waiting", "done"]);

const PublishParams = Type.Object({
	kind: CHILD_PUBLISH_KIND,
	summary: Type.String({ description: "Short summary for the update." }),
	details: Type.Optional(Type.String({ description: "Additional context or handoff details." })),
	files: Type.Optional(Type.Array(Type.String({ description: "Relevant file path" }), { maxItems: 100 })),
	attempted: Type.Optional(Type.String({ description: "What was attempted before getting blocked." })),
	answerNeeded: Type.Optional(Type.String({ description: "The exact answer or decision needed." })),
	recommendedNextAction: Type.Optional(Type.String({ description: "Suggested next step for the coordinator." })),
	taskStatus: Type.Optional(TASK_STATUS),
	waitingOn: Type.Optional(TASK_WAITING_ON),
	blockedReason: Type.Optional(Type.String({ description: "Optional linked-task blocker summary." })),
	taskSummary: Type.Optional(Type.String({ description: "Optional linked-task summary to store." })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	reviewSummary: Type.Optional(Type.String({ description: "Optional linked-task review summary." })),
	finalSummary: Type.Optional(Type.String({ description: "Optional linked-task final summary." })),
});

export function getChildRuntimeEnvironment(): ChildRuntimeEnvironment | null {
	if (process.env.PI_TMUX_AGENTS_CHILD !== "1") return null;
	const childId = process.env.PI_TMUX_AGENTS_CHILD_ID?.trim();
	const runDir = process.env.PI_TMUX_AGENTS_RUN_DIR?.trim();
	const profile = process.env.PI_TMUX_AGENTS_PROFILE?.trim();
	if (!childId || !runDir || !profile) return null;
	const allowedTools = (process.env.PI_TMUX_AGENTS_ALLOWED_TOOLS ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return {
		childId,
		runDir,
		profile,
		allowedTools,
		taskId: process.env.PI_TMUX_AGENTS_TASK_ID?.trim() || null,
		parentAgentId: process.env.PI_TMUX_AGENTS_PARENT_AGENT_ID?.trim() || null,
		spawnSessionId: process.env.PI_TMUX_AGENTS_SPAWN_SESSION_ID?.trim() || null,
		spawnSessionFile: process.env.PI_TMUX_AGENTS_SPAWN_SESSION_FILE?.trim() || null,
		transportKind: process.env.PI_TMUX_AGENTS_TRANSPORT_KIND?.trim() === "rpc_bridge" ? "rpc_bridge" : "direct",
		bridgeStatusFile: process.env.PI_TMUX_AGENTS_BRIDGE_STATUS_FILE?.trim() || null,
	};
}


export interface RegisterChildRuntimeOptions {
	/** Defaults to enforce (historical child behavior). */
	noWaitMode?: NoWaitMode;
}

export function registerChildRuntime(
	pi: ExtensionAPI,
	environment: ChildRuntimeEnvironment,
	options: RegisterChildRuntimeOptions = {},
): void {
	const noWaitMode: NoWaitMode = options.noWaitMode ?? "enforce";
	let startedPublished = false;
	let completePublished = false;
	let downwardPoll: ReturnType<typeof setInterval> | undefined;
	let downwardDeliveryMode: ChildDownwardDeliveryMode = environment.transportKind === "rpc_bridge" ? "rpc_bridge" : "poll_fallback";
	const pendingAckIds = new Set<string>();
	const pendingV2AckRecipientRowIds = new Set<string>();
	const pendingV2AckMessageIds = new Set<string>();
	let statusSnapshot: RuntimeStatusSnapshot = {
		agentId: environment.childId,
		profile: environment.profile,
		state: "launching",
		updatedAt: Date.now(),
		lastToolName: null,
		lastAssistantPreview: null,
		lastError: null,
		finalSummary: null,
		source: "child_runtime",
		transportKind: environment.transportKind,
		transportState: environment.transportKind === "rpc_bridge" ? "launching" : "legacy",
		downwardDeliveryMode,
	};

	const renderDownwardMessage = (message: { content: string }, _options: unknown, theme: { fg: (name: string, text: string) => string; bold: (text: string) => string }) => {
		const lines = [`${theme.fg("accent", theme.bold("↓ coordinator"))} ${message.content}`];
		return new Text(lines.join("\n"), 0, 0);
	};
	pi.registerMessageRenderer("meepo-downward", renderDownwardMessage);
	// Pre-rename sessions may still contain this custom type.
	pi.registerMessageRenderer("tmux-agents-downward", renderDownwardMessage);

	function syncDownwardDeliveryMode(ctx: ExtensionContext): ChildDownwardDeliveryMode {
		const resolved = resolveDownwardDeliveryMode(environment);
		if (
			resolved.mode === downwardDeliveryMode &&
			statusSnapshot.transportState === resolved.transportState &&
			statusSnapshot.downwardDeliveryMode === resolved.mode
		) {
			return downwardDeliveryMode;
		}
		downwardDeliveryMode = resolved.mode;
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				transportKind: environment.transportKind,
				transportState: resolved.transportState,
				downwardDeliveryMode: resolved.mode,
				updatedAt: Date.now(),
			},
			statusSnapshot,
		);
		createAgentEvent(getMeepoDb(), {
			id: randomUUID(),
			agentId: environment.childId,
			eventType: "downward_transport_mode",
			summary:
				resolved.mode === "poll_fallback"
					? `Using mailbox polling fallback (${resolved.reason ?? resolved.transportState}).`
					: `Using live RPC bridge delivery (${resolved.transportState}).`,
			payload: {
				mode: resolved.mode,
				transportState: resolved.transportState,
				reason: resolved.reason,
			},
		});
		appendRunEvent(
			environment,
			"downward_transport_mode",
			resolved.mode === "poll_fallback"
				? `Using mailbox polling fallback (${resolved.reason ?? resolved.transportState}).`
				: `Using live RPC bridge delivery (${resolved.transportState}).`,
			{ mode: resolved.mode, transportState: resolved.transportState, reason: resolved.reason },
		);
		return downwardDeliveryMode;
	}

	function ackPendingPollFallbackDeliveries(): void {
		const db = getMeepoDb();
		if (pendingAckIds.size > 0) {
			markAgentMessages(db, [...pendingAckIds], "acked");
			pendingAckIds.clear();
		}
		if (pendingV2AckRecipientRowIds.size > 0) {
			markAgentMessageRecipientsByIds(db, [...pendingV2AckRecipientRowIds], "acked", {
				recipientAgentId: environment.childId,
				transportKind: "poll_fallback",
			});
			pendingV2AckRecipientRowIds.clear();
		}
		if (pendingV2AckMessageIds.size > 0) {
			markAgentMessageRecipientsByMessageIds(db, [...pendingV2AckMessageIds], "acked", {
				recipientAgentId: environment.childId,
				transportKind: "poll_fallback",
			});
			pendingV2AckMessageIds.clear();
		}
	}

	async function drainDownwardMessages(): Promise<void> {
		const db = getMeepoDb();
		const messages = listMessagesForRecipient(db, environment.childId, { targetKind: "child", limit: 25 });
		for (const message of messages) {
			try {
				pi.sendMessage(
					{
						customType: "meepo-downward",
						content: formatDownwardMessage(message),
						display: true,
						details: message,
					},
					getDeliveryOptions(message),
				);
				markAgentMessages(db, [message.id], "delivered");
				const v2Payload = getV2Payload(message);
				if (v2Payload?.v2RecipientRowId) {
					markAgentMessageRecipientsByIds(db, [v2Payload.v2RecipientRowId], "read", {
						recipientAgentId: environment.childId,
						transportKind: "poll_fallback",
					});
					pendingV2AckRecipientRowIds.add(v2Payload.v2RecipientRowId);
				} else if (v2Payload?.v2MessageId) {
					markAgentMessageRecipientsByMessageIds(db, [v2Payload.v2MessageId], "read", {
						recipientAgentId: environment.childId,
						transportKind: "poll_fallback",
					});
					pendingV2AckMessageIds.add(v2Payload.v2MessageId);
				}
				pendingAckIds.add(message.id);
				appendRunEvent(environment, "downward_delivered", `Delivered ${message.kind}`, {
					messageId: message.id,
					v2MessageId: v2Payload?.v2MessageId ?? null,
					v2RecipientRowId: v2Payload?.v2RecipientRowId ?? null,
					deliveryMode: "poll_fallback",
				});
			} catch (error) {
				createAgentEvent(db, {
					id: randomUUID(),
					agentId: environment.childId,
					eventType: "downward_delivery_failed",
					summary: error instanceof Error ? error.message : String(error),
					payload: { messageId: message.id, deliveryMode: "poll_fallback" },
				});
			}
		}
	}

	async function maybeDrainDownwardMessages(ctx: ExtensionContext): Promise<void> {
		const mode = syncDownwardDeliveryMode(ctx);
		if (mode !== "poll_fallback") return;
		await drainDownwardMessages();
	}

	pi.registerTool({
		name: "subagent_publish",
		label: "Subagent Publish",
		description: "Publish milestone, blocker, question, or completion updates from this child session to the global meepo registry.",
		promptSnippet: "Publish milestone/blocker/question/complete updates upward to the coordinator registry.",
		promptGuidelines: [
			"Use subagent_publish proactively for milestones, blockers, concrete questions, and final completion handoffs.",
			"After acting on a coordinator answer, redirect, cancel, or priority message, publish a concise note or completion update so the coordinator does not need pane capture.",
			"Do not use sleep/watch/polling loops to wait for another agent; publish or return pending status and yield instead.",
			"For blockers, include what you tried, the exact answer needed, and waitingOn/taskStatus when relevant.",
			"For completion, include files changed/involved, blockers remaining, a recommended next action, and taskStatus when the linked task should move.",
		],
		parameters: PublishParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const resolvedMode = resolveDownwardDeliveryMode(environment);
			const payload: Omit<SubagentPublishPayload, "kind"> = {
				summary: params.summary,
				details: params.details,
				files: params.files,
				attempted: params.attempted,
				answerNeeded: params.answerNeeded,
				recommendedNextAction: params.recommendedNextAction,
				taskStatus: params.taskStatus,
				waitingOn: params.waitingOn,
				blockedReason: params.blockedReason,
				taskSummary: params.taskSummary,
				acceptanceCriteria: params.acceptanceCriteria,
				planSteps: params.planSteps,
				validationSteps: params.validationSteps,
				reviewSummary: params.reviewSummary,
				finalSummary: params.finalSummary,
			};
			const nextState =
				params.kind === "blocked"
					? "blocked"
					: params.kind === "question" || params.kind === "question_for_user"
						? "waiting"
						: params.kind === "complete"
							? "done"
							: "running";
			const publishResult = publishChildUpdate(environment, params.kind, payload, nextState);
			const parentDelivery = publishResult.recipient.kind === "agent" ? await deliverQueuedParentMessagesViaBridge(publishResult.recipient.agentId) : null;
			const readReceiptStatus = parentDelivery?.v2AckedMessageIds.includes(publishResult.messageId) ? "acked" : "queued";
			const deliveryText = parentDelivery
				? parentDelivery.delivered > 0
					? `; delivered ${parentDelivery.delivered} parent message${parentDelivery.delivered === 1 ? "" : "s"} via RPC bridge`
					: parentDelivery.attempted
						? `; parent live delivery deferred (${parentDelivery.error ?? parentDelivery.reason ?? parentDelivery.transportState})`
						: `; queued for parent inbox/poll-fallback (${parentDelivery.reason ?? "pending"})`
				: "";
			const clearLastErrorWhenResolvingBlock =
				(params.kind === "milestone" || params.kind === "note" || params.kind === "complete") &&
				(statusSnapshot.state === "blocked" || !!statusSnapshot.lastError);
			statusSnapshot = updateStatus(
				environment,
				ctx,
				{
					state: nextState,
					lastAssistantPreview: truncateText(params.summary, 400),
					lastError: params.kind === "blocked" ? params.summary : clearLastErrorWhenResolvingBlock ? null : statusSnapshot.lastError ?? null,
					finalSummary: params.kind === "complete" ? params.summary : statusSnapshot.finalSummary,
					finishedAt: params.kind === "complete" ? Date.now() : statusSnapshot.finishedAt,
					transportKind: environment.transportKind,
					transportState: resolvedMode.transportState,
					downwardDeliveryMode: resolvedMode.mode,
				},
				statusSnapshot,
			);
			if (params.kind === "complete") completePublished = true;
			return {
				content: [{ type: "text", text: `Published ${params.kind} from agent:${environment.childId} to ${recipientLabel(publishResult.recipient)} via ${publishResult.routeKind}${deliveryText}: ${params.summary}` }],
				details: {
					kind: params.kind,
					childId: environment.childId,
					sender: { kind: "agent", agentId: environment.childId },
					recipient: publishResult.recipient,
					messageId: publishResult.messageId,
					routeKind: publishResult.routeKind,
					readReceipt: { status: readReceiptStatus, recipientRowIds: publishResult.recipientRowIds },
					legacyMessageIds: publishResult.legacyMessageIds,
					parentDelivery,
				},
			};
		},
	});

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: applyNoWaitSystemPrompt(event.systemPrompt, noWaitMode),
	}));

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = getBashCommandFromToolInput(event.input);
		if (!command) return;
		const reason = noWaitBashBlockReason(command, noWaitMode);
		if (!reason) return;
		const violation = classifyNoWaitBashCommand(command);
		createAgentEvent(getMeepoDb(), {
			id: randomUUID(),
			agentId: environment.childId,
			eventType: "policy_blocked_wait_command",
			summary: violation?.reason ?? "no-wait policy blocked bash command",
			payload: { kind: violation?.kind ?? "sleep", command, mode: noWaitMode },
		});
		appendRunEvent(environment, "policy_blocked_wait_command", violation?.reason ?? reason, {
			kind: violation?.kind ?? "sleep",
			command,
			mode: noWaitMode,
		});
		return { block: true, reason };
	});

	pi.on("session_start", async (_event, ctx) => {
		const activeTools = [...environment.allowedTools, "subagent_publish"];
		pi.setActiveTools(activeTools);
		const resolvedMode = resolveDownwardDeliveryMode(environment);
		downwardDeliveryMode = resolvedMode.mode;
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				state: "launching",
				transportKind: environment.transportKind,
				transportState: resolvedMode.transportState,
				downwardDeliveryMode: resolvedMode.mode,
				updatedAt: Date.now(),
			},
			statusSnapshot,
		);
		ctx.ui.setStatus("meepo-child", ctx.ui.theme.fg("accent", `child:${environment.childId}`));
		if (downwardPoll) clearInterval(downwardPoll);
		downwardPoll = setInterval(() => {
			void maybeDrainDownwardMessages(ctx);
		}, DOWNWARD_MESSAGE_POLL_MS);
		await maybeDrainDownwardMessages(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		const resolvedMode = resolveDownwardDeliveryMode(environment);
		ackPendingPollFallbackDeliveries();
		if (startedPublished) return;
		startedPublished = true;
		createAgentEvent(getMeepoDb(), {
			id: randomUUID(),
			agentId: environment.childId,
			eventType: "started",
			summary: `Child ${environment.childId} started work`,
			payload: { profile: environment.profile },
		});
		appendRunEvent(environment, "started", `Child ${environment.childId} started work`, { profile: environment.profile });
		// Don't clobber a publish-owned state (blocked/waiting/done) or bridge-terminal state.
		const nextState =
			CHILD_SELF_OWNED_STATES.has(statusSnapshot.state) || CHILD_LOCAL_TERMINAL_STATES.has(statusSnapshot.state)
				? statusSnapshot.state
				: "running";
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				state: nextState,
				transportKind: environment.transportKind,
				transportState: resolvedMode.transportState,
				downwardDeliveryMode: resolvedMode.mode,
			},
			statusSnapshot,
		);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		const resolvedMode = resolveDownwardDeliveryMode(environment);
		// Preserve self-owned states (blocked/waiting/done) so a tool call after a published
		// blocker/question doesn't auto-regress the agent back to `running`.
		const nextState =
			CHILD_SELF_OWNED_STATES.has(statusSnapshot.state) || CHILD_LOCAL_TERMINAL_STATES.has(statusSnapshot.state)
				? statusSnapshot.state
				: "running";
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				state: nextState,
				lastToolName: event.toolName,
				transportKind: environment.transportKind,
				transportState: resolvedMode.transportState,
				downwardDeliveryMode: resolvedMode.mode,
			},
			statusSnapshot,
		);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as AgentMessage;
		if (!isAssistantMessage(message)) return;
		const text = getAssistantText(message);
		if (!text) return;
		const resolvedMode = resolveDownwardDeliveryMode(environment);
		// Preserve self-owned and terminal states; don't flip blocked/waiting/done back.
		const nextState =
			CHILD_SELF_OWNED_STATES.has(statusSnapshot.state) || CHILD_LOCAL_TERMINAL_STATES.has(statusSnapshot.state)
				? statusSnapshot.state
				: statusSnapshot.state === "launching"
					? "running"
					: statusSnapshot.state;
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				lastAssistantPreview: truncateText(text, 400),
				state: nextState,
				transportKind: environment.transportKind,
				transportState: resolvedMode.transportState,
				downwardDeliveryMode: resolvedMode.mode,
			},
			statusSnapshot,
		);
	});

	pi.on("agent_end", async (event, ctx) => {
		const lastAssistant = [...event.messages].reverse().find((message) => isAssistantMessage(message as AgentMessage)) as
			| AssistantMessage
			| undefined;
		const finalText = getAssistantText(lastAssistant);
		if (lastAssistant?.stopReason === "error") {
			const errorSummary = truncateText(lastAssistant.errorMessage || finalText || "Subagent exited with an error.", 400);
			createAgentEvent(getMeepoDb(), {
				id: randomUUID(),
				agentId: environment.childId,
				eventType: "error",
				summary: errorSummary,
				payload: { errorMessage: lastAssistant.errorMessage ?? null },
			});
			appendRunEvent(environment, "error", errorSummary, { errorMessage: lastAssistant.errorMessage ?? null });
			const resolvedMode = resolveDownwardDeliveryMode(environment);
			statusSnapshot = updateStatus(
				environment,
				ctx,
				{
					state: "error",
					lastError: errorSummary,
					finishedAt: Date.now(),
					transportKind: environment.transportKind,
					transportState: resolvedMode.transportState === "live" ? "error" : resolvedMode.transportState,
					downwardDeliveryMode: resolvedMode.mode,
				},
				statusSnapshot,
			);
			return;
		}
		if (completePublished) return;
		if (statusSnapshot.state === "blocked" || statusSnapshot.state === "waiting") return;
		const completionSummary = truncateText(finalText || statusSnapshot.lastAssistantPreview || "Task completed.", 400);
		const publishResult = publishChildUpdate(
			environment,
			"complete",
			{
				summary: completionSummary,
				details: finalText || undefined,
				recommendedNextAction: "Review the child summary and decide whether more delegation is needed.",
			},
			"done",
		);
		if (publishResult.recipient.kind === "agent") {
			await deliverQueuedParentMessagesViaBridge(publishResult.recipient.agentId);
		}
		completePublished = true;
		const resolvedMode = resolveDownwardDeliveryMode(environment);
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				state: "done",
				finalSummary: completionSummary,
				finishedAt: Date.now(),
				transportKind: environment.transportKind,
				transportState: resolvedMode.transportState,
				downwardDeliveryMode: resolvedMode.mode,
			},
			statusSnapshot,
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (downwardPoll) clearInterval(downwardPoll);
		downwardPoll = undefined;
		if (pendingAckIds.size > 0 || pendingV2AckRecipientRowIds.size > 0 || pendingV2AckMessageIds.size > 0) {
			try {
				ackPendingPollFallbackDeliveries();
			} catch {
				// Best-effort: shutdown path must not throw.
			}
			pendingAckIds.clear();
			pendingV2AckRecipientRowIds.clear();
			pendingV2AckMessageIds.clear();
		}
		ctx.ui.setStatus("meepo-child", undefined);
	});
}
