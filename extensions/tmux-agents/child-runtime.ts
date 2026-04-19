import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { randomUUID } from "node:crypto";
import { getTmuxAgentsDb } from "./db.js";
import {
	createAgentEvent,
	createAgentMessage,
	createAttentionItem,
	getAgent,
	listMessagesForRecipient,
	markAgentMessages,
	updateAgent,
} from "./registry.js";
import type { AgentMessageRecord, ChildRuntimeEnvironment, RuntimeStatusSnapshot, SubagentPublishPayload } from "./types.js";

const CHILD_PUBLISH_KIND = StringEnum(["milestone", "blocked", "question", "question_for_user", "note", "complete"] as const, {
	description: "Type of child-originated update to publish to the registry.",
});

const DOWNWARD_MESSAGE_POLL_MS = 2000;

const PublishParams = Type.Object({
	kind: CHILD_PUBLISH_KIND,
	summary: Type.String({ description: "Short summary for the update." }),
	details: Type.Optional(Type.String({ description: "Additional context or handoff details." })),
	files: Type.Optional(Type.Array(Type.String({ description: "Relevant file path" }), { maxItems: 100 })),
	attempted: Type.Optional(Type.String({ description: "What was attempted before getting blocked." })),
	answerNeeded: Type.Optional(Type.String({ description: "The exact answer or decision needed." })),
	recommendedNextAction: Type.Optional(Type.String({ description: "Suggested next step for the coordinator." })),
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

function formatDownwardMessage(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as {
		summary?: string;
		details?: string;
		files?: string[];
		attempted?: string;
		answerNeeded?: string;
		recommendedNextAction?: string;
	};
	const lines = [`[Coordinator ${message.kind}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.attempted) lines.push("", `Attempted: ${payload.attempted}`);
	if (payload.answerNeeded) lines.push("", `Answer needed: ${payload.answerNeeded}`);
	if (payload.recommendedNextAction) lines.push("", `Recommended next action: ${payload.recommendedNextAction}`);
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
		parentAgentId: process.env.PI_TMUX_AGENTS_PARENT_AGENT_ID?.trim() || null,
		spawnSessionId: process.env.PI_TMUX_AGENTS_SPAWN_SESSION_ID?.trim() || null,
		spawnSessionFile: process.env.PI_TMUX_AGENTS_SPAWN_SESSION_FILE?.trim() || null,
	};
}

function appendRunEvent(environment: ChildRuntimeEnvironment, eventType: string, summary: string, payload: unknown): void {
	appendFileSync(
		join(environment.runDir, "events.jsonl"),
		`${JSON.stringify({ id: randomUUID(), eventType, summary, payload, createdAt: Date.now() })}\n`,
	);
}

function writeLatestStatus(environment: ChildRuntimeEnvironment, snapshot: RuntimeStatusSnapshot): void {
	writeFileSync(join(environment.runDir, "latest-status.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
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

function updateStatus(
	environment: ChildRuntimeEnvironment,
	ctx: ExtensionContext,
	patch: Partial<RuntimeStatusSnapshot>,
	currentState: RuntimeStatusSnapshot,
): RuntimeStatusSnapshot {
	const nextState: RuntimeStatusSnapshot = {
		...currentState,
		...patch,
		updatedAt: patch.updatedAt ?? Date.now(),
	};
	writeLatestStatus(environment, nextState);
	updateAgent(getTmuxAgentsDb(), environment.childId, {
		state: nextState.state,
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
): void {
	const db = getTmuxAgentsDb();
	const fullPayload: SubagentPublishPayload = { kind, ...payload };
	const agent = getAgent(db, environment.childId);
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: environment.childId,
		eventType: kind,
		summary: payload.summary,
		payload: fullPayload,
	});
	const messageId = randomUUID();
	const targetKind = kind === "question_for_user" ? "user" : "primary";
	createAgentMessage(db, {
		id: messageId,
		threadId: environment.childId,
		senderAgentId: environment.childId,
		recipientAgentId: environment.parentAgentId,
		targetKind,
		kind,
		deliveryMode: kind === "blocked" || kind === "question" || kind === "question_for_user" ? "immediate" : "follow_up",
		payload: fullPayload,
		status: "queued",
	});
	const priority = attentionPriority(kind);
	if (priority !== null) {
		const attentionKind = kind as "question" | "question_for_user" | "blocked" | "complete";
		createAttentionItem(db, {
			id: messageId,
			messageId,
			agentId: environment.childId,
			threadId: environment.childId,
			projectKey: agent?.projectKey ?? "unknown",
			spawnSessionId: environment.spawnSessionId,
			spawnSessionFile: environment.spawnSessionFile,
			audience: targetKind === "user" ? "user" : "coordinator",
			kind: attentionKind,
			priority,
			state: kind === "question_for_user" ? "waiting_on_user" : "waiting_on_coordinator",
			summary: payload.summary,
			payload: fullPayload,
		});
	}
	appendRunEvent(environment, kind, payload.summary, fullPayload);
	updateAgent(db, environment.childId, {
		state,
		lastAssistantPreview: truncateText(payload.summary, 400),
		lastError: kind === "blocked" ? payload.summary : undefined,
		finalSummary: kind === "complete" ? payload.summary : undefined,
		updatedAt: Date.now(),
		finishedAt: kind === "complete" ? Date.now() : undefined,
	});
}

export function registerChildRuntime(pi: ExtensionAPI, environment: ChildRuntimeEnvironment): void {
	let startedPublished = false;
	let completePublished = false;
	let downwardPoll: ReturnType<typeof setInterval> | undefined;
	const pendingAckIds = new Set<string>();
	let statusSnapshot: RuntimeStatusSnapshot = {
		agentId: environment.childId,
		profile: environment.profile,
		state: "launching",
		updatedAt: Date.now(),
		lastToolName: null,
		lastAssistantPreview: null,
		lastError: null,
		finalSummary: null,
	};

	pi.registerMessageRenderer("tmux-agents-downward", (message, _options, theme) => {
		const lines = [`${theme.fg("accent", theme.bold("↓ coordinator"))} ${message.content}`];
		return new Text(lines.join("\n"), 0, 0);
	});

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
				pendingAckIds.add(message.id);
				appendRunEvent(environment, "downward_delivered", `Delivered ${message.kind}`, { messageId: message.id });
			} catch (error) {
				createAgentEvent(db, {
					id: randomUUID(),
					agentId: environment.childId,
					eventType: "downward_delivery_failed",
					summary: error instanceof Error ? error.message : String(error),
					payload: { messageId: message.id },
				});
			}
		}
	}

	pi.registerTool({
		name: "subagent_publish",
		label: "Subagent Publish",
		description: "Publish milestone, blocker, question, or completion updates from this child session to the global tmux-agents registry.",
		promptSnippet: "Publish milestone/blocker/question/complete updates upward to the coordinator registry.",
		promptGuidelines: [
			"Use subagent_publish proactively for milestones, blockers, concrete questions, and final completion handoffs.",
			"For blockers, include what you tried and the exact answer needed.",
			"For completion, include files changed/involved, blockers remaining, and a recommended next action.",
		],
		parameters: PublishParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const payload: Omit<SubagentPublishPayload, "kind"> = {
				summary: params.summary,
				details: params.details,
				files: params.files,
				attempted: params.attempted,
				answerNeeded: params.answerNeeded,
				recommendedNextAction: params.recommendedNextAction,
			};
			const nextState =
				params.kind === "blocked"
					? "blocked"
					: params.kind === "question" || params.kind === "question_for_user"
						? "waiting"
						: params.kind === "complete"
							? "done"
							: "running";
			publishChildUpdate(environment, params.kind, payload, nextState);
			statusSnapshot = updateStatus(
				environment,
				ctx,
				{
					state: nextState,
					lastAssistantPreview: truncateText(params.summary, 400),
					lastError: params.kind === "blocked" ? params.summary : null,
					finalSummary: params.kind === "complete" ? params.summary : statusSnapshot.finalSummary,
					finishedAt: params.kind === "complete" ? Date.now() : statusSnapshot.finishedAt,
				},
				statusSnapshot,
			);
			if (params.kind === "complete") completePublished = true;
			return {
				content: [{ type: "text", text: `Published ${params.kind}: ${params.summary}` }],
				details: { kind: params.kind, childId: environment.childId },
			};
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const activeTools = [...environment.allowedTools, "subagent_publish"];
		pi.setActiveTools(activeTools);
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				state: "launching",
				updatedAt: Date.now(),
			},
			statusSnapshot,
		);
		ctx.ui.setStatus("tmux-agents-child", ctx.ui.theme.fg("accent", `child:${environment.childId}`));
		if (downwardPoll) clearInterval(downwardPoll);
		downwardPoll = setInterval(() => {
			void drainDownwardMessages();
		}, DOWNWARD_MESSAGE_POLL_MS);
		await drainDownwardMessages();
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (pendingAckIds.size > 0) {
			markAgentMessages(getTmuxAgentsDb(), [...pendingAckIds], "acked");
			pendingAckIds.clear();
		}
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
		statusSnapshot = updateStatus(environment, ctx, { state: "running" }, statusSnapshot);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		statusSnapshot = updateStatus(environment, ctx, { state: "running", lastToolName: event.toolName }, statusSnapshot);
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as AgentMessage;
		if (!isAssistantMessage(message)) return;
		const text = getAssistantText(message);
		if (!text) return;
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{
				lastAssistantPreview: truncateText(text, 400),
				state: statusSnapshot.state === "launching" ? "running" : statusSnapshot.state,
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
			statusSnapshot = updateStatus(
				environment,
				ctx,
				{ state: "error", lastError: errorSummary, finishedAt: Date.now() },
				statusSnapshot,
			);
			return;
		}
		if (completePublished) return;
		if (statusSnapshot.state === "blocked" || statusSnapshot.state === "waiting") return;
		const completionSummary = truncateText(finalText || statusSnapshot.lastAssistantPreview || "Task completed.", 400);
		publishChildUpdate(
			environment,
			"complete",
			{
				summary: completionSummary,
				details: finalText || undefined,
				recommendedNextAction: "Review the child summary and decide whether more delegation is needed.",
			},
			"done",
		);
		completePublished = true;
		statusSnapshot = updateStatus(
			environment,
			ctx,
			{ state: "done", finalSummary: completionSummary, finishedAt: Date.now() },
			statusSnapshot,
		);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (downwardPoll) clearInterval(downwardPoll);
		downwardPoll = undefined;
		ctx.ui.setStatus("tmux-agents-child", undefined);
	});
}
