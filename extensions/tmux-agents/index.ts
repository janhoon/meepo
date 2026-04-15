import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { registerChildRuntime, getChildRuntimeEnvironment } from "./child-runtime.js";
import { openAgentsDashboard, type AgentsDashboardData, type AgentsDashboardState } from "./dashboard.js";
import { closeTmuxAgentsDb, getTmuxAgentsDb } from "./db.js";
import { SESSION_CHILD_LINK_ENTRY_TYPE } from "./paths.js";
import { getSubagentProfile, listSubagentProfiles, normalizeBuiltinTools } from "./profiles.js";
import { getProjectKey } from "./project.js";
import {
	createAgentEvent,
	createAgentMessage,
	getAgent,
	getFleetSummary,
	listAgents,
	listInboxMessages,
	updateAgent,
} from "./registry.js";
import { getService, listServices, updateService } from "./service-registry.js";
import { readServiceStatus, spawnService, tailFileLines } from "./service-spawn.js";
import { spawnSubagent } from "./spawn.js";
import { captureTmuxTarget, focusTmuxTarget, getTmuxInventory, stopTmuxTarget, tmuxTargetExists } from "./tmux.js";
import type {
	ListServicesFilters,
	ServiceStatusSnapshot,
	ServiceSummary,
	SpawnServiceResult,
	UpdateServiceInput,
} from "./service-types.js";
import type {
	AgentMessageRecord,
	AgentSummary,
	DeliveryMode,
	FleetSummary,
	ListAgentsFilters,
	RuntimeStatusSnapshot,
	SessionChildLinkEntryData,
	SpawnSubagentResult,
	SubagentProfile,
	UpdateAgentInput,
} from "./types.js";

const childRuntimeEnvironment = getChildRuntimeEnvironment();
let lastFocusedActiveAgentId: string | undefined;

const LIST_SCOPE = StringEnum(["all", "current_project", "current_session", "descendants"] as const, {
	description: "Which slice of the global registry to inspect.",
	default: "current_project",
});

const SubagentSpawnParams = Type.Object({
	title: Type.String({ description: "Short title for the child agent." }),
	task: Type.String({ description: "Task to delegate to the child agent." }),
	profile: Type.String({ description: "Agent profile name from ~/.pi/agent/agents/*.md." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child. Defaults to the current cwd." })),
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	tools: Type.Optional(
		Type.Array(Type.String({ description: "Built-in tool name" }), {
			description: "Optional built-in tool override. Allowed: read, bash, grep, ls, edit, write.",
			maxItems: 16,
		}),
	),
	parentAgentId: Type.Optional(Type.String({ description: "Optional parent child-agent id for hierarchical delegation." })),
	priority: Type.Optional(Type.String({ description: "Optional human-readable priority label." })),
});

const DOWNWARD_MESSAGE_KIND = StringEnum(["answer", "note", "redirect", "cancel", "priority"] as const, {
	description: "Structured downward message kind for a child agent.",
});

const DELIVERY_MODE = StringEnum(["immediate", "steer", "follow_up", "idle_only"] as const, {
	description: "Delivery preference for downward messages.",
	default: "immediate",
});

const SubagentFocusParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to focus in tmux." }),
});

const SubagentStopParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to stop." }),
	force: Type.Optional(Type.Boolean({ description: "Kill the tmux pane/window immediately instead of queueing a graceful cancel.", default: false })),
	reason: Type.Optional(Type.String({ description: "Optional reason shown to the child or event log." })),
});

const SubagentMessageParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to message." }),
	kind: DOWNWARD_MESSAGE_KIND,
	summary: Type.String({ description: "Short message summary for the child." }),
	details: Type.Optional(Type.String({ description: "Additional context for the child." })),
	files: Type.Optional(Type.Array(Type.String({ description: "Relevant file path" }), { maxItems: 100 })),
	deliveryMode: Type.Optional(DELIVERY_MODE),
});

const SubagentCaptureParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to capture from tmux." }),
	lines: Type.Optional(Type.Integer({ description: "Number of trailing lines to capture from the tmux pane.", minimum: 1, maximum: 5000, default: 200 })),
});

const SubagentReconcileParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only reconcile active agents.", default: true })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to reconcile.", minimum: 1, maximum: 500, default: 100 })),
});

const SubagentListParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only include active agents.", default: false })),
	blockedOnly: Type.Optional(Type.Boolean({ description: "Only include blocked agents.", default: false })),
	unreadOnly: Type.Optional(Type.Boolean({ description: "Only include agents with unread child-originated mail.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to return.", minimum: 1, maximum: 200, default: 50 })),
});

const SubagentGetParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Agent id" }), {
		description: "One or more agent ids to inspect.",
		minItems: 1,
		maxItems: 50,
	}),
});

const SubagentInboxParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of messages to return.", minimum: 1, maximum: 500, default: 100 })),
	includeDelivered: Type.Optional(
		Type.Boolean({ description: "Include messages already marked delivered/acked.", default: false }),
	),
});

const SERVICE_SCOPE = StringEnum(["all", "current_project", "current_session"] as const, {
	description: "Which slice of tracked tmux services to inspect.",
	default: "current_project",
});

const TmuxServiceStartParams = Type.Object({
	title: Type.String({ description: "Short title for the tmux service window." }),
	command: Type.String({ description: "Shell command to run inside the tmux window." }),
	cwd: Type.Optional(Type.String({ description: "Working directory for the command. Defaults to the current cwd." })),
	env: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Optional environment variables to export before the command runs.",
		}),
	),
	readySubstring: Type.Optional(
		Type.String({ description: "Optional output substring that indicates the service is ready for use." }),
	),
	readyTimeoutSec: Type.Optional(
		Type.Integer({
			description: "How long to wait for readySubstring before returning.",
			minimum: 1,
			maximum: 600,
			default: 20,
		}),
	),
});

const TmuxServiceListParams = Type.Object({
	scope: Type.Optional(SERVICE_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only include active services.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of services to return.", minimum: 1, maximum: 200, default: 50 })),
});

const TmuxServiceGetParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Tracked service id" }), {
		description: "One or more tracked tmux service ids to inspect.",
		minItems: 1,
		maxItems: 50,
	}),
});

const TmuxServiceFocusParams = Type.Object({
	id: Type.String({ description: "Tracked service id to focus in tmux." }),
});

const TmuxServiceStopParams = Type.Object({
	id: Type.String({ description: "Tracked service id to stop." }),
	force: Type.Optional(Type.Boolean({ description: "Kill the tmux pane/window immediately instead of sending Ctrl+C.", default: false })),
	reason: Type.Optional(Type.String({ description: "Optional reason shown in the result text." })),
});

const TmuxServiceCaptureParams = Type.Object({
	id: Type.String({ description: "Tracked service id to capture logs from." }),
	lines: Type.Optional(Type.Integer({ description: "Number of trailing lines to capture.", minimum: 1, maximum: 5000, default: 200 })),
});

const TmuxServiceReconcileParams = Type.Object({
	scope: Type.Optional(SERVICE_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only reconcile active services.", default: true })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of services to reconcile.", minimum: 1, maximum: 500, default: 100 })),
});

function truncateText(value: string | null | undefined, maxLength = 90): string {
	if (!value) return "";
	const singleLine = value.replace(/\s+/g, " ").trim();
	if (singleLine.length <= maxLength) return singleLine;
	return `${singleLine.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function resolveInputPath(baseDir: string, rawPath: string | undefined): string {
	const normalized = (rawPath ?? baseDir).replace(/^@/, "");
	return resolve(baseDir, normalized);
}

function assertDirectory(path: string): void {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		throw new Error(`Working directory does not exist: ${path}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Working directory is not a directory: ${path}`);
	}
}

function stateIcon(state: AgentSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "idle":
		case "waiting":
			return "◌";
		case "blocked":
			return "⛔";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "stopped":
			return "■";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

function messageKindLabel(message: AgentMessageRecord | null): string {
	if (!message) return "";
	switch (message.kind) {
		case "question_for_user":
			return "user question";
		case "question":
			return "question";
		case "blocked":
			return "blocker";
		case "milestone":
			return "milestone";
		case "complete":
			return "complete";
		default:
			return message.kind;
	}
}

function formatAgentLine(agent: AgentSummary): string {
	const parts = [`${stateIcon(agent.state)} ${agent.id}`, `${agent.profile}`, truncateText(agent.title, 40)];
	if (agent.unreadCount > 0) {
		parts.push(`${agent.unreadCount} unread`);
	}
	if (agent.latestUnreadMessage) {
		parts.push(messageKindLabel(agent.latestUnreadMessage));
	}
	return parts.join(" · ");
}

function formatAgentDetails(agent: AgentSummary): string {
	const lines = [
		`id: ${agent.id}`,
		`state: ${agent.state}`,
		`profile: ${agent.profile}`,
		`title: ${agent.title}`,
		`task: ${agent.task}`,
		`projectKey: ${agent.projectKey}`,
		`spawnCwd: ${agent.spawnCwd}`,
		`spawnSessionId: ${agent.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${agent.spawnSessionFile ?? "-"}`,
		`model: ${agent.model ?? "-"}`,
		`runDir: ${agent.runDir}`,
		`sessionFile: ${agent.sessionFile}`,
		`tmuxSessionId: ${agent.tmuxSessionId ?? "-"}`,
		`tmuxSessionName: ${agent.tmuxSessionName ?? "-"}`,
		`tmuxWindowId: ${agent.tmuxWindowId ?? "-"}`,
		`tmuxPaneId: ${agent.tmuxPaneId ?? "-"}`,
		`lastToolName: ${agent.lastToolName ?? "-"}`,
		`lastAssistantPreview: ${agent.lastAssistantPreview ?? "-"}`,
		`lastError: ${agent.lastError ?? "-"}`,
		`finalSummary: ${agent.finalSummary ?? "-"}`,
		`unreadCount: ${agent.unreadCount}`,
		`createdAt: ${new Date(agent.createdAt).toISOString()}`,
		`updatedAt: ${new Date(agent.updatedAt).toISOString()}`,
		`finishedAt: ${agent.finishedAt ? new Date(agent.finishedAt).toISOString() : "-"}`,
	];
	if (agent.latestUnreadMessage) {
		lines.push("");
		lines.push("latestUnreadMessage:");
		lines.push(JSON.stringify(agent.latestUnreadMessage, null, 2));
	}
	if (agent.tools !== null) {
		lines.push("");
		lines.push("tools:");
		lines.push(JSON.stringify(agent.tools, null, 2));
	}
	return lines.join("\n");
}

function summarizeFilters(scope: string, filters: ListAgentsFilters): string {
	const parts = [scope];
	if (filters.activeOnly) parts.push("active-only");
	if (filters.blockedOnly) parts.push("blocked-only");
	if (filters.unreadOnly) parts.push("unread-only");
	return parts.join(", ");
}

function getLinkedChildIds(ctx: ExtensionContext): string[] {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries() as Array<
		{ type?: string; customType?: string; data?: SessionChildLinkEntryData | undefined }
	>) {
		if (entry.type !== "custom" || entry.customType !== SESSION_CHILD_LINK_ENTRY_TYPE) continue;
		const childId = entry.data?.childId;
		if (typeof childId === "string" && childId.length > 0) {
			ids.add(childId);
		}
	}
	return [...ids];
}

function resolveAgentFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { activeOnly?: boolean; blockedOnly?: boolean; unreadOnly?: boolean; limit?: number },
): ListAgentsFilters {
	const filters: ListAgentsFilters = {
		activeOnly: params.activeOnly,
		blockedOnly: params.blockedOnly,
		unreadOnly: params.unreadOnly,
		limit: params.limit,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants":
			filters.descendantOf = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

function formatFleetSummary(summary: FleetSummary): string | undefined {
	if (summary.active === 0 && summary.blocked === 0 && summary.userQuestions === 0 && summary.unread === 0) {
		return undefined;
	}
	const userQuestionLabel = summary.userQuestions === 1 ? "user question" : "user questions";
	return `🤖 ${summary.active} active · ${summary.blocked} blocked · ${summary.userQuestions} ${userQuestionLabel} · ${summary.unread} unread`;
}

function pickAttentionAgents(agents: AgentSummary[]): AgentSummary[] {
	return [...agents]
		.sort((left, right) => {
			const leftPriority =
				left.latestUnreadMessage?.kind === "question_for_user"
					? 0
					: left.latestUnreadMessage?.kind === "question"
						? 1
						: left.state === "blocked"
							? 2
							: left.latestUnreadMessage?.kind === "complete"
								? 3
								: left.unreadCount > 0
									? 4
									: 5;
			const rightPriority =
				right.latestUnreadMessage?.kind === "question_for_user"
					? 0
					: right.latestUnreadMessage?.kind === "question"
						? 1
						: right.state === "blocked"
							? 2
							: right.latestUnreadMessage?.kind === "complete"
								? 3
								: right.unreadCount > 0
									? 4
									: 5;
			if (leftPriority !== rightPriority) return leftPriority - rightPriority;
			return right.updatedAt - left.updatedAt;
		})
		.filter((agent) => agent.state === "blocked" || agent.unreadCount > 0)
		.slice(0, 4);
}

function updateFleetUi(ctx: ExtensionContext): void {
	const db = getTmuxAgentsDb();
	const summary = getFleetSummary(db);
	ctx.ui.setStatus("tmux-agents", formatFleetSummary(summary));
	const attentionAgents = pickAttentionAgents(listAgents(db, { unreadOnly: false, limit: 50 }));
	if (attentionAgents.length === 0) {
		ctx.ui.setWidget("tmux-agents", undefined);
		return;
	}
	const lines = attentionAgents.map((agent) => {
		const label = agent.latestUnreadMessage ? messageKindLabel(agent.latestUnreadMessage) : agent.state;
		return `${stateIcon(agent.state)} ${truncateText(agent.title, 40)} · ${label} · ${agent.id}`;
	});
	ctx.ui.setWidget("tmux-agents", lines);
}

function buildInboxText(messages: AgentMessageRecord[]): string {
	if (messages.length === 0) return "No unread child-originated messages.";
	return messages
		.map((message) => {
			const payloadText = truncateText(JSON.stringify(message.payload), 160);
			return `${message.id} · ${message.kind} · ${message.targetKind} · sender=${message.senderAgentId ?? "-"}\n${payloadText}`;
		})
		.join("\n\n");
}

function formatSpawnSuccess(result: SpawnSubagentResult): string {
	return [
		`Spawned ${result.agentId} (${result.profile})`,
		"",
		`title: ${result.title}`,
		`cwd: ${result.spawnCwd}`,
		`runDir: ${result.runDir}`,
		`sessionFile: ${result.sessionFile}`,
		`tmuxSession: ${result.tmuxSessionName} ${result.tmuxSessionId}`,
		`tmuxWindow: ${result.tmuxWindowId}`,
		`tmuxPane: ${result.tmuxPaneId}`,
	].join("\n");
}

function formatFocusResult(agent: AgentSummary, result: { focused: boolean; command: string; reason?: string }): string {
	return [
		result.focused
			? `Focused ${agent.id} in tmux.`
			: `Could not switch the current pi client automatically for ${agent.id}.`,
		result.reason ? `reason: ${result.reason}` : null,
		`tmuxSession: ${agent.tmuxSessionName ?? agent.tmuxSessionId ?? "-"}`,
		`tmuxWindow: ${agent.tmuxWindowId ?? "-"}`,
		`tmuxPane: ${agent.tmuxPaneId ?? "-"}`,
		`manual command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function readLatestStatus(agent: AgentSummary): RuntimeStatusSnapshot | null {
	const statusFile = resolve(agent.runDir, "latest-status.json");
	if (!existsSync(statusFile)) return null;
	try {
		return JSON.parse(readFileSync(statusFile, "utf8")) as RuntimeStatusSnapshot;
	} catch {
		return null;
	}
}

function queueDownwardMessage(
	agent: AgentSummary,
	kind: "answer" | "note" | "redirect" | "cancel" | "priority",
	payload: { summary: string; details?: string; files?: string[] },
	deliveryMode: DeliveryMode,
): void {
	const db = getTmuxAgentsDb();
	createAgentMessage(db, {
		id: randomUUID(),
		threadId: agent.id,
		senderAgentId: null,
		recipientAgentId: agent.id,
		targetKind: "child",
		kind,
		deliveryMode,
		payload,
		status: "queued",
	});
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: `downward_${kind}`,
		summary: payload.summary,
		payload: { deliveryMode, ...payload },
	});
	updateAgent(db, agent.id, { updatedAt: Date.now() });
}

function formatStopResult(
	agent: AgentSummary,
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string },
	force: boolean,
): string {
	return [
		force ? `Force stop issued for ${agent.id}.` : `Stop requested for ${agent.id}.`,
		`mode: ${force ? "force" : result.graceful ? "graceful" : "graceful-request"}`,
		result.reason ? `reason: ${result.reason}` : null,
		`tmux command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function stopAgentById(id: string, force: boolean, reason?: string): {
	agent: AgentSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
} {
	const agent = getAgent(getTmuxAgentsDb(), id);
	if (!agent) {
		throw new Error(`Unknown agent id \"${id}\".`);
	}
	if (!force && ["done", "error", "stopped", "lost"].includes(agent.state)) {
		throw new Error(`Agent ${agent.id} is already in terminal state ${agent.state}.`);
	}
	const target = {
		sessionId: agent.tmuxSessionId,
		sessionName: agent.tmuxSessionName,
		windowId: agent.tmuxWindowId,
		paneId: agent.tmuxPaneId,
	};
	const targetExists = tmuxTargetExists(target, getTmuxInventory());
	if (!targetExists && force) {
		updateAgent(getTmuxAgentsDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		createAgentEvent(getTmuxAgentsDb(), {
			id: randomUUID(),
			agentId: agent.id,
			eventType: "force_stopped",
			summary: reason?.trim() || "tmux target missing; registry marked stopped.",
			payload: { command: "(tmux target already missing)" },
		});
		return {
			agent: getAgent(getTmuxAgentsDb(), agent.id) ?? agent,
			result: {
				stopped: true,
				graceful: false,
				command: "(tmux target already missing)",
				reason: "tmux target was already gone; registry marked stopped.",
			},
		};
	}
	if (!targetExists && !force) {
		throw new Error(`Agent ${agent.id} no longer has a live tmux target. Use force stop or reconcile.`);
	}
	if (!force) {
		queueDownwardMessage(
			agent,
			"cancel",
			{
				summary: reason?.trim() || "Stop requested by coordinator.",
				details: reason?.trim() || "Please stop current work and provide a short completion or blocker handoff.",
			},
			"immediate",
		);
	}
	const result = stopTmuxTarget(target, force);
	if (force) {
		updateAgent(getTmuxAgentsDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		createAgentEvent(getTmuxAgentsDb(), {
			id: randomUUID(),
			agentId: agent.id,
			eventType: "force_stopped",
			summary: reason?.trim() || "Force stop issued by coordinator.",
			payload: { command: result.command },
		});
	}
	return { agent: getAgent(getTmuxAgentsDb(), agent.id) ?? agent, result };
}

function reconcileAgents(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session" | "descendants"; activeOnly?: boolean; limit?: number }): {
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
} {
	const scope = params.scope ?? "current_project";
	const filters = resolveAgentFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getTmuxAgentsDb();
	const agents = listAgents(db, filters);
	const inventory = getTmuxInventory();
	const changed: Array<{ id: string; state: string; reason: string }> = [];
	for (const agent of agents) {
		const latestStatus = readLatestStatus(agent);
		const targetExists = tmuxTargetExists(
			{
				sessionId: agent.tmuxSessionId,
				sessionName: agent.tmuxSessionName,
				windowId: agent.tmuxWindowId,
				paneId: agent.tmuxPaneId,
			},
			inventory,
		);
		let patch: UpdateAgentInput = {};
		let reason = "";
		if (latestStatus && latestStatus.updatedAt > agent.updatedAt) {
			patch = {
				...patch,
				state: latestStatus.state,
				updatedAt: latestStatus.updatedAt,
				finishedAt: latestStatus.finishedAt ?? agent.finishedAt,
				lastToolName: latestStatus.lastToolName,
				lastAssistantPreview: latestStatus.lastAssistantPreview,
				lastError: latestStatus.lastError,
				finalSummary: latestStatus.finalSummary,
			};
			reason = reason || "latest-status.json was newer than the registry";
		}
		if (!targetExists) {
			if (latestStatus && ["done", "error", "stopped"].includes(latestStatus.state)) {
				patch = {
					...patch,
					state: latestStatus.state,
					updatedAt: Date.now(),
					finishedAt: latestStatus.finishedAt ?? Date.now(),
				};
				reason = reason || "tmux target exited after terminal latest-status update";
			} else if (["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)) {
				patch = {
					...patch,
					state: "lost",
					updatedAt: Date.now(),
					lastError: agent.lastError ?? "tmux target missing during reconcile",
				};
				reason = reason || "tmux target missing during reconcile";
			}
		} else if (agent.state === "launching" && !latestStatus) {
			patch = {
				...patch,
				state: "running",
				updatedAt: Date.now(),
			};
			reason = reason || "tmux target exists and the child appears to be running";
		}
		if (Object.keys(patch).length > 0 && patch.state !== undefined) {
			updateAgent(db, agent.id, patch);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "reconciled",
				summary: reason,
				payload: { state: patch.state, targetExists },
			});
			changed.push({ id: agent.id, state: patch.state, reason });
		}
	}
	return { scope, reconciled: agents.length, changed };
}

function formatReconcileResult(result: { scope: string; reconciled: number; changed: Array<{ id: string; state: string; reason: string }> }): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} agents in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} agents in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · ${item.reason}`),
	].join("\n");
}

function resolveServiceFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session",
	params: { activeOnly?: boolean; limit?: number },
): ListServicesFilters {
	const filters: ListServicesFilters = {
		activeOnly: params.activeOnly,
		limit: params.limit,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

function serviceStateIcon(state: ServiceSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "stopped":
			return "■";
		case "error":
			return "✗";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

function summarizeServiceFilters(scope: string, filters: ListServicesFilters): string {
	const parts = [scope];
	if (filters.activeOnly) parts.push("active-only");
	return parts.join(", ");
}

function serviceReadyLabel(service: ServiceSummary): string | null {
	if (!service.readySubstring) return null;
	if (service.readyMatchedAt) return "ready";
	if (["stopped", "error", "lost"].includes(service.state)) return "not-ready";
	return "waiting-ready";
}

function formatServiceLine(service: ServiceSummary): string {
	const parts = [
		`${serviceStateIcon(service.state)} ${service.id}`,
		truncateText(service.title, 32),
		truncateText(service.command, 54),
	];
	const ready = serviceReadyLabel(service);
	if (ready) parts.push(ready);
	return parts.join(" · ");
}

function formatServiceDetails(service: ServiceSummary): string {
	const lines = [
		`id: ${service.id}`,
		`state: ${service.state}`,
		`title: ${service.title}`,
		`command: ${service.command}`,
		`projectKey: ${service.projectKey}`,
		`spawnCwd: ${service.spawnCwd}`,
		`spawnSessionId: ${service.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${service.spawnSessionFile ?? "-"}`,
		`readySubstring: ${service.readySubstring ?? "-"}`,
		`readyMatchedAt: ${service.readyMatchedAt ? new Date(service.readyMatchedAt).toISOString() : "-"}`,
		`runDir: ${service.runDir}`,
		`logFile: ${service.logFile}`,
		`latestStatusFile: ${service.latestStatusFile}`,
		`tmuxSessionId: ${service.tmuxSessionId ?? "-"}`,
		`tmuxSessionName: ${service.tmuxSessionName ?? "-"}`,
		`tmuxWindowId: ${service.tmuxWindowId ?? "-"}`,
		`tmuxPaneId: ${service.tmuxPaneId ?? "-"}`,
		`lastExitCode: ${service.lastExitCode ?? "-"}`,
		`lastError: ${service.lastError ?? "-"}`,
		`createdAt: ${new Date(service.createdAt).toISOString()}`,
		`updatedAt: ${new Date(service.updatedAt).toISOString()}`,
		`finishedAt: ${service.finishedAt ? new Date(service.finishedAt).toISOString() : "-"}`,
	];
	if (service.env && Object.keys(service.env).length > 0) {
		lines.push("");
		lines.push("env:");
		lines.push(JSON.stringify(service.env, null, 2));
	}
	return lines.join("\n");
}

function formatServiceStartResult(result: SpawnServiceResult): string {
	const readyText = result.readySubstring
		? result.readyMatched
			? `matched ${JSON.stringify(result.readySubstring)}`
			: result.readyTimedOut
				? `timed out waiting for ${JSON.stringify(result.readySubstring)}`
				: `did not match ${JSON.stringify(result.readySubstring)}`
		: "not requested";
	return [
		`Started ${result.serviceId}`,
		"",
		`title: ${result.title}`,
		`command: ${result.command}`,
		`cwd: ${result.spawnCwd}`,
		`state: ${result.state}`,
		`ready: ${readyText}`,
		`runDir: ${result.runDir}`,
		`logFile: ${result.logFile}`,
		`latestStatusFile: ${result.latestStatusFile}`,
		`tmuxSession: ${result.tmuxSessionName} ${result.tmuxSessionId}`,
		`tmuxWindow: ${result.tmuxWindowId}`,
		`tmuxPane: ${result.tmuxPaneId}`,
	].join("\n");
}

function formatServiceFocusResult(service: ServiceSummary, result: { focused: boolean; command: string; reason?: string }): string {
	return [
		result.focused
			? `Focused ${service.id} in tmux.`
			: `Could not switch the current pi client automatically for ${service.id}.`,
		result.reason ? `reason: ${result.reason}` : null,
		`tmuxSession: ${service.tmuxSessionName ?? service.tmuxSessionId ?? "-"}`,
		`tmuxWindow: ${service.tmuxWindowId ?? "-"}`,
		`tmuxPane: ${service.tmuxPaneId ?? "-"}`,
		`manual command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function formatServiceStopResult(
	service: ServiceSummary,
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string },
	force: boolean,
): string {
	return [
		force ? `Force stop issued for ${service.id}.` : `Stop requested for ${service.id}.`,
		`mode: ${force ? "force" : result.graceful ? "graceful" : "graceful-request"}`,
		result.reason ? `reason: ${result.reason}` : null,
		`tmux command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function readLatestServiceStatus(service: ServiceSummary): ServiceStatusSnapshot | null {
	return readServiceStatus(service.latestStatusFile);
}

function buildServicePatchFromStatus(service: ServiceSummary, status: ServiceStatusSnapshot): UpdateServiceInput {
	const nextState = status.state;
	const nextLastError =
		nextState === "error"
			? (status.lastError ??
				(typeof status.lastExitCode === "number" ? `Command exited with status ${status.lastExitCode}.` : service.lastError ?? "Service exited with an error."))
			: null;
	return {
		state: nextState,
		updatedAt: status.updatedAt,
		finishedAt: status.finishedAt ?? (nextState === "running" || nextState === "launching" ? null : service.finishedAt),
		lastExitCode: status.lastExitCode ?? (nextState === "running" ? null : service.lastExitCode),
		lastError: nextLastError,
	};
}

function maybeDetectServiceReady(service: ServiceSummary): number | null {
	if (!service.readySubstring || service.readyMatchedAt) return null;
	const output = tailFileLines(service.logFile, 4000);
	if (!output.includes(service.readySubstring)) return null;
	return Date.now();
}

async function spawnServiceFromParams(ctx: ExtensionContext, params: {
	title: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	readySubstring?: string;
	readyTimeoutSec?: number;
}): Promise<SpawnServiceResult> {
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	return spawnService({
		title: params.title,
		command: params.command,
		spawnCwd,
		env: params.env,
		readySubstring: params.readySubstring,
		readyTimeoutSec: params.readyTimeoutSec,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

function focusServiceById(id: string): { service: ServiceSummary; result: { focused: boolean; command: string; reason?: string } } {
	const service = getService(getTmuxAgentsDb(), id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const result = focusTmuxTarget({
		sessionId: service.tmuxSessionId,
		sessionName: service.tmuxSessionName,
		windowId: service.tmuxWindowId,
		paneId: service.tmuxPaneId,
	});
	return { service, result };
}

function captureServiceById(id: string, lines = 200): { service: ServiceSummary; content: string; command: string; source: "tmux" | "log" } {
	const db = getTmuxAgentsDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const target = {
		sessionId: service.tmuxSessionId,
		sessionName: service.tmuxSessionName,
		windowId: service.tmuxWindowId,
		paneId: service.tmuxPaneId,
	};
	if (tmuxTargetExists(target, getTmuxInventory())) {
		const result = captureTmuxTarget(target, lines);
		return { service, content: result.content, command: result.command, source: "tmux" };
	}
	const latestStatus = readLatestServiceStatus(service);
	if (latestStatus) {
		updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
	}
	const refreshed = getService(db, service.id) ?? service;
	return {
		service: refreshed,
		content: tailFileLines(refreshed.logFile, lines),
		command: `tail -n ${lines} ${refreshed.logFile}`,
		source: "log",
	};
}

function stopServiceById(id: string, force: boolean, reason?: string): {
	service: ServiceSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
} {
	const db = getTmuxAgentsDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const target = {
		sessionId: service.tmuxSessionId,
		sessionName: service.tmuxSessionName,
		windowId: service.tmuxWindowId,
		paneId: service.tmuxPaneId,
	};
	const targetExists = tmuxTargetExists(target, getTmuxInventory());
	if (!targetExists) {
		const latestStatus = readLatestServiceStatus(service);
		if (latestStatus) {
			updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: !force,
					command: "(tmux target already exited)",
					reason: "tmux target was already gone; registry refreshed from latest-status.json.",
				},
			};
		}
		if (force) {
			updateService(db, service.id, {
				state: "stopped",
				updatedAt: Date.now(),
				finishedAt: Date.now(),
				lastError: null,
			});
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: false,
					command: "(tmux target already missing)",
					reason: reason?.trim() || "tmux target was already gone; registry marked stopped.",
				},
			};
		}
		throw new Error(`Service ${service.id} no longer has a live tmux target. Use force=true or reconcile.`);
	}
	const result = stopTmuxTarget(target, force);
	if (force) {
		updateService(db, service.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: null,
		});
	}
	return { service: getService(db, service.id) ?? service, result };
}

function reconcileServices(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session"; activeOnly?: boolean; limit?: number }): {
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
} {
	const scope = params.scope ?? "current_project";
	const filters = resolveServiceFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getTmuxAgentsDb();
	const services = listServices(db, filters);
	const inventory = getTmuxInventory();
	const changed: Array<{ id: string; state: string; reason: string }> = [];
	for (const service of services) {
		const latestStatus = readLatestServiceStatus(service);
		const targetExists = tmuxTargetExists(
			{
				sessionId: service.tmuxSessionId,
				sessionName: service.tmuxSessionName,
				windowId: service.tmuxWindowId,
				paneId: service.tmuxPaneId,
			},
			inventory,
		);
		let patch: UpdateServiceInput = {};
		let reason = "";
		const readyMatchedAt = maybeDetectServiceReady(service);
		if (readyMatchedAt) {
			patch = { ...patch, readyMatchedAt };
			reason = reason || "ready substring observed in service output";
		}
		if (latestStatus && latestStatus.updatedAt > service.updatedAt) {
			patch = {
				...patch,
				...buildServicePatchFromStatus(service, latestStatus),
			};
			reason = reason || "latest-status.json was newer than the registry";
		}
		if (!targetExists) {
			if (latestStatus && ["stopped", "error"].includes(latestStatus.state)) {
				patch = {
					...patch,
					...buildServicePatchFromStatus(service, latestStatus),
				};
				reason = reason || "tmux target exited after terminal latest-status update";
			} else if (["launching", "running"].includes(service.state)) {
				patch = {
					...patch,
					state: "lost",
					updatedAt: Date.now(),
					lastError: service.lastError ?? "tmux target missing during reconcile",
				};
				reason = reason || "tmux target missing during reconcile";
			}
		} else if (service.state === "launching" && !latestStatus) {
			patch = {
				...patch,
				state: "running",
				updatedAt: Date.now(),
			};
			reason = reason || "tmux target exists and the service appears to be running";
		}
		if (Object.keys(patch).length > 0) {
			updateService(db, service.id, patch);
			changed.push({ id: service.id, state: patch.state ?? service.state, reason: reason || "service metadata refreshed" });
		}
	}
	return { scope, reconciled: services.length, changed };
}

function formatServiceReconcileResult(result: {
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
}): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} services in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} services in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · ${item.reason}`),
	].join("\n");
}

function requireProfile(profileName: string): SubagentProfile {
	const profile = getSubagentProfile(profileName);
	if (profile) return profile;
	const available = listSubagentProfiles().map((item) => item.name).join(", ") || "(none)";
	throw new Error(`Unknown subagent profile \"${profileName}\". Available profiles: ${available}`);
}

function spawnChildFromParams(pi: ExtensionAPI, ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	parentAgentId?: string;
	priority?: string;
}): SpawnSubagentResult {
	const profile = requireProfile(params.profile);
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	const tools = normalizeBuiltinTools(params.tools ?? profile.tools);
	const result = spawnSubagent({
		title: params.title,
		task: params.task,
		profile,
		spawnCwd,
		model: params.model?.trim() || profile.model,
		tools,
		priority: params.priority?.trim() || null,
		parentAgentId: params.parentAgentId?.trim() || null,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
	pi.appendEntry(SESSION_CHILD_LINK_ENTRY_TYPE, result.sessionLinkData);
	updateFleetUi(ctx);
	return result;
}

async function chooseProfile(ctx: ExtensionContext): Promise<SubagentProfile | null> {
	const profiles = listSubagentProfiles();
	if (profiles.length === 0) {
		ctx.ui.notify("No subagent profiles found under ~/.pi/agent/agents.", "warning");
		return null;
	}
	const items: SelectItem[] = profiles.map((profile) => ({
		value: profile.name,
		label: profile.name,
		description: profile.description,
	}));
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Spawn subagent")), 1, 0));
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (value) => theme.fg("accent", value),
			selectedText: (value) => theme.fg("accent", value),
			description: (value) => theme.fg("muted", value),
			scrollInfo: (value) => theme.fg("dim", value),
			noMatch: (value) => theme.fg("warning", value),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (!selected) return null;
	return profiles.find((profile) => profile.name === selected) ?? null;
}

function focusAgentById(id: string): { agent: AgentSummary; result: { focused: boolean; command: string; reason?: string } } {
	const agent = getAgent(getTmuxAgentsDb(), id);
	if (!agent) {
		throw new Error(`Unknown agent id \"${id}\".`);
	}
	const result = focusTmuxTarget({
		sessionId: agent.tmuxSessionId,
		sessionName: agent.tmuxSessionName,
		windowId: agent.tmuxWindowId,
		paneId: agent.tmuxPaneId,
	});
	return { agent, result };
}

function captureAgentById(id: string, lines = 200): { agent: AgentSummary; content: string; command: string } {
	const agent = getAgent(getTmuxAgentsDb(), id);
	if (!agent) {
		throw new Error(`Unknown agent id \"${id}\".`);
	}
	if (
		!tmuxTargetExists({
			sessionId: agent.tmuxSessionId,
			sessionName: agent.tmuxSessionName,
			windowId: agent.tmuxWindowId,
			paneId: agent.tmuxPaneId,
		}, getTmuxInventory())
	) {
		throw new Error(`Cannot capture agent ${agent.id} because its tmux target is missing. Reconcile first.`);
	}
	const result = captureTmuxTarget(
		{
			sessionId: agent.tmuxSessionId,
			sessionName: agent.tmuxSessionName,
			windowId: agent.tmuxWindowId,
			paneId: agent.tmuxPaneId,
		},
		lines,
	);
	return { agent, content: result.content, command: result.command };
}

function buildDashboardData(ctx: ExtensionContext): AgentsDashboardData {
	const db = getTmuxAgentsDb();
	const all = listAgents(db, { limit: 200 });
	const currentProject = listAgents(db, { projectKey: getProjectKey(ctx.cwd), limit: 200 });
	const currentSession = listAgents(db, {
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
		limit: 200,
	});
	const descendants = listAgents(db, { descendantOf: getLinkedChildIds(ctx), limit: 200 });
	const childrenByParent = new Map<string, string[]>();
	for (const agent of all) {
		if (!agent.parentAgentId) continue;
		const children = childrenByParent.get(agent.parentAgentId) ?? [];
		children.push(agent.id);
		childrenByParent.set(agent.parentAgentId, children);
	}
	for (const [parent, children] of childrenByParent.entries()) {
		childrenByParent.set(parent, children.sort());
	}
	return {
		scopes: {
			all,
			current_project: currentProject,
			current_session: currentSession,
			descendants,
		},
		childrenByParent,
	};
}

async function runReplyFlow(ctx: ExtensionContext, agentId: string): Promise<void> {
	const agent = getAgent(getTmuxAgentsDb(), agentId);
	if (!agent) throw new Error(`Unknown agent id \"${agentId}\".`);
	if (["done", "error", "stopped", "lost"].includes(agent.state)) {
		throw new Error(`Cannot message agent ${agent.id} because it is in terminal state ${agent.state}.`);
	}
	if (
		!tmuxTargetExists({
			sessionId: agent.tmuxSessionId,
			sessionName: agent.tmuxSessionName,
			windowId: agent.tmuxWindowId,
			paneId: agent.tmuxPaneId,
		}, getTmuxInventory())
	) {
		throw new Error(`Cannot message agent ${agent.id} because its tmux target is missing. Reconcile first.`);
	}
	const kind = await ctx.ui.select("Message kind:", ["answer", "note", "redirect", "cancel", "priority"]);
	if (!kind) return;
	const summary = await ctx.ui.input(`Message for ${agent.id}:`, "");
	if (!summary?.trim()) return;
	const details = await ctx.ui.editor("Additional details (optional):", "");
	queueDownwardMessage(agent, kind as "answer" | "note" | "redirect" | "cancel" | "priority", {
		summary: summary.trim(),
		details: details?.trim() || undefined,
	}, "immediate");
	ctx.ui.notify(`Queued ${kind} for ${agent.id}.`, "info");
}

async function runStopFlow(ctx: ExtensionContext, agentId: string): Promise<void> {
	const choice = await ctx.ui.select("Stop mode:", ["Graceful stop", "Force stop", "Cancel"]);
	if (!choice || choice === "Cancel") return;
	const force = choice === "Force stop";
	const reason = await ctx.ui.input("Reason (optional):", "");
	const { agent, result } = stopAgentById(agentId, force, reason?.trim() || undefined);
	ctx.ui.notify(formatStopResult(agent, result, force), force ? "warning" : "info");
}

async function runAgentsDashboard(pi: ExtensionAPI, ctx: ExtensionContext, initialState: AgentsDashboardState): Promise<AgentsDashboardState> {
	let state = initialState;
	while (ctx.hasUI) {
		const action = await openAgentsDashboard(ctx, buildDashboardData(ctx), state);
		if (!action || action.type === "close") return action?.state ?? state;
		state = action.state;
		const selectedId = action.selectedId;
		if (!selectedId && action.type !== "spawn" && action.type !== "sync") continue;
		try {
			switch (action.type) {
				case "inspect": {
					const agent = getAgent(getTmuxAgentsDb(), selectedId!);
					if (agent) await ctx.ui.editor(`Agent ${agent.id}`, formatAgentDetails(agent));
					break;
				}
				case "focus": {
					const { agent, result } = focusAgentById(selectedId!);
					lastFocusedActiveAgentId = agent.id;
					ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
					break;
				}
				case "stop":
					await runStopFlow(ctx, selectedId!);
					break;
				case "reply":
					await runReplyFlow(ctx, selectedId!);
					break;
				case "capture": {
					const capture = captureAgentById(selectedId!, 200);
					await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
					break;
				}
				case "spawn":
					await runSpawnWizard(pi, ctx);
					break;
				case "sync": {
					const result = reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					ctx.ui.notify(formatReconcileResult(result), "info");
					break;
				}
				case "close":
				default:
					return state;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		updateFleetUi(ctx);
	}
	return state;
}

async function runSpawnWizard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const profile = await chooseProfile(ctx);
	if (!profile) return;
	const title = await ctx.ui.input("Child title:", `${profile.name} task`);
	if (!title?.trim()) return;
	const task = await ctx.ui.editor("Child task:", "");
	if (!task?.trim()) return;
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return;
	try {
		const result = spawnChildFromParams(pi, ctx, {
			title: title.trim(),
			task: task.trim(),
			profile: profile.name,
			cwd: cwd.trim(),
		});
		ctx.ui.notify(`Spawned ${result.agentId} in tmux ${result.tmuxSessionName}.`, "info");
		await ctx.ui.editor(`Spawned ${result.agentId}`, formatSpawnSuccess(result));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function runServiceSpawnWizard(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const title = await ctx.ui.input("Service title:", "dev server");
	if (!title?.trim()) return;
	const command = await ctx.ui.editor("Command to run:", "");
	if (!command?.trim()) return;
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return;
	const readySubstring = await ctx.ui.input("Ready substring (optional):", "");
	try {
		const result = await spawnServiceFromParams(ctx, {
			title: title.trim(),
			command: command.trim(),
			cwd: cwd.trim(),
			readySubstring: readySubstring?.trim() || undefined,
		});
		ctx.ui.notify(`Started ${result.serviceId} in tmux ${result.tmuxSessionName}.`, "info");
		await ctx.ui.editor(`Started ${result.serviceId}`, formatServiceStartResult(result));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export default function tmuxAgentsExtension(pi: ExtensionAPI): void {
	if (childRuntimeEnvironment) {
		registerChildRuntime(pi, childRuntimeEnvironment);
		return;
	}

	let dashboardState: AgentsDashboardState = {
		scope: "current_project",
		sort: "priority",
		activeOnly: false,
		blockedOnly: false,
		unreadOnly: false,
	};

	function cycleActiveAgent(ctx: ExtensionContext, direction: 1 | -1): void {
		const agents = listAgents(getTmuxAgentsDb(), { projectKey: getProjectKey(ctx.cwd), activeOnly: true, limit: 200 });
		if (agents.length === 0) {
			ctx.ui.notify("No active child agents to focus.", "warning");
			return;
		}
		const currentIndex = lastFocusedActiveAgentId ? agents.findIndex((agent) => agent.id === lastFocusedActiveAgentId) : -1;
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + agents.length) % agents.length;
		const target = agents[nextIndex] ?? agents[0]!;
		try {
			const { result } = focusAgentById(target.id);
			lastFocusedActiveAgentId = target.id;
			ctx.ui.notify(result.focused ? `Focused ${target.id}.` : formatFocusResult(target, result), result.focused ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	pi.registerTool({
		name: "subagent_spawn",
		label: "Subagent Spawn",
		description: "Spawn a tracked tmux-backed child pi session with a run directory, session file, and global registry entry.",
		promptSnippet: "Spawn a tracked tmux-backed child agent in a new window using a named profile, task, and optional cwd/model/tools overrides.",
		promptGuidelines: [
			"Use subagent_spawn when work should be delegated into an isolated child context.",
			"Pick the most appropriate profile and keep the delegated task narrowly scoped.",
			"Do not pass `find` in tool overrides. Use `grep` and `bash` with `rg --files` instead.",
		],
		parameters: SubagentSpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = spawnChildFromParams(pi, ctx, params);
			return {
				content: [{ type: "text", text: formatSpawnSuccess(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "subagent_focus",
		label: "Subagent Focus",
		description: "Switch the current tmux client to a tracked child agent window, or return the exact manual tmux command when automatic focus is not possible.",
		promptSnippet: "Focus a tracked tmux subagent window using its stored tmux ids.",
		promptGuidelines: [
			"Use subagent_focus when the user wants to jump directly into a child tmux window.",
		],
		parameters: SubagentFocusParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, result } = focusAgentById(params.id);
			lastFocusedActiveAgentId = agent.id;
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatFocusResult(agent, result) }],
				details: { agent, ...result },
			};
		},
	});

	pi.registerTool({
		name: "subagent_stop",
		label: "Subagent Stop",
		description: "Request a graceful stop for a tracked child agent, or force-kill its tmux target.",
		promptSnippet: "Stop a tracked tmux subagent gracefully or with force=true.",
		promptGuidelines: [
			"Use graceful stop first so the child can publish a final handoff.",
			"Use force=true only when the child is hung or the user explicitly wants an immediate kill.",
		],
		parameters: SubagentStopParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, result } = stopAgentById(params.id, params.force ?? false, params.reason);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatStopResult(agent, result, params.force ?? false) }],
				details: { agent, ...result, force: params.force ?? false },
			};
		},
	});

	pi.registerTool({
		name: "subagent_message",
		label: "Subagent Message",
		description: "Send a structured downward message to a tracked child agent.",
		promptSnippet: "Send structured answer, note, redirect, cancel, or priority updates to a tracked child agent.",
		promptGuidelines: [
			"Use subagent_message to answer child questions, redirect work, cancel, or change priority.",
			"Keep the message concrete and minimal, with exact file paths when relevant.",
		],
		parameters: SubagentMessageParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agent = getAgent(getTmuxAgentsDb(), params.id);
			if (!agent) throw new Error(`Unknown agent id \"${params.id}\".`);
			if (["done", "error", "stopped", "lost"].includes(agent.state)) {
				throw new Error(`Cannot message agent ${agent.id} because it is in terminal state ${agent.state}.`);
			}
			if (
				!tmuxTargetExists({
					sessionId: agent.tmuxSessionId,
					sessionName: agent.tmuxSessionName,
					windowId: agent.tmuxWindowId,
					paneId: agent.tmuxPaneId,
				}, getTmuxInventory())
			) {
				throw new Error(`Cannot message agent ${agent.id} because its tmux target is missing. Reconcile first.`);
			}
			queueDownwardMessage(
				agent,
				params.kind,
				{ summary: params.summary, details: params.details, files: params.files },
				params.deliveryMode ?? "immediate",
			);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `Queued ${params.kind} message for ${agent.id}.` }],
				details: { agentId: agent.id, kind: params.kind, deliveryMode: params.deliveryMode ?? "immediate" },
			};
		},
	});

	pi.registerTool({
		name: "subagent_capture",
		label: "Subagent Capture",
		description: "Capture recent tmux pane output for a tracked child agent.",
		promptSnippet: "Capture recent tmux pane output from a tracked subagent for extra context.",
		promptGuidelines: [
			"Use subagent_capture when you need recent live pane output or transcript context from a child tmux session.",
		],
		parameters: SubagentCaptureParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const capture = captureAgentById(params.id, params.lines ?? 200);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: capture.content || "(empty capture)" }],
				details: { agentId: capture.agent.id, command: capture.command, lines: params.lines ?? 200 },
			};
		},
	});

	pi.registerTool({
		name: "subagent_reconcile",
		label: "Subagent Reconcile",
		description: "Reconcile registry state against tmux target reality and latest child status snapshots.",
		promptSnippet: "Reconcile tracked tmux subagent registry state against tmux and run-directory snapshots.",
		promptGuidelines: [
			"Use subagent_reconcile when tmux windows disappear, status looks stale, or after restarting the primary session.",
		],
		parameters: SubagentReconcileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = reconcileAgents(ctx, params);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatReconcileResult(result) }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "subagent_list",
		label: "Subagent List",
		description: "List tracked tmux-backed subagents from the global registry.",
		promptSnippet: "List tracked tmux subagents by project/session/state/unread filters.",
		promptGuidelines: [
			"Use subagent_list to inspect already tracked child agents before delegating new work.",
			"Prefer current_project or current_session scope unless the user explicitly asks for a global fleet view.",
		],
		parameters: SubagentListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveAgentFilters(ctx, scope, params);
			const agents = listAgents(getTmuxAgentsDb(), filters);
			const header = `scope=${summarizeFilters(scope, filters)} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`;
			const body = agents.length === 0 ? "No agents matched." : agents.map(formatAgentLine).join("\n");
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: {
					scope,
					filters,
					agents,
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_get",
		label: "Subagent Get",
		description: "Get detailed state for one or more tracked tmux-backed subagents.",
		promptSnippet: "Inspect detailed state for specific tracked tmux subagents.",
		promptGuidelines: [
			"Use subagent_get after subagent_list when you need the full state, tmux ids, last preview, or latest unread message for a specific child.",
		],
		parameters: SubagentGetParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { id?: string; ids?: string[] };
			if (typeof input.id === "string" && !Array.isArray(input.ids)) {
				return { ids: [input.id] };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const agents = params.ids
				.map((id) => getAgent(getTmuxAgentsDb(), id))
				.filter((agent): agent is AgentSummary => agent !== null);
			const text =
				agents.length === 0 ? "No matching agents found." : agents.map((agent) => formatAgentDetails(agent)).join("\n\n---\n\n");
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text }],
				details: { ids: params.ids, agents },
			};
		},
	});

	pi.registerTool({
		name: "subagent_inbox",
		label: "Subagent Inbox",
		description: "Read unread child-originated mailbox messages that are already stored in the global registry.",
		promptSnippet: "Read unread child-originated questions, blockers, milestones, and completion handoffs from the subagent inbox.",
		promptGuidelines: [
			"Use subagent_inbox to read proactive child updates that were already published. Do not use it to poll children for status generation.",
		],
		parameters: SubagentInboxParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const agentFilters = resolveAgentFilters(ctx, scope, {});
			const messages = listInboxMessages(getTmuxAgentsDb(), {
				projectKey: agentFilters.projectKey,
				spawnSessionId: agentFilters.spawnSessionId,
				spawnSessionFile: agentFilters.spawnSessionFile,
				agentIds: agentFilters.descendantOf,
				includeDelivered: params.includeDelivered,
				limit: params.limit,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildInboxText(messages) }],
				details: { scope, messages },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_start",
		label: "tmux Service Start",
		description: "Launch a long-running command in a tracked tmux window and keep it available for focus, capture, and stop operations.",
		promptSnippet: "Launch a long-running API, dev server, watcher, or other shell command in a tracked tmux window.",
		promptGuidelines: [
			"Use tmux_service_start for API servers, frontend dev servers, file watchers, and other long-running commands you may need again later.",
			"Pass the foreground command, not a shell command that immediately backgrounds itself and exits.",
			"Pass a readySubstring when you want the tool to wait for a startup signal before continuing.",
		],
		parameters: TmuxServiceStartParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await spawnServiceFromParams(ctx, params);
			const service = getService(getTmuxAgentsDb(), result.serviceId);
			const extraOutput =
				result.initialOutput && (result.state === "error" || result.readyTimedOut)
					? `\n\nRecent output:\n${result.initialOutput.slice(-1200)}`
					: "";
			return {
				content: [{ type: "text", text: `${formatServiceStartResult(result)}${extraOutput}` }],
				details: { result, service },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_list",
		label: "tmux Service List",
		description: "List tracked tmux services from the global registry.",
		promptSnippet: "List tracked tmux services by project/session scope and active state.",
		promptGuidelines: [
			"Use tmux_service_list before starting another server when you are unsure whether one is already running.",
			"Prefer current_project or current_session scope unless the user explicitly asks for a global list.",
		],
		parameters: TmuxServiceListParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveServiceFilters(ctx, scope, params);
			const services = listServices(getTmuxAgentsDb(), filters);
			const header = `scope=${summarizeServiceFilters(scope, filters)} · ${services.length} service${services.length === 1 ? "" : "s"}`;
			const body = services.length === 0 ? "No services matched." : services.map(formatServiceLine).join("\n");
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: { scope, filters, services },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_get",
		label: "tmux Service Get",
		description: "Get detailed state for one or more tracked tmux services.",
		promptSnippet: "Inspect detailed state for specific tracked tmux service windows.",
		promptGuidelines: [
			"Use tmux_service_get after tmux_service_list when you need the full command, cwd, log file, or tmux ids for a specific service.",
		],
		parameters: TmuxServiceGetParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { id?: string; ids?: string[] };
			if (typeof input.id === "string" && !Array.isArray(input.ids)) {
				return { ids: [input.id] };
			}
			return args;
		},
		async execute(_toolCallId, params) {
			const services = params.ids
				.map((id) => getService(getTmuxAgentsDb(), id))
				.filter((service): service is ServiceSummary => service !== null);
			const text =
				services.length === 0 ? "No matching services found." : services.map((service) => formatServiceDetails(service)).join("\n\n---\n\n");
			return {
				content: [{ type: "text", text }],
				details: { ids: params.ids, services },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_focus",
		label: "tmux Service Focus",
		description: "Switch the current tmux client to a tracked service window, or return the exact manual tmux command when automatic focus is not possible.",
		promptSnippet: "Focus a tracked tmux service window using its stored tmux ids.",
		promptGuidelines: [
			"Use tmux_service_focus when you want to jump directly into a running service window.",
		],
		parameters: TmuxServiceFocusParams,
		async execute(_toolCallId, params) {
			const { service, result } = focusServiceById(params.id);
			return {
				content: [{ type: "text", text: formatServiceFocusResult(service, result) }],
				details: { service, ...result },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_stop",
		label: "tmux Service Stop",
		description: "Stop a tracked tmux service gracefully, or force-kill its tmux target.",
		promptSnippet: "Stop a tracked tmux service gracefully or with force=true.",
		promptGuidelines: [
			"Use graceful stop first for dev servers and watchers so they can shut down cleanly.",
			"Use force=true only when the process is hung or the user explicitly wants an immediate kill.",
		],
		parameters: TmuxServiceStopParams,
		async execute(_toolCallId, params) {
			const { service, result } = stopServiceById(params.id, params.force ?? false, params.reason);
			return {
				content: [{ type: "text", text: formatServiceStopResult(service, result, params.force ?? false) }],
				details: { service, ...result, force: params.force ?? false },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_capture",
		label: "tmux Service Capture",
		description: "Capture recent output from a tracked tmux service pane, or fall back to the persisted log file if the pane already exited.",
		promptSnippet: "Capture recent logs from a tracked tmux service for debugging or readiness checks.",
		promptGuidelines: [
			"Use tmux_service_capture when you need recent startup output, error logs, or the current URL/port from a running service.",
		],
		parameters: TmuxServiceCaptureParams,
		async execute(_toolCallId, params) {
			const capture = captureServiceById(params.id, params.lines ?? 200);
			return {
				content: [{ type: "text", text: capture.content || "(empty capture)" }],
				details: { serviceId: capture.service.id, source: capture.source, command: capture.command, lines: params.lines ?? 200 },
			};
		},
	});

	pi.registerTool({
		name: "tmux_service_reconcile",
		label: "tmux Service Reconcile",
		description: "Reconcile tracked tmux service state against tmux target reality and persisted status snapshots.",
		promptSnippet: "Reconcile tracked tmux service registry state against tmux and run-directory snapshots.",
		promptGuidelines: [
			"Use tmux_service_reconcile when service windows disappear, status looks stale, or after restarting the primary session.",
		],
		parameters: TmuxServiceReconcileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = reconcileServices(ctx, params);
			return {
				content: [{ type: "text", text: formatServiceReconcileResult(result) }],
				details: result,
			};
		},
	});

	pi.registerCommand("agents", {
		description: "Open the tmux subagents dashboard",
		handler: async (_args, ctx) => {
			dashboardState = await runAgentsDashboard(pi, ctx, dashboardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-spawn", {
		description: "Interactive tmux subagent spawn wizard",
		handler: async (_args, ctx) => {
			await runSpawnWizard(pi, ctx);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-open", {
		description: "Focus a tracked tmux child by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /agent-open <id>", "warning");
				return;
			}
			try {
				const { agent, result } = focusAgentById(id);
				lastFocusedActiveAgentId = agent.id;
				ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-message", {
		description: "Send a structured message to a tracked tmux child",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const kind = parts[1] as "answer" | "note" | "redirect" | "cancel" | "priority" | undefined;
			const validKinds = new Set(["answer", "note", "redirect", "cancel", "priority"]);
			const summary = parts.slice(2).join(" ").trim();
			if (!id || !kind || !validKinds.has(kind) || !summary) {
				ctx.ui.notify("Usage: /agent-message <id> <answer|note|redirect|cancel|priority> <message>", "warning");
				return;
			}
			try {
				const agent = getAgent(getTmuxAgentsDb(), id);
				if (!agent) throw new Error(`Unknown agent id \"${id}\".`);
				if (
					!tmuxTargetExists({
						sessionId: agent.tmuxSessionId,
						sessionName: agent.tmuxSessionName,
						windowId: agent.tmuxWindowId,
						paneId: agent.tmuxPaneId,
					}, getTmuxInventory())
				) {
					throw new Error(`Cannot message agent ${agent.id} because its tmux target is missing. Reconcile first.`);
				}
				queueDownwardMessage(agent, kind, { summary }, "immediate");
				ctx.ui.notify(`Queued ${kind} for ${id}.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-capture", {
		description: "Capture recent tmux pane output for a tracked child",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const lines = parts[1] ? Number(parts[1]) : 200;
			if (!id) {
				ctx.ui.notify("Usage: /agent-capture <id> [lines]", "warning");
				return;
			}
			try {
				const capture = captureAgentById(id, Number.isFinite(lines) && lines > 0 ? lines : 200);
				await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-stop", {
		description: "Stop a tracked tmux child by id",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const force = parts.includes("force") || parts.includes("--force");
			if (!id) {
				ctx.ui.notify("Usage: /agent-stop <id> [force]", "warning");
				return;
			}
			try {
				const { agent, result } = stopAgentById(id, force);
				ctx.ui.notify(formatStopResult(agent, result, force), force ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-sync", {
		description: "Refresh tmux subagent status from the global registry",
		handler: async (_args, ctx) => {
			try {
				const result = reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 });
				updateFleetUi(ctx);
				ctx.ui.notify(formatReconcileResult(result), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-start", {
		description: "Interactive tmux service spawn wizard",
		handler: async (_args, ctx) => {
			await runServiceSpawnWizard(ctx);
		},
	});

	pi.registerCommand("services", {
		description: "List tracked tmux services",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session"].includes(scope)) {
				ctx.ui.notify("Usage: /services [all|current_project|current_session]", "warning");
				return;
			}
			const filters = resolveServiceFilters(ctx, scope, { activeOnly: false, limit: 200 });
			const services = listServices(getTmuxAgentsDb(), filters);
			const text = `${`scope=${summarizeServiceFilters(scope, filters)} · ${services.length} service${services.length === 1 ? "" : "s"}`}${services.length === 0 ? "\n\nNo services matched." : `\n\n${services.map(formatServiceLine).join("\n")}`}`;
			if (ctx.hasUI) await ctx.ui.editor("tmux services", text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("service-open", {
		description: "Focus a tracked tmux service by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /service-open <id>", "warning");
				return;
			}
			try {
				const { service, result } = focusServiceById(id);
				ctx.ui.notify(result.focused ? `Focused ${service.id}.` : formatServiceFocusResult(service, result), result.focused ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-capture", {
		description: "Capture recent tmux service output",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const lines = parts[1] ? Number(parts[1]) : 200;
			if (!id) {
				ctx.ui.notify("Usage: /service-capture <id> [lines]", "warning");
				return;
			}
			try {
				const capture = captureServiceById(id, Number.isFinite(lines) && lines > 0 ? lines : 200);
				await ctx.ui.editor(`Service capture ${capture.service.id}`, capture.content || "(empty capture)");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-stop", {
		description: "Stop a tracked tmux service by id",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const force = parts.includes("force") || parts.includes("--force");
			if (!id) {
				ctx.ui.notify("Usage: /service-stop <id> [force]", "warning");
				return;
			}
			try {
				const { service, result } = stopServiceById(id, force);
				ctx.ui.notify(formatServiceStopResult(service, result, force), force ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-sync", {
		description: "Refresh tmux service status from the global registry",
		handler: async (_args, ctx) => {
			try {
				const result = reconcileServices(ctx, { scope: "current_project", activeOnly: false, limit: 200 });
				ctx.ui.notify(formatServiceReconcileResult(result), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Open tracked tmux agents dashboard",
		handler: async (ctx) => {
			dashboardState = await runAgentsDashboard(pi, ctx, dashboardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("n"), {
		description: "Spawn a tmux child agent",
		handler: async (ctx) => {
			await runSpawnWizard(pi, ctx);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("j"), {
		description: "Focus next active child agent",
		handler: async (ctx) => {
			cycleActiveAgent(ctx, 1);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("k"), {
		description: "Focus previous active child agent",
		handler: async (ctx) => {
			cycleActiveAgent(ctx, -1);
			updateFleetUi(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		getTmuxAgentsDb();
		updateFleetUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		updateFleetUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		closeTmuxAgentsDb();
	});
}
