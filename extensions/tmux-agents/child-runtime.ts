import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { getTmuxAgentsDb } from "./db.js";
import { getRpcBridgeSocketPath, readRpcBridgeStatus, sendRpcBridgeCommand } from "./rpc-client.js";
import {
	appendNoWaitPolicyToSystemPrompt,
	classifyNoWaitBashCommand,
	formatNoWaitPolicyViolation,
	getBashCommandFromToolInput,
} from "./no-wait-policy.js";
import { TASK_STATES, TASK_WAITING_ON_VALUES } from "./task-types.js";
import { applyChildPublishToLinkedTask } from "./task-registry.js";
import {
	createAgentAttentionItemV2,
	createAgentEvent,
	createAgentMessage,
	createAttentionItem,
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

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

function truncateText(value: string, maxLength = 400): string {
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function defaultDownwardActionPolicy(kind: AgentMessageRecord["kind"]): DownwardMessageActionPolicy {
	switch (kind) {
		case "answer":
			return "resume_if_blocked";
		case "redirect":
			return "interrupt_and_replan";
		case "cancel":
			return "stop";
		case "priority":
			return "replan";
		case "note":
		default:
			return "fyi";
	}
}

function expectedHandlingLines(actionPolicy: DownwardMessageActionPolicy): string[] {
	switch (actionPolicy) {
		case "resume_if_blocked":
			return [
				"If this resolves your current blocker or waiting state, resume work now.",
				"Publish a concise note once you resume so the coordinator can track progress without capture.",
				"If you are still blocked after this message, publish one concrete blocker or question immediately.",
			];
		case "replan":
			return [
				"Revise your plan before the next substantive tool call if this changes your priorities.",
				"Publish a concise note if the plan or file focus changes.",
			];
		case "interrupt_and_replan":
			return [
				"Stop the current approach and replan before more substantive work.",
				"Publish a concise note after adopting this redirect, with exact file paths when relevant.",
			];
		case "stop":
			return [
				"Stop current work gracefully.",
				"Publish a completion-style handoff or cancellation summary before exiting if possible.",
			];
		case "fyi":
		default:
			return [
				"Treat this as additional context. Continue unless it materially changes your plan.",
				"Publish a concise note only if this changes your course of action.",
			];
	}
}

function formatDownwardMessage(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
	const actionPolicy = payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind);
	const sender = payload.senderAgentId ?? message.senderAgentId ?? "root";
	const route = payload.routeKind ? ` · route ${payload.routeKind}` : "";
	const lines = [`[Hierarchy ${message.kind} · from ${sender} · action ${actionPolicy}${route}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.inReplyToMessageId) {
		lines.push("", `Replying to message: ${payload.inReplyToMessageId}`);
	}
	lines.push("", "Expected handling:");
	for (const line of expectedHandlingLines(actionPolicy)) {
		lines.push(`- ${line}`);
	}
	return lines.join("\n");
}

function getDeliveryOptions(message: AgentMessageRecord): { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean } {
	switch (message.deliveryMode) {
		case "follow_up":
			return { deliverAs: "followUp", triggerTurn: true };
		case "idle_only":
			return { deliverAs: "followUp" };
		case "steer":
		case "immediate":
		default:
			return { deliverAs: "steer", triggerTurn: true };
	}
}

interface ParentPublishDeliveryResult {
	attempted: boolean;
	delivered: number;
	deferred: number;
	transportState: AgentTransportState | "missing";
	legacyMessageIds: string[];
	v2AckedMessageIds: string[];
	error?: string;
	reason?: string;
}

function getV2Payload(message: AgentMessageRecord): DownwardMessagePayload | null {
	return message.payload && typeof message.payload === "object" ? (message.payload as DownwardMessagePayload) : null;
}

function markV2RecipientStatusForLegacyMessage(
	db: ReturnType<typeof getTmuxAgentsDb>,
	message: AgentMessageRecord,
	status: "read" | "acked",
	recipientAgentId: string,
	transportKind: "rpc_bridge" | "poll_fallback",
): string | null {
	const payload = getV2Payload(message);
	if (payload?.v2RecipientRowId) {
		markAgentMessageRecipientsByIds(db, [payload.v2RecipientRowId], status, { recipientAgentId, transportKind });
		return payload.v2MessageId ?? null;
	}
	if (payload?.v2MessageId) {
		markAgentMessageRecipientsByMessageIds(db, [payload.v2MessageId], status, { recipientAgentId, transportKind });
		return payload.v2MessageId;
	}
	return null;
}

async function deliverQueuedParentMessagesViaBridge(parentAgentId: string): Promise<ParentPublishDeliveryResult> {
	const db = getTmuxAgentsDb();
	const queued = listMessagesForRecipient(db, parentAgentId, { targetKind: "child", limit: 50 });
	const legacyMessageIds = queued.map((message) => message.id);
	const parent = getAgent(db, parentAgentId);
	if (!parent) {
		return { attempted: false, delivered: 0, deferred: queued.length, transportState: "missing", legacyMessageIds, v2AckedMessageIds: [], reason: "Parent agent was not found." };
	}
	if (queued.length === 0) {
		return { attempted: false, delivered: 0, deferred: 0, transportState: parent.transportState, legacyMessageIds, v2AckedMessageIds: [] };
	}
	if (parent.transportKind !== "rpc_bridge") {
		return {
			attempted: false,
			delivered: 0,
			deferred: queued.length,
			transportState: parent.transportState,
			legacyMessageIds,
			v2AckedMessageIds: [],
			reason: "parent agent is using poll-fallback delivery",
		};
	}
	const socketPath = getRpcBridgeSocketPath(parent);
	if (!socketPath) {
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "fallback",
			bridgeUpdatedAt: now,
			bridgeLastError: "RPC bridge socket is unavailable for parent-routed publish delivery.",
			updatedAt: now,
		});
		createAgentEvent(db, {
			id: randomUUID(),
			agentId: parent.id,
			eventType: "parent_publish_live_deferred",
			summary: "RPC bridge socket is unavailable for parent-routed publish delivery.",
			payload: { queued: queued.length, legacyMessageIds },
		});
		return {
			attempted: true,
			delivered: 0,
			deferred: queued.length,
			transportState: "fallback",
			legacyMessageIds,
			v2AckedMessageIds: [],
			reason: "RPC bridge socket is unavailable.",
		};
	}

	let isStreaming = false;
	let stateProbeError: string | null = null;
	try {
		const stateResponse = await sendRpcBridgeCommand(socketPath, { command: "get_state" }, 2500);
		if (stateResponse.success && stateResponse.data && typeof stateResponse.data === "object") {
			isStreaming = Boolean((stateResponse.data as { isStreaming?: boolean }).isStreaming);
		}
	} catch (error) {
		stateProbeError = error instanceof Error ? error.message : String(error);
		isStreaming = true;
	}

	let delivered = 0;
	const v2AckedMessageIds: string[] = [];
	try {
		for (const message of queued) {
			const formatted = formatDownwardMessage(message);
			const bridgeCommand = !isStreaming
				? { command: "prompt" as const, message: formatted }
				: message.deliveryMode === "follow_up" || message.deliveryMode === "idle_only"
					? { command: "follow_up" as const, message: formatted }
					: { command: "steer" as const, message: formatted };
			const response = await sendRpcBridgeCommand(socketPath, bridgeCommand, 5000);
			if (!response.success) throw new Error(response.error ?? `RPC bridge rejected ${message.kind}.`);
			markAgentMessages(db, [message.id], "delivered");
			markAgentMessages(db, [message.id], "acked");
			const ackedV2MessageId = markV2RecipientStatusForLegacyMessage(db, message, "acked", parent.id, "rpc_bridge");
			if (ackedV2MessageId) v2AckedMessageIds.push(ackedV2MessageId);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: parent.id,
				eventType: "parent_publish_live_delivered",
				summary: getV2Payload(message)?.summary ?? `${message.kind} delivered via RPC bridge`,
				payload: { messageId: message.id, v2MessageId: ackedV2MessageId, bridgeCommand: bridgeCommand.command, deliveryMode: message.deliveryMode },
			});
			delivered += 1;
			isStreaming = true;
		}
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "live",
			bridgeSocketPath: socketPath,
			bridgeConnectedAt: now,
			bridgeUpdatedAt: now,
			bridgeLastError: stateProbeError,
			updatedAt: now,
		});
		return { attempted: true, delivered, deferred: Math.max(0, queued.length - delivered), transportState: "live", legacyMessageIds, v2AckedMessageIds };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "fallback",
			bridgeUpdatedAt: now,
			bridgeLastError: message,
			updatedAt: now,
		});
		createAgentEvent(db, {
			id: randomUUID(),
			agentId: parent.id,
			eventType: "parent_publish_live_deferred",
			summary: message,
			payload: { error: message, queued: Math.max(0, queued.length - delivered), delivered, legacyMessageIds },
		});
		return {
			attempted: true,
			delivered,
			deferred: Math.max(0, queued.length - delivered),
			transportState: "fallback",
			legacyMessageIds,
			v2AckedMessageIds,
			error: message,
		};
	}
}

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

function appendRunEvent(environment: ChildRuntimeEnvironment, eventType: string, summary: string, payload: unknown): void {
	appendFileSync(
		join(environment.runDir, "events.jsonl"),
		`${JSON.stringify({ id: randomUUID(), eventType, summary, payload, createdAt: Date.now() })}\n`,
	);
}

function readLatestStatusFromDisk(environment: ChildRuntimeEnvironment): RuntimeStatusSnapshot | null {
	const statusFile = join(environment.runDir, "latest-status.json");
	if (!existsSync(statusFile)) return null;
	try {
		const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as RuntimeStatusSnapshot) : null;
	} catch {
		return null;
	}
}

function writeLatestStatus(environment: ChildRuntimeEnvironment, snapshot: RuntimeStatusSnapshot): void {
	// Atomic temp-file + rename, matching rpc-bridge.mjs writeJson. Prevents readers
	// (bridge, parent) from observing partially-written JSON when the bridge and
	// child-runtime briefly contend on latest-status.json.
	const target = join(environment.runDir, "latest-status.json");
	const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	renameSync(tempPath, target);
}

function resolveDownwardDeliveryMode(environment: ChildRuntimeEnvironment): {
	mode: ChildDownwardDeliveryMode;
	transportState: AgentTransportState;
	reason: string | null;
} {
	if (environment.transportKind !== "rpc_bridge") {
		return { mode: "poll_fallback", transportState: "legacy", reason: null };
	}
	const bridgeStatus = readRpcBridgeStatus(environment.bridgeStatusFile ?? join(environment.runDir, "bridge-status.json"));
	if (!bridgeStatus) {
		return {
			mode: "poll_fallback",
			transportState: "fallback",
			reason: "bridge-status.json is unavailable inside the child runtime",
		};
	}
	if (Date.now() - bridgeStatus.updatedAt > BRIDGE_STATUS_STALE_MS) {
		return {
			mode: "poll_fallback",
			transportState: "fallback",
			reason: `bridge status is stale (${Date.now() - bridgeStatus.updatedAt}ms old)`,
		};
	}
	if (POLL_FALLBACK_TRANSPORT_STATES.has(bridgeStatus.transportState)) {
		return {
			mode: "poll_fallback",
			transportState: bridgeStatus.transportState,
			reason: bridgeStatus.lastError ?? `bridge transport state is ${bridgeStatus.transportState}`,
		};
	}
	return {
		mode: "rpc_bridge",
		transportState: bridgeStatus.transportState,
		reason: null,
	};
}

function attentionPriority(kind: SubagentPublishPayload["kind"]): number | null {
	switch (kind) {
		case "question_for_user":
			return 0;
		case "question":
			return 1;
		case "blocked":
			return 2;
		case "complete":
			return 3;
		default:
			return null;
	}
}

function publishThreadKind(kind: SubagentPublishPayload["kind"]): AgentThreadKind {
	switch (kind) {
		case "blocked":
			return "blocker";
		case "question":
		case "question_for_user":
			return "question";
		case "complete":
			return "handoff";
		case "milestone":
		case "note":
		default:
			return "task_update";
	}
}

function resolvePublishRecipient(db: ReturnType<typeof getTmuxAgentsDb>, environment: ChildRuntimeEnvironment, kind: SubagentPublishPayload["kind"]): AgentRecipientRef {
	if (kind === "question_for_user") return { kind: "user" };
	const parentEdge = listActiveAgentEdges(db, { childAgentId: environment.childId, edgeType: "reports_to", limit: 1 })[0] ?? null;
	if (parentEdge) return { kind: "agent", agentId: parentEdge.parentAgentId };
	return { kind: "root" };
}

function recipientLabel(recipient: AgentRecipientRef): string {
	return recipient.kind === "agent" ? `agent:${recipient.agentId}` : recipient.kind;
}

function legacyPublishTargetKind(kind: SubagentPublishPayload["kind"]): AgentMessageRecord["targetKind"] {
	return kind === "question_for_user" ? "user" : "primary";
}

function updateStatus(
	environment: ChildRuntimeEnvironment,
	_ctx: ExtensionContext,
	patch: Partial<RuntimeStatusSnapshot>,
	currentState: RuntimeStatusSnapshot,
): RuntimeStatusSnapshot {
	// Merge with whatever is on disk so we don't regress bridge-owned fields that were
	// written after our in-memory snapshot was last computed.
	const onDisk = environment.transportKind === "rpc_bridge" ? readLatestStatusFromDisk(environment) : null;
	const isBridgeTerminalOnDisk = !!onDisk && onDisk.source === "rpc_bridge" && BRIDGE_TERMINAL_STATES.has(onDisk.state);
	const now = Date.now();
	const updatedAt = patch.updatedAt ?? now;

	// If the bridge already recorded a terminal state, the child-runtime must not regress it
	// to running/launching or overwrite its error/finish metadata.
	if (isBridgeTerminalOnDisk && onDisk) {
		const preservedState: RuntimeStatusSnapshot = {
			...currentState,
			...onDisk,
			// Allow child-owned preview fields to update even after terminal bridge state.
			lastAssistantPreview: patch.lastAssistantPreview ?? onDisk.lastAssistantPreview ?? currentState.lastAssistantPreview ?? null,
			lastToolName: onDisk.lastToolName ?? null,
			source: onDisk.source ?? "rpc_bridge",
			transportKind: onDisk.transportKind ?? environment.transportKind,
			transportState: onDisk.transportState ?? currentState.transportState ?? null,
			downwardDeliveryMode: onDisk.downwardDeliveryMode ?? currentState.downwardDeliveryMode ?? null,
			updatedAt: Math.max(onDisk.updatedAt ?? 0, updatedAt),
		};
		writeLatestStatus(environment, preservedState);
		// Do not touch the DB state/terminal columns in this branch; reconcile will sync from disk.
		updateAgent(getTmuxAgentsDb(), environment.childId, {
			lastAssistantPreview: preservedState.lastAssistantPreview ?? null,
			updatedAt: preservedState.updatedAt,
		});
		return preservedState;
	}

	const nextState: RuntimeStatusSnapshot = {
		...currentState,
		...(onDisk ?? {}),
		...patch,
		source: patch.source ?? "child_runtime",
		transportKind: patch.transportKind ?? currentState.transportKind ?? environment.transportKind,
		transportState:
			patch.transportState ??
			currentState.transportState ??
			(environment.transportKind === "rpc_bridge" ? "launching" : "legacy"),
		downwardDeliveryMode:
			patch.downwardDeliveryMode ??
			currentState.downwardDeliveryMode ??
			(environment.transportKind === "rpc_bridge" ? "rpc_bridge" : "poll_fallback"),
		updatedAt,
	};
	writeLatestStatus(environment, nextState);
	updateAgent(getTmuxAgentsDb(), environment.childId, {
		state: nextState.state,
		transportKind: nextState.transportKind ?? undefined,
		transportState: nextState.transportState ?? undefined,
		bridgeUpdatedAt: nextState.transportKind === "rpc_bridge" ? nextState.updatedAt : undefined,
		lastToolName: nextState.lastToolName ?? null,
		lastAssistantPreview: nextState.lastAssistantPreview ?? null,
		lastError: nextState.lastError ?? null,
		finalSummary: nextState.finalSummary ?? null,
		updatedAt: nextState.updatedAt,
		finishedAt: nextState.finishedAt ?? null,
	});
	return nextState;
}

function publishChildUpdate(
	environment: ChildRuntimeEnvironment,
	kind: SubagentPublishPayload["kind"],
	payload: Omit<SubagentPublishPayload, "kind">,
	state: RuntimeStatusSnapshot["state"],
): {
	recipient: AgentRecipientRef;
	messageId: string;
	routeKind: string;
	recipientRowIds: string[];
	legacyMessageIds: string[];
} {
	const db = getTmuxAgentsDb();
	const fullPayload: SubagentPublishPayload = { kind, ...payload };
	const agent = getAgent(db, environment.childId);
	if (!agent) throw new Error(`Cannot publish from unknown child agent ${environment.childId}.`);
	const actor = resolveAgentActorContext(db, { currentAgentId: environment.childId });
	const recipient = resolvePublishRecipient(db, environment, kind);
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: environment.childId,
		eventType: kind,
		summary: payload.summary,
		payload: { ...fullPayload, recipient },
	});
	const priority = attentionPriority(kind);
	const deliveryMode = kind === "blocked" || kind === "question" || kind === "question_for_user" ? "immediate" : "follow_up";
	const messageResult = createMessageWithRecipients(db, {
		actor,
		recipients: [{ ...recipient, deliveryMode, transportKind: recipient.kind === "agent" ? "inbox" : null }],
		orgId: agent.orgId,
		projectKey: agent.projectKey,
		taskId: environment.taskId,
		subjectAgentId: environment.childId,
		kind,
		summary: payload.summary,
		bodyMarkdown: payload.details ?? null,
		payload: fullPayload,
		priority: priority ?? 3,
		requiresResponse: priority !== null,
		thread: { kind: publishThreadKind(kind), title: payload.summary },
	});
	const routeKind = messageResult.routes[0]?.routeKind ?? "multi_hop";
	const v2RecipientRowId = messageResult.recipients[0]?.id;
	const v2Payload: SubagentPublishPayload & DownwardMessagePayload = {
		...fullPayload,
		v2MessageId: messageResult.message.id,
		v2RecipientRowId,
		senderKind: "agent",
		senderAgentId: environment.childId,
		routeKind,
	};
	const legacyMessageIds: string[] = [];
	if (recipient.kind === "agent") {
		const routedMessageId = randomUUID();
		legacyMessageIds.push(routedMessageId);
		createAgentMessage(db, {
			id: routedMessageId,
			threadId: environment.childId,
			senderAgentId: environment.childId,
			recipientAgentId: recipient.agentId,
			targetKind: "child",
			kind,
			deliveryMode,
			payload: v2Payload,
			status: "queued",
		});
	} else {
		const legacyMessageId = randomUUID();
		legacyMessageIds.push(legacyMessageId);
		createAgentMessage(db, {
			id: legacyMessageId,
			threadId: environment.childId,
			senderAgentId: environment.childId,
			recipientAgentId: null,
			targetKind: legacyPublishTargetKind(kind),
			kind,
			deliveryMode,
			payload: v2Payload,
			status: "queued",
		});
	}
	if (priority !== null) {
		const attentionKind = kind as "question" | "question_for_user" | "blocked" | "complete";
		if (recipient.kind !== "agent") {
			const legacyMessageId = legacyMessageIds[0] ?? messageResult.message.id;
			createAttentionItem(db, {
				id: legacyMessageId,
				messageId: legacyMessageId,
				agentId: environment.childId,
				threadId: environment.childId,
				projectKey: agent.projectKey,
				spawnSessionId: environment.spawnSessionId,
				spawnSessionFile: environment.spawnSessionFile,
				audience: recipient.kind === "user" ? "user" : "coordinator",
				kind: attentionKind,
				priority,
				state: recipient.kind === "user" ? "waiting_on_user" : "waiting_on_coordinator",
				summary: payload.summary,
				payload: v2Payload,
			});
		}
		createAgentAttentionItemV2(db, {
			messageId: messageResult.message.id,
			recipientRowId: messageResult.recipients[0]?.id ?? null,
			orgId: messageResult.message.orgId,
			projectKey: agent.projectKey,
			taskId: environment.taskId,
			subjectAgentId: environment.childId,
			ownerKind: recipient.kind,
			ownerAgentId: recipient.kind === "agent" ? recipient.agentId : null,
			kind: attentionKind,
			priority,
			state: "waiting_on_owner",
			summary: payload.summary,
			payload: v2Payload,
		});
	}
	appendRunEvent(environment, kind, payload.summary, { ...v2Payload, recipient });
	const dbAgent = getAgent(db, environment.childId);
	const dbBridgeOwnedTerminal = !!dbAgent && BRIDGE_TERMINAL_STATES.has(dbAgent.state as RuntimeStatusSnapshot["state"]);
	// Also honor on-disk latest-status.json when the bridge (source === "rpc_bridge")
	// recorded a terminal state. DB reconciliation may lag briefly behind the disk write,
	// and the child-runtime must not regress a bridge-observed terminal state in either store.
	const onDiskStatus = readLatestStatusFromDisk(environment);
	const diskBridgeOwnedTerminal = !!onDiskStatus
		&& onDiskStatus.source === "rpc_bridge"
		&& BRIDGE_TERMINAL_STATES.has(onDiskStatus.state);
	const bridgeOwnedTerminal = dbBridgeOwnedTerminal || diskBridgeOwnedTerminal;
	const clearLastError = kind === "milestone" || kind === "note" || kind === "complete";
	updateAgent(db, environment.childId, {
		// Never regress a bridge-observed terminal state back to a non-terminal one.
		state: bridgeOwnedTerminal && !CHILD_LOCAL_TERMINAL_STATES.has(state) ? undefined : state,
		lastAssistantPreview: truncateText(payload.summary, 400),
		lastError: kind === "blocked" ? payload.summary : clearLastError ? null : undefined,
		finalSummary: kind === "complete" ? payload.summary : undefined,
		updatedAt: Date.now(),
		finishedAt: kind === "complete" ? Date.now() : undefined,
	});
	applyChildPublishToLinkedTask(db, {
		agentId: environment.childId,
		profile: environment.profile,
		kind,
		summary: payload.summary,
		details: payload.details,
		files: payload.files,
		taskStatus: payload.taskStatus,
		waitingOn: payload.waitingOn,
		blockedReason: payload.blockedReason,
		taskSummary: payload.taskSummary,
		acceptanceCriteria: payload.acceptanceCriteria,
		planSteps: payload.planSteps,
		validationSteps: payload.validationSteps,
		reviewSummary: payload.reviewSummary,
		finalSummary: payload.finalSummary,
	});
	return {
		recipient,
		messageId: messageResult.message.id,
		routeKind,
		recipientRowIds: messageResult.recipients.map((item) => item.id),
		legacyMessageIds,
	};
}

export function registerChildRuntime(pi: ExtensionAPI, environment: ChildRuntimeEnvironment): void {
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

	pi.registerMessageRenderer("tmux-agents-downward", (message, _options, theme) => {
		const lines = [`${theme.fg("accent", theme.bold("↓ coordinator"))} ${message.content}`];
		return new Text(lines.join("\n"), 0, 0);
	});

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
		createAgentEvent(getTmuxAgentsDb(), {
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
		const db = getTmuxAgentsDb();
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
		const db = getTmuxAgentsDb();
		const messages = listMessagesForRecipient(db, environment.childId, { targetKind: "child", limit: 25 });
		for (const message of messages) {
			try {
				pi.sendMessage(
					{
						customType: "tmux-agents-downward",
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
		description: "Publish milestone, blocker, question, or completion updates from this child session to the global tmux-agents registry.",
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
		systemPrompt: appendNoWaitPolicyToSystemPrompt(event.systemPrompt),
	}));

	pi.on("tool_call", (event) => {
		if (event.toolName !== "bash") return;
		const command = getBashCommandFromToolInput(event.input);
		if (!command) return;
		const violation = classifyNoWaitBashCommand(command);
		if (!violation) return;
		const reason = formatNoWaitPolicyViolation(violation);
		createAgentEvent(getTmuxAgentsDb(), {
			id: randomUUID(),
			agentId: environment.childId,
			eventType: "policy_blocked_wait_command",
			summary: violation.reason,
			payload: { kind: violation.kind, command },
		});
		appendRunEvent(environment, "policy_blocked_wait_command", violation.reason, { kind: violation.kind, command });
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
		ctx.ui.setStatus("tmux-agents-child", ctx.ui.theme.fg("accent", `child:${environment.childId}`));
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
		createAgentEvent(getTmuxAgentsDb(), {
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
			createAgentEvent(getTmuxAgentsDb(), {
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
		ctx.ui.setStatus("tmux-agents-child", undefined);
	});
}
