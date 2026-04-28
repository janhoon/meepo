import { existsSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { openAgentsBoard, type AgentsBoardData, type AgentsBoardState, type BoardLaneId, type BoardTicket } from "./board.js";
import { registerChildRuntime, getChildRuntimeEnvironment } from "./child-runtime.js";
import { openAgentsDashboard, type AgentsDashboardData, type AgentsDashboardState } from "./dashboard.js";
import { closeTmuxAgentsDb, getTmuxAgentsDb } from "./db.js";
import { getRpcBridgeSocketPath, pingRpcBridge, readRpcBridgeStatus, sendRpcBridgeCommand } from "./rpc-client.js";
import { SESSION_CHILD_LINK_ENTRY_TYPE } from "./paths.js";
import { getSubagentProfile, listSubagentProfiles, normalizeBuiltinTools } from "./profiles.js";
import { resolveTaskLaunchProfile } from "./task-launch.js";
import { getProjectKey } from "./project.js";
import {
	createAgentEvent,
	createAgentMessage,
	getAgent,
	getFleetSummary,
	listAgents,
	listAttentionItems,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessages,
	updateAgent,
	updateAttentionItem,
	updateAttentionItemsForAgent,
} from "./registry.js";
import {
	claimTaskNeedsHumanResponse,
	createTask,
	createTaskEvent,
	getTask,
	getTaskSummary,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTaskEvents,
	listTaskNeedsHuman,
	listTasks,
	OPEN_TASK_NEEDS_HUMAN_STATES,
	reconcileTasks,
	unlinkTaskAgent,
	updateTask,
	updateTaskNeedsHumanForAgent,
} from "./task-registry.js";
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
	AttentionItemRecord,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	FleetSummary,
	ListAgentsFilters,
	RuntimeStatusSnapshot,
	SessionChildLinkEntryData,
	SpawnSubagentResult,
	SubagentProfile,
	UpdateAgentInput,
} from "./types.js";
import type {
	CreateTaskInput,
	ListTaskAgentLinksFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskLaunchPolicy,
	TaskNeedsHumanRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
	TaskWorkspaceStrategy,
	UpdateTaskInput,
} from "./task-types.js";

const childRuntimeEnvironment = getChildRuntimeEnvironment();
const ATTENTION_WAKE_POLL_MS = 2000;
let lastFocusedActiveAgentId: string | undefined;
let attentionWakePoll: ReturnType<typeof setInterval> | undefined;
const liveBridgeDeliveryInFlight = new Set<string>();
const scheduledBridgeDeliveryRetries = new Map<string, ReturnType<typeof setTimeout>>();
const sentCoordinatorAttentionIds = new Set<string>();
const notifiedUserAttentionIds = new Set<string>();
const sentCoordinatorNeedsHumanIds = new Set<string>();
const notifiedUserNeedsHumanIds = new Set<string>();

const LIST_SCOPE = StringEnum(["all", "current_project", "current_session", "descendants"] as const, {
	description: "Which slice of the global registry to inspect.",
	default: "current_project",
});

const TASK_WORKSPACE_STRATEGY = StringEnum(["inherit", "spawn_cwd", "existing_worktree", "dedicated_worktree"] as const, {
	description: "Workspace/worktree strategy for delegated work. `dedicated_worktree` provisions/reuses a git worktree; `existing_worktree` records an existing cwd as worktree metadata.",
});

const SubagentSpawnParams = Type.Object({
	title: Type.String({ description: "Short title for the child agent." }),
	task: Type.String({ description: "Task to delegate to the child agent." }),
	profile: Type.String({ description: "Agent profile name from ~/.pi/agent/agents/*.md." }),
	taskId: Type.Optional(Type.String({ description: "Optional existing task id to attach this child to. If omitted, a task is auto-created." })),
	cwd: Type.Optional(Type.String({ description: "Explicit working directory for the child. Defaults to the task worktree cwd when present, then the task spawn cwd when attached to a task, then the current cwd." })),
	workspaceStrategy: Type.Optional(TASK_WORKSPACE_STRATEGY),
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	tools: Type.Optional(
		Type.Array(Type.String({ description: "Child tool name" }), {
			description: "Optional child tool override. Allowed: read, bash, grep, ls, edit, write, task_create, task_list, task_get, task_update, task_move, task_note, task_attention. Unsupported names are ignored; invalid-only overrides grant no built-in tools.",
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

const DOWNWARD_ACTION_POLICY = StringEnum(["fyi", "resume_if_blocked", "replan", "interrupt_and_replan", "stop"] as const, {
	description: "How the child should react to this coordinator message.",
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
	actionPolicy: Type.Optional(DOWNWARD_ACTION_POLICY),
	inReplyToMessageId: Type.Optional(Type.String({ description: "Optional child-originated message id this responds to." })),
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

const ATTENTION_AUDIENCE_SCOPE = StringEnum(["all", "coordinator", "user"] as const, {
	description: "Which audience slice of attention items to inspect.",
	default: "all",
});

const SubagentAttentionParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	audience: Type.Optional(ATTENTION_AUDIENCE_SCOPE),
	includeResolved: Type.Optional(Type.Boolean({ description: "Include resolved/cancelled/superseded attention items.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of attention items to return.", minimum: 1, maximum: 500, default: 100 })),
});

const SubagentCleanupParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String({ description: "Agent id" }), { minItems: 1, maxItems: 100 })),
	force: Type.Optional(Type.Boolean({ description: "Clean terminal agents even if unresolved non-completion attention items still exist.", default: false })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview cleanup candidates without killing tmux targets.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to inspect for cleanup.", minimum: 1, maximum: 500, default: 100 })),
});

const TASK_STATE = StringEnum(["todo", "blocked", "in_progress", "in_review", "done"] as const, {
	description: "Task board status.",
	default: "todo",
});

const TASK_WAITING_ON = StringEnum(["user", "coordinator", "service", "external"] as const, {
	description: "Who or what this blocked task is waiting on.",
});

const TASK_LAUNCH_POLICY = StringEnum(["manual", "autonomous"] as const, {
	description: "Whether a ready todo task should stay manual or launch an agent automatically.",
	default: "manual",
});

const TASK_SORT = StringEnum(["priority", "updated", "created", "title", "status"] as const, {
	description: "Task list sort order.",
	default: "priority",
});

const TaskCreateParams = Type.Object({
	title: Type.String({ description: "Short task title." }),
	summary: Type.Optional(Type.String({ description: "Short task summary." })),
	description: Type.Optional(Type.String({ description: "Longer task description or delegation context." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the task. Defaults to the current cwd." })),
	parentTaskId: Type.Optional(Type.String({ description: "Optional parent task id." })),
	priority: Type.Optional(Type.Integer({ description: "Priority from 0 (highest) to 9 (lowest).", minimum: 0, maximum: 9 })),
	priorityLabel: Type.Optional(Type.String({ description: "Optional human-readable priority label." })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	labels: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	status: Type.Optional(TASK_STATE),
	blockedReason: Type.Optional(Type.String({ description: "Optional reason if creating directly in blocked." })),
	waitingOn: Type.Optional(TASK_WAITING_ON),
	requestedProfile: Type.Optional(Type.String({ description: "Explicit preferred subagent profile for task execution intent." })),
	assignedProfile: Type.Optional(Type.String({ description: "Resolved or manually assigned subagent profile for task execution intent." })),
	launchPolicy: Type.Optional(TASK_LAUNCH_POLICY),
	autonomousStart: Type.Optional(Type.Boolean({ description: "Shortcut for launchPolicy=autonomous; ready todo tasks spawn immediately after creation.", default: false })),
	promptTemplate: Type.Optional(Type.String({ description: "Optional prompt template or template id hint for the launched child." })),
	roleHint: Type.Optional(Type.String({ description: "Optional role/type hint used by autonomous profile selection." })),
	workspaceStrategy: Type.Optional(TASK_WORKSPACE_STRATEGY),
	worktreeId: Type.Optional(Type.String({ description: "Optional stable worktree identity for this task." })),
	worktreeCwd: Type.Optional(Type.String({ description: "Optional resolved worktree cwd for delegated agents to inherit. Metadata only; no worktree is provisioned." })),
});

const TaskListParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	statuses: Type.Optional(Type.Array(TASK_STATE, { maxItems: 10 })),
	waitingOn: Type.Optional(Type.Array(TASK_WAITING_ON, { maxItems: 10 })),
	includeDone: Type.Optional(Type.Boolean({ description: "Include done tasks when statuses are not provided.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of tasks to return.", minimum: 1, maximum: 500, default: 100 })),
	sort: Type.Optional(TASK_SORT),
	ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 200 })),
	linkedAgentId: Type.Optional(Type.String({ description: "Only show tasks linked to this agent id." })),
});

const TaskGetParams = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
	includeEvents: Type.Optional(Type.Boolean({ description: "Include recent task events.", default: true })),
	eventLimit: Type.Optional(Type.Integer({ description: "Maximum task events per task.", minimum: 1, maximum: 200, default: 20 })),
});

const TaskUpdateParams = Type.Object({
	id: Type.String({ description: "Task id." }),
	title: Type.Optional(Type.String({ description: "Short task title." })),
	summary: Type.Optional(Type.String({ description: "Short task summary." })),
	description: Type.Optional(Type.String({ description: "Longer task description." })),
	parentTaskId: Type.Optional(Type.String({ description: "Optional parent task id." })),
	priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
	priorityLabel: Type.Optional(Type.String()),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	labels: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	blockedReason: Type.Optional(Type.String()),
	waitingOn: Type.Optional(TASK_WAITING_ON),
	requestedProfile: Type.Optional(Type.String()),
	assignedProfile: Type.Optional(Type.String()),
	launchPolicy: Type.Optional(TASK_LAUNCH_POLICY),
	promptTemplate: Type.Optional(Type.String()),
	roleHint: Type.Optional(Type.String()),
	workspaceStrategy: Type.Optional(Type.Union([TASK_WORKSPACE_STRATEGY, Type.Null()], { description: "Workspace/worktree strategy metadata; null clears it." })),
	worktreeId: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Stable worktree identity; null clears it. Empty strings are normalized to null." })),
	worktreeCwd: Type.Optional(Type.Union([Type.String(), Type.Null()], { description: "Resolved worktree cwd metadata; null clears it. Empty strings are normalized to null; no worktree is provisioned." })),
	reviewSummary: Type.Optional(Type.String()),
	finalSummary: Type.Optional(Type.String()),
});

const TaskMoveParams = Type.Object({
	id: Type.String({ description: "Task id." }),
	status: TASK_STATE,
	reason: Type.Optional(Type.String({ description: "Short reason for the move." })),
	waitingOn: Type.Optional(TASK_WAITING_ON),
	blockedReason: Type.Optional(Type.String()),
	reviewSummary: Type.Optional(Type.String()),
	finalSummary: Type.Optional(Type.String()),
	force: Type.Optional(Type.Boolean({ description: "Allow moving a done task back into active work.", default: false })),
});

const TaskNoteParams = Type.Object({
	id: Type.String({ description: "Task id." }),
	summary: Type.String({ description: "Short task note summary." }),
	details: Type.Optional(Type.String({ description: "Longer task note details." })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
});

const TaskLinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	role: Type.Optional(Type.String({ description: "Role of this agent on the task." })),
	active: Type.Optional(Type.Boolean({ description: "Whether the link should be active.", default: true })),
});

const TaskUnlinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	reason: Type.Optional(Type.String({ description: "Why the agent is being unlinked." })),
});

const TaskAttentionParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of task attention items.", minimum: 1, maximum: 500, default: 100 })),
});

const TASK_RESPONSE_MODE = StringEnum(["task_patch", "child_message", "combined"] as const, {
	description: "Route for a needs-human response: patch task only, message child only, or patch then message child.",
	default: "child_message",
});

const TASK_RESPONSE_RESOLUTION = StringEnum(["acknowledged", "resolved", "cancelled", "superseded"] as const, {
	description: "How to mark the needs-human queue item after responding. Use acknowledged only with mode=task_patch; child_message and combined must use terminal resolved/cancelled/superseded semantics before queueing a child message.",
	default: "resolved",
});

const NullableString = (description?: string) => Type.Union([Type.String(description ? { description } : {}), Type.Null()]);
const NullableTaskWaitingOn = Type.Union([TASK_WAITING_ON, Type.Null()]);
const NullableTaskLaunchPolicy = Type.Union([TASK_LAUNCH_POLICY, Type.Null()]);
const NullableTaskWorkspaceStrategy = Type.Union([TASK_WORKSPACE_STRATEGY, Type.Null()]);

const TaskResponsePatchParams = Type.Object({
	title: Type.Optional(Type.String({ description: "Short task title." })),
	summary: Type.Optional(NullableString("Short task summary; null clears it.")),
	description: Type.Optional(NullableString("Longer task description; null clears it.")),
	parentTaskId: Type.Optional(NullableString("Optional parent task id; null clears it.")),
	priority: Type.Optional(Type.Integer({ minimum: 0, maximum: 9 })),
	priorityLabel: Type.Optional(NullableString("Priority label; null clears it.")),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	labels: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	status: Type.Optional(TASK_STATE),
	blockedReason: Type.Optional(NullableString("Blocked reason; null clears it.")),
	waitingOn: Type.Optional(NullableTaskWaitingOn),
	requestedProfile: Type.Optional(NullableString("Requested profile; null clears it.")),
	assignedProfile: Type.Optional(NullableString("Assigned profile; null clears it.")),
	launchPolicy: Type.Optional(NullableTaskLaunchPolicy),
	promptTemplate: Type.Optional(NullableString("Prompt template; null clears it.")),
	roleHint: Type.Optional(NullableString("Role hint; null clears it.")),
	workspaceStrategy: Type.Optional(NullableTaskWorkspaceStrategy),
	worktreeId: Type.Optional(NullableString("Stable worktree identity; null clears it.")),
	worktreeCwd: Type.Optional(NullableString("Resolved worktree cwd; null clears it.")),
	reviewSummary: Type.Optional(NullableString("Review summary; null clears it.")),
	finalSummary: Type.Optional(NullableString("Final summary; null clears it.")),
});

const TaskRespondParams = Type.Object({
	needsHumanId: Type.String({ description: "task_needs_human queue id from task_attention." }),
	mode: Type.Optional(TASK_RESPONSE_MODE),
	patch: Type.Optional(TaskResponsePatchParams),
	kind: Type.Optional(DOWNWARD_MESSAGE_KIND),
	summary: Type.Optional(Type.String({ description: "Short child message or response summary." })),
	details: Type.Optional(Type.String({ description: "Additional context for the child." })),
	files: Type.Optional(Type.Array(Type.String({ description: "Relevant file path" }), { maxItems: 100 })),
	actionPolicy: Type.Optional(DOWNWARD_ACTION_POLICY),
	deliveryMode: Type.Optional(DELIVERY_MODE),
	resolution: Type.Optional(TASK_RESPONSE_RESOLUTION),
	resolutionSummary: Type.Optional(Type.String({ description: "Queue resolution summary. Defaults to summary or patch description. resolution=acknowledged is allowed only for mode=task_patch; child_message/combined require resolved, cancelled, or superseded to prevent duplicate child replies." })),
});

const TaskOpenResponseParams = Type.Object({
	needsHumanId: Type.String({ description: "task_needs_human queue id to inspect/open." }),
	acknowledge: Type.Optional(Type.Boolean({ description: "Mark the queue item acknowledged without resolving it.", default: true })),
});

const TaskReconcileParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of items to reconcile.", minimum: 1, maximum: 500, default: 200 })),
});

const TaskWorktreeCleanupParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String({ description: "Task id" }), { minItems: 1, maxItems: 100 })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview cleanup candidates without removing git worktrees.", default: true })),
	remove: Type.Optional(Type.Boolean({ description: "Explicitly remove eligible dedicated git worktrees. Branches are never deleted.", default: false })),
	force: Type.Optional(Type.Boolean({ description: "Allow removing dirty eligible dedicated worktrees. Still never removes existing_worktree or active-agent worktrees.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of tasks to inspect.", minimum: 1, maximum: 500, default: 200 })),
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

function normalizeNullableMetadataString(rawValue: string | null | undefined): string | null | undefined {
	if (rawValue === undefined || rawValue === null) return rawValue;
	return rawValue.trim() || null;
}

function resolveNullableInputPath(baseDir: string, rawPath: string | null | undefined): string | null | undefined {
	const normalized = normalizeNullableMetadataString(rawPath);
	if (normalized === undefined || normalized === null) return normalized;
	return resolveInputPath(baseDir, normalized);
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

function runGit(args: string[], cwd: string): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout?.trim() ?? "";
}

function tryRunGit(args: string[], cwd: string): { ok: boolean; stdout: string } {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	return { ok: result.status === 0, stdout: result.stdout?.trim() ?? "" };
}

function sanitizeWorktreeSegment(value: string): string {
	const sanitized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	return sanitized || "task";
}

function parseWorktreeList(output: string): Array<{ path: string; branch: string | null; head: string | null }> {
	return output.split(/\n\s*\n/).map((block) => {
		let path = "";
		let branch: string | null = null;
		let head: string | null = null;
		for (const line of block.split("\n")) {
			if (line.startsWith("worktree ")) path = line.slice("worktree ".length).trim();
			if (line.startsWith("branch ")) branch = line.slice("branch ".length).trim();
			if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length).trim();
		}
		return { path, branch, head };
	}).filter((item) => item.path);
}

function assertExpectedWorktreeHead(task: TaskRecord, worktreeCwd: string, branchName: string, branchRef: string): void {
	const actualBranch = tryRunGit(["symbolic-ref", "--short", "HEAD"], worktreeCwd).stdout;
	if (actualBranch !== branchName) {
		throw new Error(`Dedicated worktree path ${worktreeCwd} for task ${task.id} is checked out on ${actualBranch || "detached HEAD"}, expected ${branchName}. Resolve the mismatch or choose a different task/worktree before spawning.`);
	}
	const worktreeHead = runGit(["rev-parse", "HEAD"], worktreeCwd);
	const branchHead = runGit(["rev-parse", branchRef], worktreeCwd);
	if (worktreeHead !== branchHead) {
		throw new Error(`Dedicated worktree path ${worktreeCwd} for task ${task.id} has HEAD ${worktreeHead}, but ${branchName} resolves to ${branchHead}. Resolve the mismatch before spawning.`);
	}
}

function assertExistingWorktreeCwd(worktreeCwd: string): void {
	assertDirectory(worktreeCwd);
	const insideWorktree = runGit(["rev-parse", "--is-inside-work-tree"], worktreeCwd);
	if (insideWorktree !== "true") {
		throw new Error(`workspaceStrategy=existing_worktree requires a cwd inside a git worktree: ${worktreeCwd}`);
	}
	runGit(["rev-parse", "--show-toplevel"], worktreeCwd);
}

function provisionTaskWorktree(task: TaskRecord, baseCwd: string): { worktreeId: string; worktreeCwd: string; branchName: string; reused: boolean; repoRoot: string } {
	const repoRoot = runGit(["rev-parse", "--show-toplevel"], baseCwd);
	assertDirectory(repoRoot);
	const worktreeId = sanitizeWorktreeSegment(task.id);
	const branchName = `pi/task/${worktreeId}`;
	const worktreeCwd = join(dirname(repoRoot), `${basename(repoRoot)}.pi-worktrees`, worktreeId);
	const resolvedWorktreeCwd = resolve(worktreeCwd);
	const branchRef = `refs/heads/${branchName}`;
	const worktrees = parseWorktreeList(runGit(["worktree", "list", "--porcelain"], repoRoot));
	const worktreeAtPath = worktrees.find((item) => resolve(item.path) === resolvedWorktreeCwd) ?? null;
	const worktreeForBranch = worktrees.find((item) => item.branch === branchRef) ?? null;
	if (worktreeForBranch && resolve(worktreeForBranch.path) !== resolvedWorktreeCwd) {
		throw new Error(`Branch ${branchName} for task ${task.id} is already checked out at ${resolve(worktreeForBranch.path)}, not deterministic path ${resolvedWorktreeCwd}. Use that worktree explicitly or clean up the conflicting worktree before spawning.`);
	}
	if (worktreeAtPath && worktreeAtPath.branch !== branchRef) {
		throw new Error(`Deterministic worktree path ${resolvedWorktreeCwd} for task ${task.id} is registered for ${worktreeAtPath.branch ?? "detached HEAD"}, expected ${branchName}. Resolve the mismatch before spawning.`);
	}
	if (worktreeAtPath) {
		assertDirectory(resolvedWorktreeCwd);
		assertExpectedWorktreeHead(task, resolvedWorktreeCwd, branchName, branchRef);
		return { worktreeId, worktreeCwd: resolvedWorktreeCwd, branchName, reused: true, repoRoot };
	}
	if (existsSync(resolvedWorktreeCwd)) {
		throw new Error(`Deterministic worktree path ${resolvedWorktreeCwd} for task ${task.id} already exists but is not a registered git worktree for ${branchName}. Move or inspect it before spawning.`);
	}
	const branchExists = tryRunGit(["show-ref", "--verify", "--quiet", branchRef], repoRoot).ok;
	const addArgs = branchExists ? ["worktree", "add", resolvedWorktreeCwd, branchName] : ["worktree", "add", "-b", branchName, resolvedWorktreeCwd, "HEAD"];
	try {
		runGit(addArgs, repoRoot);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to provision dedicated worktree for task ${task.id} from ${baseCwd}: ${message}`);
	}
	assertDirectory(resolvedWorktreeCwd);
	assertExpectedWorktreeHead(task, resolvedWorktreeCwd, branchName, branchRef);
	return { worktreeId, worktreeCwd: resolvedWorktreeCwd, branchName, reused: false, repoRoot };
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

function formatWorktreeLifecycle(task: Pick<TaskRecord, "id" | "status" | "workspaceStrategy" | "worktreeId" | "worktreeCwd">, linkedAgents: AgentSummary[] = []): { label: string; status: string; details: string[]; conflictCount: number; activeAgentCount: number } {
	if (!task.workspaceStrategy && !task.worktreeId && !task.worktreeCwd) {
		return { label: "none", status: "none", details: ["worktree: none"], conflictCount: 0, activeAgentCount: 0 };
	}
	const activeAgentCount = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)).length;
	const conflicts = linkedAgents.filter((agent) => {
		if (agent.worktreeCwd && task.worktreeCwd && resolve(agent.worktreeCwd) !== resolve(task.worktreeCwd)) return true;
		if (agent.worktreeId && task.worktreeId && agent.worktreeId !== task.worktreeId) return true;
		return false;
	});
	const pathExists = task.worktreeCwd ? existsSync(task.worktreeCwd) : false;
	let status = "metadata-only";
	if (conflicts.length > 0) status = "conflict";
	else if (activeAgentCount > 0) status = "active";
	else if (task.workspaceStrategy === "dedicated_worktree" && !task.worktreeCwd) status = "stale-missing";
	else if (task.worktreeCwd && !pathExists) status = "stale-missing";
	else if (task.workspaceStrategy === "dedicated_worktree" && task.status === "done") status = "ready-cleanup";
	else if (task.workspaceStrategy === "dedicated_worktree") status = "reusable";
	else if (task.workspaceStrategy === "existing_worktree") status = "preserved-existing";
	else if (task.workspaceStrategy === "spawn_cwd") status = "opt-out-spawn-cwd";
	else if (task.workspaceStrategy === "inherit") status = "inherit";
	const name = task.worktreeId ?? "-";
	const cwd = task.worktreeCwd ?? "-";
	const label = `${status}${task.worktreeId ? `:${task.worktreeId}` : ""}`;
	const details = [
		`worktree: ${status}`,
		`worktreeStrategy: ${task.workspaceStrategy ?? "-"}`,
		`worktreeId: ${name}`,
		`worktreeCwd: ${cwd}`,
		`worktreePathExists: ${task.worktreeCwd ? (pathExists ? "yes" : "no") : "-"}`,
		`worktreeActiveAgents: ${activeAgentCount}`,
		`worktreeConflicts: ${conflicts.length > 0 ? conflicts.map((agent) => `${agent.id}:${agent.worktreeId ?? "-"}:${agent.worktreeCwd ?? "-"}`).join(", ") : "none"}`,
	];
	return { label, status, details, conflictCount: conflicts.length, activeAgentCount };
}

function formatAgentWorktreeStatus(agent: AgentSummary): string {
	if (!agent.workspaceStrategy && !agent.worktreeId && !agent.worktreeCwd) return "none";
	const pathExists = agent.worktreeCwd ? existsSync(agent.worktreeCwd) : false;
	const active = ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state);
	if (active) return "active";
	if (agent.worktreeCwd && !pathExists) return "stale-missing";
	if (agent.workspaceStrategy === "dedicated_worktree" && ["done", "error", "stopped", "lost"].includes(agent.state)) return "terminal-reusable-or-cleanup";
	if (agent.workspaceStrategy === "existing_worktree") return "preserved-existing";
	return agent.workspaceStrategy ?? "metadata-only";
}

function formatAgentLine(agent: AgentSummary): string {
	const parts = [`${stateIcon(agent.state)} ${agent.id}`, `${agent.profile}`, truncateText(agent.title, 40)];
	if (agent.taskId) parts.push(`task=${agent.taskId}`);
	if (agent.workspaceStrategy) parts.push(`workspace=${agent.workspaceStrategy}`);
	if (agent.worktreeId || agent.worktreeCwd) parts.push(`worktree=${agent.worktreeId ?? agent.worktreeCwd}(${formatAgentWorktreeStatus(agent)})`);
	if (agent.transportKind === "rpc_bridge") {
		parts.push(`transport=${agent.transportState}`);
	}
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
		`taskId: ${agent.taskId ?? "-"}`,
		`workspaceStrategy: ${agent.workspaceStrategy ?? "-"}`,
		`worktreeId: ${agent.worktreeId ?? "-"}`,
		`worktreeCwd: ${agent.worktreeCwd ?? "-"}`,
		`worktreeStatus: ${formatAgentWorktreeStatus(agent)}`,
		`worktreePathExists: ${agent.worktreeCwd ? (existsSync(agent.worktreeCwd) ? "yes" : "no") : "-"}`,
		`spawnCwd: ${agent.spawnCwd}`,
		`spawnSessionId: ${agent.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${agent.spawnSessionFile ?? "-"}`,
		`model: ${agent.model ?? "-"}`,
		`transportKind: ${agent.transportKind}`,
		`transportState: ${agent.transportState}`,
		`runDir: ${agent.runDir}`,
		`sessionFile: ${agent.sessionFile}`,
		`bridgeSocketPath: ${agent.bridgeSocketPath ?? "-"}`,
		`bridgeStatusFile: ${agent.bridgeStatusFile ?? "-"}`,
		`bridgeLogFile: ${agent.bridgeLogFile ?? "-"}`,
		`bridgeEventsFile: ${agent.bridgeEventsFile ?? "-"}`,
		`bridgePid: ${agent.bridgePid ?? "-"}`,
		`bridgeConnectedAt: ${agent.bridgeConnectedAt ? new Date(agent.bridgeConnectedAt).toISOString() : "-"}`,
		`bridgeUpdatedAt: ${agent.bridgeUpdatedAt ? new Date(agent.bridgeUpdatedAt).toISOString() : "-"}`,
		`bridgeLastError: ${agent.bridgeLastError ?? "-"}`,
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

function formatTaskLine(task: TaskRecord, linkedAgents: AgentSummary[] = []): string {
	const worktree = formatWorktreeLifecycle(task, linkedAgents);
	const flags = [
		`status=${task.status}`,
		task.waitingOn ? `waiting=${task.waitingOn}` : null,
		`p${task.priority}`,
		task.workspaceStrategy ? `workspace=${task.workspaceStrategy}` : null,
		worktree.status !== "none" ? `worktree=${worktree.label}` : null,
		linkedAgents.length > 0 ? `${linkedAgents.length} agent${linkedAgents.length === 1 ? "" : "s"}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${task.id} · ${truncateText(task.title, 48)} · ${flags}`;
}

function formatTaskDetails(task: TaskRecord, linkedAgents: AgentSummary[] = [], events: ReturnType<typeof listTaskEvents> = []): string {
	const lines = [
		`id: ${task.id}`,
		`status: ${task.status}`,
		`title: ${task.title}`,
		`summary: ${task.summary ?? "-"}`,
		`description: ${task.description ?? "-"}`,
		`priority: ${task.priority}${task.priorityLabel ? ` (${task.priorityLabel})` : ""}`,
		`waitingOn: ${task.waitingOn ?? "-"}`,
		`blockedReason: ${task.blockedReason ?? "-"}`,
		`launchPolicy: ${task.launchPolicy}`,
		`requestedProfile: ${task.requestedProfile ?? "-"}`,
		`assignedProfile: ${task.assignedProfile ?? "-"}`,
		`promptTemplate: ${task.promptTemplate ?? "-"}`,
		`roleHint: ${task.roleHint ?? "-"}`,
		...formatWorktreeLifecycle(task, linkedAgents).details,
		`projectKey: ${task.projectKey}`,
		`spawnCwd: ${task.spawnCwd}`,
		`spawnSessionId: ${task.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${task.spawnSessionFile ?? "-"}`,
		`createdAt: ${new Date(task.createdAt).toISOString()}`,
		`updatedAt: ${new Date(task.updatedAt).toISOString()}`,
		`startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "-"}`,
		`reviewRequestedAt: ${task.reviewRequestedAt ? new Date(task.reviewRequestedAt).toISOString() : "-"}`,
		`finishedAt: ${task.finishedAt ? new Date(task.finishedAt).toISOString() : "-"}`,
		"",
		"acceptanceCriteria:",
		...(task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria.map((item) => `- ${item}`) : ["- none"]),
		"",
		"planSteps:",
		...(task.planSteps.length > 0 ? task.planSteps.map((item, index) => `${index + 1}. ${item}`) : ["- none"]),
		"",
		"validationSteps:",
		...(task.validationSteps.length > 0 ? task.validationSteps.map((item) => `- ${item}`) : ["- none"]),
		"",
		"files:",
		...(task.files.length > 0 ? task.files.map((item) => `- ${item}`) : ["- none"]),
		"",
		"labels:",
		...(task.labels.length > 0 ? task.labels.map((item) => `- ${item}`) : ["- none"]),
		"",
		`reviewSummary: ${task.reviewSummary ?? "-"}`,
		`finalSummary: ${task.finalSummary ?? "-"}`,
		"",
		"linkedAgents:",
		...(linkedAgents.length > 0 ? linkedAgents.map((agent) => `- ${agent.id} · ${agent.profile} · ${agent.state}${agent.worktreeCwd ? ` · worktree=${agent.worktreeCwd}` : ""} · worktreeStatus=${formatAgentWorktreeStatus(agent)}`) : ["- none"]),
	];
	if (events.length > 0) {
		lines.push("", "recentEvents:");
		for (const event of events) {
			lines.push(`- ${new Date(event.createdAt).toISOString()} · ${event.eventType} · ${event.summary}`);
		}
	}
	return lines.join("\n");
}

function sortTasksForList(tasks: TaskRecord[], sort: "priority" | "updated" | "created" | "title" | "status"): TaskRecord[] {
	return [...tasks].sort((left, right) => {
		switch (sort) {
			case "updated":
				return right.updatedAt - left.updatedAt;
			case "created":
				return right.createdAt - left.createdAt;
			case "title":
				return left.title.localeCompare(right.title) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "status":
				return left.status.localeCompare(right.status) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "priority":
			default:
				return left.priority - right.priority || right.updatedAt - left.updatedAt;
		}
	});
}

function summarizeTaskFilters(scope: string, filters: ListTasksFilters): string {
	const parts = [scope];
	if (filters.statuses && filters.statuses.length > 0) parts.push(`statuses=${filters.statuses.join(",")}`);
	if (filters.waitingOn && filters.waitingOn.length > 0) parts.push(`waitingOn=${filters.waitingOn.join(",")}`);
	if (filters.includeDone) parts.push("include-done");
	if (filters.linkedAgentId) parts.push(`linkedAgent=${filters.linkedAgentId}`);
	return parts.join(", ");
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

function resolveTaskFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { statuses?: TaskState[]; waitingOn?: TaskWaitingOn[]; includeDone?: boolean; limit?: number; linkedAgentId?: string },
): ListTasksFilters {
	const filters: ListTasksFilters = {
		statuses: params.statuses,
		waitingOn: params.waitingOn,
		includeDone: params.includeDone,
		limit: params.limit,
		linkedAgentId: params.linkedAgentId,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants": {
			const ids = getLinkedChildIds(ctx);
			if (ids.length === 0) {
				filters.ids = [];
				break;
			}
			const db = getTmuxAgentsDb();
			const taskIds = Array.from(new Set(listAgents(db, { ids, limit: 500 }).map((agent) => agent.taskId).filter((value): value is string => Boolean(value))));
			filters.ids = taskIds;
			break;
		}
		case "all":
		default:
			break;
	}
	return filters;
}

function formatTaskCounts(summary: TaskSummaryCounts): string | undefined {
	if (summary.todo === 0 && summary.blocked === 0 && summary.inProgress === 0 && summary.inReview === 0 && summary.done === 0) {
		return undefined;
	}
	return `🗂 ${summary.todo} todo · ${summary.blocked} blocked · ${summary.inProgress} in-progress · ${summary.inReview} review · ${summary.done} done`;
}

function formatFleetSummary(taskSummary: TaskSummaryCounts, agentSummary: FleetSummary, needsHumanCount = 0): string | undefined {
	const taskText = formatTaskCounts(taskSummary);
	const agentText =
		agentSummary.active === 0 && agentSummary.attentionOpen === 0 && agentSummary.unread === 0
			? undefined
			: `🤖 ${agentSummary.active} active · ${agentSummary.blocked} blocked · ${agentSummary.attentionOpen} open attention · ${agentSummary.unread} unread`;
	const needsHumanText = needsHumanCount > 0 ? `🚦 ${needsHumanCount} needs-human` : undefined;
	if (!taskText && !agentText && !needsHumanText) return undefined;
	return [taskText, needsHumanText, agentText].filter((value): value is string => Boolean(value)).join(" · ");
}

function attentionItemLabel(item: AttentionItemRecord): string {
	switch (item.kind) {
		case "question_for_user":
			return item.state === "waiting_on_user" ? "waiting on user" : "user question";
		case "question":
			return "question";
		case "blocked":
			return "blocker";
		case "complete":
			return "completion";
		default:
			return item.kind;
	}
}

function attentionItemIcon(item: AttentionItemRecord): string {
	switch (item.kind) {
		case "question_for_user":
			return "❓";
		case "question":
			return "?";
		case "blocked":
			return "⛔";
		case "complete":
			return "✓";
		default:
			return "•";
	}
}

function formatTaskNeedsHumanWakeup(item: TaskAttentionRecord, agent: AgentSummary | undefined): string {
	const payload = (item.payload && typeof item.payload === "object" ? item.payload : {}) as {
		details?: string;
		answerNeeded?: string;
		recommendedNextAction?: string;
		files?: string[];
	};
	return [
		`Task ${item.taskId} needs human attention (${item.kind}/${item.category}).`,
		`Title: ${item.title}`,
		`Agent: ${item.agentId}${agent?.profile ? ` (${agent.profile})` : ""}`,
		`Waiting on: ${item.waitingOn ?? "coordinator"}`,
		`Summary: ${item.summary}`,
		payload.answerNeeded ? `Answer needed: ${payload.answerNeeded}` : null,
		payload.recommendedNextAction ? `Recommended next action: ${payload.recommendedNextAction}` : null,
		payload.details ? `Details: ${payload.details}` : null,
		Array.isArray(payload.files) && payload.files.length > 0 ? `Files: ${payload.files.join(", ")}` : null,
		`Open with /needs-human or /task-response-open ${item.id}; respond with /task-respond ${item.id}.`,
	].filter((line): line is string => Boolean(line)).join("\n");
}

function formatAttentionWakeup(item: AttentionItemRecord, agent: AgentSummary | undefined): string {
	const payload = (item.payload && typeof item.payload === "object" ? item.payload : {}) as {
		details?: string;
		files?: string[];
		answerNeeded?: string;
		recommendedNextAction?: string;
	};
	const lines = [
		`Child ${agent?.id ?? item.agentId} (${agent?.profile ?? "agent"}) reported a ${attentionItemLabel(item)}.`,
		`Summary: ${item.summary}`,
		agent?.title ? `Title: ${agent.title}` : null,
		payload.answerNeeded ? `Answer needed: ${payload.answerNeeded}` : null,
		payload.recommendedNextAction ? `Recommended next action: ${payload.recommendedNextAction}` : null,
		payload.details ? `Details: ${payload.details}` : null,
		Array.isArray(payload.files) && payload.files.length > 0 ? `Files: ${payload.files.join(", ")}` : null,
	].filter((line): line is string => Boolean(line));
	if (item.kind === "complete") {
		lines.push("Review the handoff, then decide whether to move the linked task or delegate follow-on work.");
		return lines.join("\n");
	}
	lines.push("Respond with concrete guidance, exact file paths, and only one answer or redirect at a time if clarification is needed.");
	return lines.join("\n");
}

async function wakeCoordinatorFromAttention(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (childRuntimeEnvironment) return;
	const db = getTmuxAgentsDb();
	const projectKey = getProjectKey(ctx.cwd);
	const taskItems = listTaskAttention(db, { projectKey, limit: 25 });
	const agents = new Map(listAgents(db, { projectKey, limit: 200 }).map((agent) => [agent.id, agent]));

	for (const item of taskItems) {
		const agent = agents.get(item.agentId);
		if (item.waitingOn === "user") {
			if (notifiedUserNeedsHumanIds.has(item.id)) continue;
			try {
				ctx.ui.notify(`🗂 ${item.title} · ${item.kind} · ${item.summary}`, "warning");
				notifiedUserNeedsHumanIds.add(item.id);
			} catch (error) {
				notifiedUserNeedsHumanIds.delete(item.id);
				throw error;
			}
			continue;
		}
		if (sentCoordinatorNeedsHumanIds.has(item.id)) continue;
		sentCoordinatorNeedsHumanIds.add(item.id);
		try {
			await pi.sendUserMessage(formatTaskNeedsHumanWakeup(item, agent), { deliverAs: item.kind === "review_gate" || item.kind === "complete" ? "followUp" : "steer" });
		} catch (error) {
			sentCoordinatorNeedsHumanIds.delete(item.id);
			throw error;
		}
		return;
	}
	if (taskItems.length > 0) return;

	const items = listAttentionItems(db, {
		projectKey,
		states: ["open", "waiting_on_coordinator", "waiting_on_user"],
		limit: 25,
	});
	if (items.length === 0) return;

	for (const item of items) {
		const agent = agents.get(item.agentId);
		if (item.audience === "user") {
			if (notifiedUserAttentionIds.has(item.id)) continue;
			try {
				ctx.ui.notify(`${attentionItemIcon(item)} ${agent?.title ?? item.agentId} · ${item.summary}`, item.kind === "question_for_user" ? "warning" : "info");
				notifiedUserAttentionIds.add(item.id);
			} catch (error) {
				notifiedUserAttentionIds.delete(item.id);
				throw error;
			}
			continue;
		}
		if (sentCoordinatorAttentionIds.has(item.id)) continue;
		sentCoordinatorAttentionIds.add(item.id);
		const content = formatAttentionWakeup(item, agent);
		try {
			if (ctx.isIdle()) {
				await pi.sendUserMessage(content);
			} else {
				await pi.sendUserMessage(content, { deliverAs: item.kind === "complete" ? "followUp" : "steer" });
			}
		} catch (error) {
			sentCoordinatorAttentionIds.delete(item.id);
			throw error;
		}
		break;
	}
}

function updateFleetUi(ctx: ExtensionContext): void {
	const db = getTmuxAgentsDb();
	const projectKey = getProjectKey(ctx.cwd);
	const taskSummary = getTaskSummary(db, { projectKey });
	const agentSummary = getFleetSummary(db, { projectKey });
	const taskItems = listTaskAttention(db, { projectKey, limit: 100 });
	ctx.ui.setStatus("tmux-agents", formatFleetSummary(taskSummary, agentSummary, taskItems.length));
	const visibleTaskItems = taskItems.slice(0, 4);
	if (visibleTaskItems.length > 0) {
		ctx.ui.setWidget(
			"tmux-agents",
			visibleTaskItems.map((item) => `${item.status === "blocked" ? "⛔" : "◍"} ${truncateText(item.title, 28)} · ${item.kind} · ${item.agentId}${item.waitingOn ? ` · ${item.waitingOn}` : ""}`),
		);
		return;
	}
	const attentionItems = listAttentionItems(db, {
		projectKey,
		states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
		limit: 4,
	});
	if (attentionItems.length === 0) {
		ctx.ui.setWidget("tmux-agents", undefined);
		return;
	}
	const agents = new Map(listAgents(db, { projectKey, limit: 100 }).map((agent) => [agent.id, agent]));
	const lines = attentionItems.map((item) => {
		const agent = agents.get(item.agentId);
		const title = agent ? truncateText(agent.title, 34) : item.agentId;
		return `${attentionItemIcon(item)} ${title} · ${attentionItemLabel(item)} · ${item.agentId}`;
	});
	ctx.ui.setWidget("tmux-agents", lines);
}

const OPEN_ATTENTION_STATES: AttentionItemRecord["state"][] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];
const TERMINAL_AGENT_STATES: AgentSummary["state"][] = ["done", "error", "stopped", "lost"];

interface CleanupCandidate {
	agent: AgentSummary;
	attentionItems: AttentionItemRecord[];
	needsHumanItems: TaskNeedsHumanRecord[];
	targetExists: boolean;
	cleanupAllowed: boolean;
	reason: string;
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

function resolveAttentionFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { audience?: "all" | "coordinator" | "user"; includeResolved?: boolean; limit?: number },
) {
	const filters: import("./types.js").ListAttentionItemsFilters = {
		limit: params.limit,
		states: params.includeResolved ? undefined : OPEN_ATTENTION_STATES,
	};
	if (params.audience === "coordinator") filters.audiences = ["coordinator"];
	if (params.audience === "user") filters.audiences = ["user"];
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants":
			filters.agentIds = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

function formatAttentionItemLine(item: AttentionItemRecord, agent: AgentSummary | undefined): string {
	const title = agent ? truncateText(agent.title, 32) : item.agentId;
	return `${attentionItemIcon(item)} ${item.kind} · ${item.state} · ${item.audience} · ${title} · ${item.agentId}`;
}

function buildAttentionText(items: AttentionItemRecord[], agentsById: Map<string, AgentSummary>, includeResolved: boolean): string {
	if (items.length === 0) return includeResolved ? "No attention items matched." : "No open attention items.";
	return items
		.map((item) => {
			const agent = agentsById.get(item.agentId);
			const payloadText = truncateText(JSON.stringify(item.payload), 180);
			return `${formatAttentionItemLine(item, agent)}\nsummary: ${item.summary}\npayload: ${payloadText}`;
		})
		.join("\n\n");
}

function formatTaskAttentionLine(item: TaskAttentionRecord): string {
	const bits = [item.status, item.kind, item.category, item.waitingOn ? `waiting=${item.waitingOn}` : null, `${item.activeAgentCount} active-agent`, `${item.openAttentionCount} attention`]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${item.id} · ${item.taskId} · ${truncateText(item.title, 42)} · ${bits}`;
}

function buildTaskAttentionText(items: TaskAttentionRecord[], agentsById = new Map<string, AgentSummary>()): string {
	if (items.length === 0) return "No task attention items.";
	return items
		.map((item) => {
			const agent = agentsById.get(item.agentId);
			const agentText = agent ? `${agent.id} (${agent.profile}, ${agent.state})` : item.agentId;
			return `${formatTaskAttentionLine(item)}\nagent: ${agentText}\nsourceMessage: ${item.sourceMessageId ?? "-"}\nsummary: ${item.summary}\nblocked: ${item.blockedReason ?? "-"}\nreview: ${item.reviewSummary ?? "-"}\nresponseRequired: ${item.responseRequired ? "yes" : "no"}`;
		})
		.join("\n\n");
}

function buildNeedsHumanFallbackText(ctx: ExtensionContext, scope: "all" | "current_project" | "current_session" | "descendants" = "current_project"): string {
	const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
	const db = getTmuxAgentsDb();
	const items = listTaskAttention(db, { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: 200 });
	const agentsById = new Map(listAgents(db, { limit: 500 }).map((agent) => [agent.id, agent]));
	const body = buildTaskAttentionText(items, agentsById);
	return [`Needs-human queue (${scope})`, body, "Actions: /task-response-open <needs-human-id>; /task-respond <needs-human-id> <summary or JSON>; use /task-board in a UI session for open/respond/defer/approve/reject flows."].join("\n\n");
}

function formatAttentionGateWarning(items: AttentionItemRecord[], agentsById: Map<string, AgentSummary>): string {
	if (items.length === 0) return "";
	const preview = items.slice(0, 3).map((item) => `- ${formatAttentionItemLine(item, agentsById.get(item.agentId))}`).join("\n");
	return `Attention gate: ${items.length} unresolved attention item(s) already exist.\n${preview}`;
}

function listCleanupCandidates(
	ctx: ExtensionContext,
	params: { scope?: "all" | "current_project" | "current_session" | "descendants"; ids?: string[]; force?: boolean; limit?: number },
): CleanupCandidate[] {
	const db = getTmuxAgentsDb();
	const inventory = getTmuxInventory();
	const agents = params.ids && params.ids.length > 0
		? listAgents(db, { ids: params.ids, limit: params.limit ?? params.ids.length })
		: listAgents(db, resolveAgentFilters(ctx, params.scope ?? "current_project", { limit: params.limit }));
	const agentIds = agents.map((agent) => agent.id);
	const attentionByAgent = new Map<string, AttentionItemRecord[]>();
	const attentionItems = listAttentionItems(db, {
		agentIds,
		states: OPEN_ATTENTION_STATES,
		limit: 500,
	});
	for (const item of attentionItems) {
		const items = attentionByAgent.get(item.agentId) ?? [];
		items.push(item);
		attentionByAgent.set(item.agentId, items);
	}
	const needsHumanByAgent = new Map<string, TaskNeedsHumanRecord[]>();
	const needsHumanItems = listTaskNeedsHuman(db, {
		agentIds,
		states: OPEN_TASK_NEEDS_HUMAN_STATES,
		limit: 500,
	});
	for (const item of needsHumanItems) {
		const items = needsHumanByAgent.get(item.agentId) ?? [];
		items.push(item);
		needsHumanByAgent.set(item.agentId, items);
	}
	return agents
		.filter((agent) => TERMINAL_AGENT_STATES.includes(agent.state))
		.map((agent) => {
			const items = (attentionByAgent.get(agent.id) ?? []).sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
			const needsHuman = (needsHumanByAgent.get(agent.id) ?? []).sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
			const targetExists = tmuxTargetExists(
				{
					sessionId: agent.tmuxSessionId,
					sessionName: agent.tmuxSessionName,
					windowId: agent.tmuxWindowId,
					paneId: agent.tmuxPaneId,
				},
				inventory,
			);
			const blockingItems = [...items.filter((item) => item.kind !== "complete"), ...needsHuman.filter((item) => item.kind !== "complete" && item.kind !== "review_gate")];
			const unresolvedCount = items.length + needsHuman.length;
			let cleanupAllowed = targetExists;
			let reason = !targetExists ? "tmux target already gone" : unresolvedCount === 0 ? "no unresolved attention items" : "completion attention can be resolved during cleanup";
			if (blockingItems.length > 0 && !(params.force ?? false)) {
				cleanupAllowed = false;
				reason = `blocked by unresolved ${blockingItems[0]!.kind}`;
			}
			if (blockingItems.length > 0 && (params.force ?? false)) {
				reason = `force cleanup despite unresolved ${blockingItems[0]!.kind}`;
			}
			return { agent, attentionItems: items, needsHumanItems: needsHuman, targetExists, cleanupAllowed, reason };
		})
		.filter((candidate) => candidate.targetExists || params.ids?.includes(candidate.agent.id));
}

function cleanupAgentTarget(candidate: CleanupCandidate, force = false): { agentId: string; cleaned: boolean; reason: string; command: string } {
	const db = getTmuxAgentsDb();
	const agent = candidate.agent;
	const target = {
		sessionId: agent.tmuxSessionId,
		sessionName: agent.tmuxSessionName,
		windowId: agent.tmuxWindowId,
		paneId: agent.tmuxPaneId,
	};
	if (!tmuxTargetExists(target, getTmuxInventory())) {
		return { agentId: agent.id, cleaned: false, reason: "tmux target already gone", command: "(already gone)" };
	}
	const result = stopTmuxTarget(target, true);
	const now = Date.now();
	const completionItems = candidate.attentionItems.filter((item) => item.kind === "complete");
	const completionNeedsHumanItems = candidate.needsHumanItems.filter((item) => item.kind === "complete" || item.kind === "review_gate");
	if (completionItems.length > 0 || completionNeedsHumanItems.length > 0) {
		updateAttentionItemsForAgent(
			db,
			agent.id,
			{
				state: "resolved",
				updatedAt: now,
				resolvedAt: now,
				resolutionKind: "cleanup",
				resolutionSummary: "Agent tmux target cleaned up after completion.",
			},
			{ states: OPEN_ATTENTION_STATES, kinds: ["complete"] },
		);
		updateTaskNeedsHumanForAgent(
			db,
			agent.id,
			{
				state: "resolved",
				waitingOn: null,
				responseRequired: false,
				updatedAt: now,
				resolvedAt: now,
				resolvedBy: "coordinator",
				resolutionKind: "cleanup",
				resolutionSummary: "Agent tmux target cleaned up after completion.",
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"], kinds: ["complete", "review_gate"] },
		);
	}
	if (force) {
		const blockingKinds = [
			...candidate.attentionItems.filter((item) => item.kind !== "complete").map((item) => item.kind),
			...candidate.needsHumanItems.filter((item) => item.kind !== "complete" && item.kind !== "review_gate").map((item) => item.kind),
		];
		if (blockingKinds.length > 0) {
			updateAttentionItemsForAgent(
				db,
				agent.id,
				{
					state: "cancelled",
					updatedAt: now,
					resolvedAt: now,
					resolutionKind: "cleanup_force",
					resolutionSummary: "Agent tmux target force-cleaned while unresolved attention remained.",
				},
				{ states: OPEN_ATTENTION_STATES, kinds: ["question", "question_for_user", "blocked"] },
			);
			updateTaskNeedsHumanForAgent(
				db,
				agent.id,
				{
					state: "cancelled",
					waitingOn: null,
					responseRequired: false,
					updatedAt: now,
					resolvedAt: now,
					resolvedBy: "coordinator",
					resolutionKind: "cleanup_force",
					resolutionSummary: "Agent tmux target force-cleaned while unresolved attention remained.",
				},
				{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"], kinds: ["question", "question_for_user", "blocked"] },
			);
		}
	}
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: "cleaned_up",
		summary: force ? "Cleaned up tmux target with force." : "Cleaned up tmux target after terminal state.",
		payload: { command: result.command, force },
	});
	updateAgent(db, agent.id, { updatedAt: now });
	return { agentId: agent.id, cleaned: true, reason: force ? "force-cleaned" : "cleaned", command: result.command };
}

function formatCleanupCandidates(candidates: CleanupCandidate[], dryRun: boolean): string {
	if (candidates.length === 0) {
		return dryRun ? "No terminal agents matched for cleanup preview." : "No terminal agents matched for cleanup.";
	}
	const header = dryRun ? `Cleanup preview · ${candidates.length} candidate(s)` : `Cleanup candidates · ${candidates.length}`;
	const body = candidates
		.map((candidate) => {
			const attention = candidate.attentionItems.length > 0 ? candidate.attentionItems.map((item) => item.kind).join(",") : "none";
			const needsHuman = candidate.needsHumanItems.length > 0 ? candidate.needsHumanItems.map((item) => item.kind).join(",") : "none";
			return `${candidate.cleanupAllowed ? "✓" : "-"} ${candidate.agent.id} · ${candidate.agent.state} · ${candidate.reason} · attention=${attention} · needsHuman=${needsHuman}`;
		})
		.join("\n");
	return `${header}\n\n${body}`;
}

function formatCleanupResults(
	results: Array<{ agentId: string; cleaned: boolean; reason: string; command: string }>,
	skipped: CleanupCandidate[],
): string {
	const cleaned = results.filter((result) => result.cleaned);
	const lines = [
		`Cleanup finished · ${cleaned.length} cleaned · ${skipped.length} skipped`,
		"",
		...cleaned.map((result) => `✓ ${result.agentId} · ${result.reason} · ${result.command}`),
		...skipped.map((candidate) => `- ${candidate.agent.id} · ${candidate.reason}`),
	];
	return lines.join("\n");
}

interface TaskWorktreeCleanupCandidate {
	task: TaskRecord;
	linkedAgents: AgentSummary[];
	status: string;
	eligible: boolean;
	reason: string;
	branchName: string | null;
	registered: boolean;
	dirty: boolean;
}

function expectedDedicatedWorktreeBranch(task: TaskRecord): string | null {
	const id = task.worktreeId?.trim() || (task.workspaceStrategy === "dedicated_worktree" ? sanitizeWorktreeSegment(task.id) : null);
	return id ? `pi/task/${id}` : null;
}

function inspectTaskWorktree(task: TaskRecord, linkedAgents: AgentSummary[], force = false): TaskWorktreeCleanupCandidate {
	const lifecycle = formatWorktreeLifecycle(task, linkedAgents);
	const branchName = expectedDedicatedWorktreeBranch(task);
	const activeAgents = lifecycle.activeAgentCount;
	let registered = false;
	let dirty = false;
	let eligible = false;
	let reason = lifecycle.status;
	if (task.workspaceStrategy !== "dedicated_worktree") {
		reason = task.workspaceStrategy === "existing_worktree" ? "preserved existing_worktree metadata" : `not a dedicated worktree (${task.workspaceStrategy ?? "none"})`;
		return { task, linkedAgents, status: lifecycle.status, eligible: false, reason, branchName, registered, dirty };
	}
	if (!task.worktreeCwd) {
		return { task, linkedAgents, status: "stale-missing", eligible: false, reason: "dedicated worktree has no cwd metadata", branchName, registered, dirty };
	}
	if (task.status !== "done") {
		return { task, linkedAgents, status: lifecycle.status, eligible: false, reason: `task is ${task.status}; cleanup waits for done`, branchName, registered, dirty };
	}
	if (activeAgents > 0) {
		return { task, linkedAgents, status: "active", eligible: false, reason: `${activeAgents} active linked agent(s) still use this task`, branchName, registered, dirty };
	}
	if (!existsSync(task.worktreeCwd)) {
		return { task, linkedAgents, status: "stale-missing", eligible: false, reason: "worktree path is already missing; reconcile metadata instead of removing", branchName, registered, dirty };
	}
	try {
		const repoRoot = runGit(["rev-parse", "--show-toplevel"], task.spawnCwd);
		const worktrees = parseWorktreeList(runGit(["worktree", "list", "--porcelain"], repoRoot));
		registered = worktrees.some((item) => resolve(item.path) === resolve(task.worktreeCwd!));
		if (!registered) {
			return { task, linkedAgents, status: "stale-unregistered", eligible: false, reason: "path exists but is not a registered git worktree", branchName, registered, dirty };
		}
		const actualBranch = tryRunGit(["symbolic-ref", "--short", "HEAD"], task.worktreeCwd).stdout;
		if (branchName && actualBranch !== branchName) {
			return { task, linkedAgents, status: "conflict", eligible: false, reason: `registered worktree is on ${actualBranch || "detached HEAD"}, expected ${branchName}`, branchName, registered, dirty };
		}
		dirty = runGit(["status", "--porcelain"], task.worktreeCwd).length > 0;
		if (dirty && !force) {
			return { task, linkedAgents, status: "ready-cleanup-dirty", eligible: false, reason: "worktree has uncommitted changes; pass force only after review", branchName, registered, dirty };
		}
		eligible = true;
		reason = dirty ? "eligible with force; dirty worktree" : "eligible dedicated done-task worktree";
		return { task, linkedAgents, status: "ready-cleanup", eligible, reason, branchName, registered, dirty };
	} catch (error) {
		return { task, linkedAgents, status: "stale-error", eligible: false, reason: error instanceof Error ? error.message : String(error), branchName, registered, dirty };
	}
}

function listTaskWorktreeCleanupCandidates(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session" | "descendants"; ids?: string[]; force?: boolean; limit?: number }): TaskWorktreeCleanupCandidate[] {
	const db = getTmuxAgentsDb();
	const filters = params.ids && params.ids.length > 0 ? { ids: params.ids, includeDone: true, limit: params.limit ?? params.ids.length } : resolveTaskFilters(ctx, params.scope ?? "current_project", { includeDone: true, limit: params.limit });
	const tasks = listTasks(db, filters).filter((task) => task.workspaceStrategy || task.worktreeId || task.worktreeCwd);
	const links = listTaskAgentLinks(db, { taskIds: tasks.map((task) => task.id), activeOnly: true, limit: 1000 });
	const agents = listAgents(db, { ids: [...new Set(links.map((link) => link.agentId))], limit: 1000 });
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const agentsByTask = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (!agent) continue;
		const existing = agentsByTask.get(link.taskId) ?? [];
		existing.push(agent);
		agentsByTask.set(link.taskId, existing);
	}
	return tasks.map((task) => inspectTaskWorktree(task, agentsByTask.get(task.id) ?? [], params.force ?? false));
}

function formatTaskWorktreeCleanupCandidates(candidates: TaskWorktreeCleanupCandidate[], dryRun: boolean): string {
	if (candidates.length === 0) return dryRun ? "No task worktree metadata matched for cleanup preview." : "No task worktree metadata matched for cleanup.";
	return [
		dryRun ? `Task worktree cleanup preview · ${candidates.length} candidate(s)` : `Task worktree cleanup candidates · ${candidates.length}`,
		"",
		...candidates.map((candidate) => {
			const task = candidate.task;
			const marker = candidate.eligible ? "✓" : "-";
			return `${marker} ${task.id} · ${task.status} · ${candidate.status} · strategy=${task.workspaceStrategy ?? "-"} · worktree=${task.worktreeId ?? "-"} · cwd=${task.worktreeCwd ?? "-"} · branch=${candidate.branchName ?? "-"} · dirty=${candidate.dirty ? "yes" : "no"} · ${candidate.reason}`;
		}),
		"",
		"Cleanup policy: only dedicated_worktree entries for done tasks with no active linked agents are removable. existing_worktree and spawn_cwd metadata is preserved. git branches are never deleted.",
	].join("\n");
}

function cleanupTaskWorktree(candidate: TaskWorktreeCleanupCandidate, force = false): { taskId: string; removed: boolean; reason: string; command: string } {
	if (!candidate.eligible || !candidate.task.worktreeCwd) {
		return { taskId: candidate.task.id, removed: false, reason: candidate.reason, command: "(skipped)" };
	}
	const db = getTmuxAgentsDb();
	const repoRoot = runGit(["rev-parse", "--show-toplevel"], candidate.task.spawnCwd);
	const args = ["worktree", "remove", ...(force ? ["--force"] : []), candidate.task.worktreeCwd];
	runGit(args, repoRoot);
	const now = Date.now();
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: candidate.task.id,
		eventType: "worktree_cleaned_up",
		summary: `Removed dedicated worktree ${candidate.task.worktreeId ?? candidate.task.worktreeCwd}`,
		payload: { worktreeId: candidate.task.worktreeId, worktreeCwd: candidate.task.worktreeCwd, branchName: candidate.branchName, command: `git ${args.join(" ")}`, branchDeleted: false, force },
		createdAt: now,
	});
	updateTask(db, candidate.task.id, {
		workspaceStrategy: null,
		worktreeId: null,
		worktreeCwd: null,
		updatedAt: now,
	});
	return { taskId: candidate.task.id, removed: true, reason: force ? "removed with force" : "removed", command: `git ${args.join(" ")}` };
}

function formatTaskWorktreeCleanupResults(results: Array<{ taskId: string; removed: boolean; reason: string; command: string }>, skipped: TaskWorktreeCleanupCandidate[]): string {
	const removed = results.filter((result) => result.removed);
	return [
		`Task worktree cleanup finished · ${removed.length} removed · ${skipped.length} skipped`,
		"",
		...removed.map((result) => `✓ ${result.taskId} · ${result.reason} · ${result.command}`),
		...skipped.map((candidate) => `- ${candidate.task.id} · ${candidate.reason}`),
		"",
		"Branches were not deleted. Remove branches manually after review if desired.",
	].join("\n");
}

function formatSpawnSuccess(result: SpawnSubagentResult): string {
	return [
		`Spawned ${result.agentId} (${result.profile})`,
		"",
		`title: ${result.title}`,
		`taskId: ${result.taskId ?? "-"}`,
		`cwd: ${result.spawnCwd}`,
		`runDir: ${result.runDir}`,
		`sessionFile: ${result.sessionFile}`,
		`transport: ${result.transportKind} ${result.transportState}`,
		`bridgeSocketPath: ${result.bridgeSocketPath ?? "-"}`,
		`bridgeStatusFile: ${result.bridgeStatusFile ?? "-"}`,
		`bridgeLogFile: ${result.bridgeLogFile ?? "-"}`,
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

function defaultDownwardActionPolicy(kind: "answer" | "note" | "redirect" | "cancel" | "priority"): DownwardMessageActionPolicy {
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

function expectedDownwardHandlingLines(actionPolicy: DownwardMessageActionPolicy): string[] {
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

function formatDownwardMessageForChild(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
	const actionPolicy = payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind as "answer" | "note" | "redirect" | "cancel" | "priority");
	const lines = [`[Coordinator ${message.kind} · action ${actionPolicy}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.inReplyToMessageId) {
		lines.push("", `Replying to message: ${payload.inReplyToMessageId}`);
	}
	lines.push("", "Expected handling:");
	for (const line of expectedDownwardHandlingLines(actionPolicy)) {
		lines.push(`- ${line}`);
	}
	return lines.join("\n");
}

function scheduleBridgeDeliveryRetry(agentId: string, delayMs = 250): void {
	if (scheduledBridgeDeliveryRetries.has(agentId)) return;
	const timer = setTimeout(() => {
		scheduledBridgeDeliveryRetries.delete(agentId);
		void deliverQueuedMessagesViaBridge(agentId).catch(() => {});
	}, Math.max(1, delayMs));
	scheduledBridgeDeliveryRetries.set(agentId, timer);
}

async function deliverQueuedMessagesViaBridge(agentId: string): Promise<{ delivered: number; deferred: number; transportState: string }> {
	if (liveBridgeDeliveryInFlight.has(agentId)) {
		scheduleBridgeDeliveryRetry(agentId, 300);
		const queued = listMessagesForRecipient(getTmuxAgentsDb(), agentId, { targetKind: "child", limit: 50 });
		return { delivered: 0, deferred: queued.length, transportState: "busy" };
	}
	liveBridgeDeliveryInFlight.add(agentId);
	let lastFailureWasTransport = false;
	let stateProbeFailed = false;
	let stateProbeError: string | null = null;
	try {
		const db = getTmuxAgentsDb();
		let agent = getAgent(db, agentId);
		if (!agent) return { delivered: 0, deferred: 0, transportState: "missing" };
		if (agent.transportKind !== "rpc_bridge") {
			return { delivered: 0, deferred: 0, transportState: agent.transportState };
		}
		const queued = listMessagesForRecipient(db, agent.id, { targetKind: "child", limit: 50 });
		if (queued.length === 0) {
			return { delivered: 0, deferred: 0, transportState: agent.transportState };
		}
		const socketPath = getRpcBridgeSocketPath(agent);
		if (!socketPath) {
			updateAgent(db, agent.id, {
				transportKind: "rpc_bridge",
				transportState: "fallback",
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: "RPC bridge socket is unavailable.",
				updatedAt: Date.now(),
			});
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "downward_live_deferred",
				summary: "RPC bridge socket is unavailable.",
				payload: { queued: queued.length },
			});
			return { delivered: 0, deferred: queued.length, transportState: "fallback" };
		}

		let isStreaming = false;
		try {
			const stateResponse = await sendRpcBridgeCommand(socketPath, { command: "get_state" }, 2500);
			if (stateResponse.success && stateResponse.data && typeof stateResponse.data === "object") {
				isStreaming = Boolean((stateResponse.data as { isStreaming?: boolean }).isStreaming);
			}
		} catch (error) {
			stateProbeFailed = true;
			stateProbeError = error instanceof Error ? error.message : String(error);
			isStreaming = true;
		}

		let delivered = 0;
		for (const message of queued) {
			const bridgeCommand = !isStreaming
				? { command: "prompt" as const, message: formatDownwardMessageForChild(message) }
				: message.deliveryMode === "follow_up" || message.deliveryMode === "idle_only"
					? { command: "follow_up" as const, message: formatDownwardMessageForChild(message) }
					: { command: "steer" as const, message: formatDownwardMessageForChild(message) };
			let response;
			try {
				response = await sendRpcBridgeCommand(socketPath, bridgeCommand, 5000);
			} catch (error) {
				lastFailureWasTransport = true;
				throw error;
			}
			if (!response.success) {
				lastFailureWasTransport = false;
				throw new Error(response.error ?? `RPC bridge rejected ${message.kind}.`);
			}
			markAgentMessages(db, [message.id], "delivered");
			markAgentMessages(db, [message.id], "acked");
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "downward_live_delivered",
				summary: (message.payload as DownwardMessagePayload | null)?.summary ?? `${message.kind} delivered via RPC bridge`,
				payload: { messageId: message.id, bridgeCommand: bridgeCommand.command, deliveryMode: message.deliveryMode },
			});
			delivered += 1;
			isStreaming = true;
		}

		updateAgent(db, agent.id, {
			transportKind: "rpc_bridge",
			transportState: "live",
			bridgeSocketPath: socketPath,
			bridgeConnectedAt: Date.now(),
			bridgeUpdatedAt: Date.now(),
			bridgeLastError: stateProbeFailed ? stateProbeError : null,
			updatedAt: Date.now(),
		});
		return { delivered, deferred: Math.max(0, queued.length - delivered), transportState: "live" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const db = getTmuxAgentsDb();
		const agent = getAgent(db, agentId);
		if (agent && agent.transportKind === "rpc_bridge") {
			updateAgent(db, agent.id, {
				transportKind: "rpc_bridge",
				transportState: lastFailureWasTransport ? "fallback" : agent.transportState,
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: message,
				updatedAt: Date.now(),
			});
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: lastFailureWasTransport ? "downward_live_failed" : "downward_live_deferred",
				summary: message,
				payload: { error: message, transportFailure: lastFailureWasTransport },
			});
			if (!lastFailureWasTransport) {
				scheduleBridgeDeliveryRetry(agentId, 500);
			}
		}
		const queued = listMessagesForRecipient(db, agentId, { targetKind: "child", limit: 50 });
		return { delivered: 0, deferred: queued.length, transportState: lastFailureWasTransport ? "fallback" : "live" };
	} finally {
		liveBridgeDeliveryInFlight.delete(agentId);
		const queued = listMessagesForRecipient(getTmuxAgentsDb(), agentId, { targetKind: "child", limit: 1 });
		if (queued.length > 0) scheduleBridgeDeliveryRetry(agentId, 300);
	}
}

function queueDownwardMessage(
	agent: AgentSummary,
	kind: "answer" | "note" | "redirect" | "cancel" | "priority",
	payload: DownwardMessagePayload,
	deliveryMode: DeliveryMode,
	options: { resolveNeedsHumanId?: string; resolveTaskNeedsHuman?: boolean; legacyAttentionItemId?: string | null } = {},
): string {
	const db = getTmuxAgentsDb();
	const messageId = randomUUID();
	const fullPayload: DownwardMessagePayload = {
		...payload,
		actionPolicy: payload.actionPolicy ?? defaultDownwardActionPolicy(kind),
	};
	createAgentMessage(db, {
		id: messageId,
		threadId: agent.id,
		senderAgentId: null,
		recipientAgentId: agent.id,
		targetKind: "child",
		kind,
		deliveryMode,
		payload: fullPayload,
		status: "queued",
	});
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: `downward_${kind}`,
		summary: fullPayload.summary,
		payload: { messageId, deliveryMode, ...fullPayload },
	});
	const now = Date.now();
	const inReplyToMessageId = fullPayload.inReplyToMessageId ?? null;
	const shouldResolveTaskNeedsHuman = options.resolveTaskNeedsHuman !== false && (Boolean(options.resolveNeedsHumanId) || Boolean(inReplyToMessageId));
	const taskNeedsHumanFilter = options.resolveNeedsHumanId
		? { ids: [options.resolveNeedsHumanId] }
		: inReplyToMessageId
			? { sourceMessageId: inReplyToMessageId }
			: undefined;
	const openNeedsHumanStates = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"] as const;
	if (kind === "cancel") {
		if (options.resolveTaskNeedsHuman === false) {
			// The selected task_needs_human row and any linked legacy attention were claimed by the caller.
		} else if (options.legacyAttentionItemId) {
			updateAttentionItem(db, options.legacyAttentionItemId, {
				state: "cancelled",
				updatedAt: now,
				resolvedAt: now,
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			});
		} else if (inReplyToMessageId) {
			const attention = db.prepare("SELECT id FROM attention_items WHERE agent_id = ? AND message_id = ? LIMIT 1").get(agent.id, inReplyToMessageId) as { id?: string } | undefined;
			if (attention?.id) {
				updateAttentionItem(db, attention.id, {
					state: "cancelled",
					updatedAt: now,
					resolvedAt: now,
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				});
			}
		} else {
			updateAttentionItemsForAgent(
				db,
				agent.id,
				{
					state: "cancelled",
					updatedAt: now,
					resolvedAt: now,
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				},
				{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
			);
		}
		if (shouldResolveTaskNeedsHuman && taskNeedsHumanFilter) {
			updateTaskNeedsHumanForAgent(
				db,
				agent.id,
				{
					state: "cancelled",
					waitingOn: null,
					responseRequired: false,
					updatedAt: now,
					resolvedAt: now,
					resolvedBy: "coordinator",
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				},
				{ states: [...openNeedsHumanStates], ...taskNeedsHumanFilter },
			);
		}
	} else if (["answer", "redirect", "priority"].includes(kind)) {
		if (options.resolveTaskNeedsHuman === false) {
			// The selected task_needs_human row and any linked legacy attention were claimed by the caller.
		} else if (options.legacyAttentionItemId) {
			updateAttentionItem(db, options.legacyAttentionItemId, {
				state: "acknowledged",
				updatedAt: now,
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			});
		} else if (inReplyToMessageId) {
			const attention = db.prepare("SELECT id FROM attention_items WHERE agent_id = ? AND message_id = ? LIMIT 1").get(agent.id, inReplyToMessageId) as { id?: string } | undefined;
			if (attention?.id) {
				updateAttentionItem(db, attention.id, {
					state: "acknowledged",
					updatedAt: now,
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				});
			}
		} else if (!options.resolveNeedsHumanId) {
			updateAttentionItemsForAgent(
				db,
				agent.id,
				{
					state: "acknowledged",
					updatedAt: now,
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				},
				{
					states: ["open", "waiting_on_coordinator", "waiting_on_user"],
					kinds: ["question", "question_for_user", "blocked"],
				},
			);
		}
		if (shouldResolveTaskNeedsHuman && taskNeedsHumanFilter) {
			updateTaskNeedsHumanForAgent(
				db,
				agent.id,
				{
					state: "resolved",
					waitingOn: null,
					responseRequired: false,
					updatedAt: now,
					resolvedAt: now,
					resolvedBy: "coordinator",
					resolutionKind: kind,
					resolutionSummary: fullPayload.summary,
				},
				{ states: [...openNeedsHumanStates], kinds: ["question", "question_for_user", "blocked", "complete"], ...taskNeedsHumanFilter },
			);
		}
	}
	updateAgent(db, agent.id, { updatedAt: Date.now() });
	return messageId;
}

function assertCanMessageAgent(agent: AgentSummary): void {
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
}

function defaultTaskResponseKind(item: TaskNeedsHumanRecord): "answer" | "note" | "redirect" | "cancel" | "priority" {
	if (item.state === "cancelled") return "cancel";
	if (item.kind === "blocked" || item.kind === "question" || item.kind === "question_for_user") return "answer";
	return "note";
}

function defaultTaskResponseActionPolicy(kind: "answer" | "note" | "redirect" | "cancel" | "priority", item: TaskNeedsHumanRecord): DownwardMessageActionPolicy {
	if (kind === "answer" && ["blocked", "question", "question_for_user"].includes(item.kind)) return "resume_if_blocked";
	return defaultDownwardActionPolicy(kind);
}

function inferTaskResponseMode(item: TaskNeedsHumanRecord, params: { mode?: "task_patch" | "child_message" | "combined"; patch?: unknown; summary?: string }): "task_patch" | "child_message" | "combined" {
	if (params.mode) return params.mode;
	if (params.patch) return params.summary ? "combined" : "task_patch";
	if (item.category === "review_gate" || item.kind === "complete") return "task_patch";
	return "child_message";
}

function deriveTaskPatchForResponse(item: TaskNeedsHumanRecord, responseKind: "answer" | "note" | "redirect" | "cancel" | "priority", patch: UpdateTaskInput | undefined): UpdateTaskInput | undefined {
	const next: UpdateTaskInput = { ...(patch ?? {}) };
	if (next.status === undefined) {
		if (item.category === "review_gate" || item.kind === "complete") {
			next.status = "done";
			next.finishedAt = Date.now();
		} else if (responseKind === "answer" && item.kind === "blocked") {
			next.status = "in_progress";
		}
	}
	if (responseKind === "answer" && item.kind === "blocked") {
		if (next.waitingOn === undefined) next.waitingOn = null;
		if (next.blockedReason === undefined) next.blockedReason = null;
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

function taskPatchSummary(patch: UpdateTaskInput | undefined): string {
	if (!patch) return "No task fields changed.";
	const fields = Object.keys(patch).filter((key) => key !== "updatedAt");
	return fields.length > 0 ? `Updated task fields: ${fields.join(", ")}.` : "Updated task metadata.";
}

function buildTaskResponsePatch(raw: Partial<UpdateTaskInput> | undefined): UpdateTaskInput | undefined {
	if (!raw) return undefined;
	const patch: UpdateTaskInput = {};
	for (const key of Object.keys(raw) as Array<keyof UpdateTaskInput>) {
		const value = raw[key];
		if (value !== undefined) {
			(patch as Record<string, unknown>)[key] = value;
		}
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}

function assertTaskNeedsHumanRespondable(item: TaskNeedsHumanRecord): void {
	if (["resolved", "cancelled", "superseded"].includes(item.state)) {
		throw new Error(`Needs-human row ${item.id} is already ${item.state}; refusing to reopen or double-respond.`);
	}
}

function assertTaskNeedsHumanOpenable(item: TaskNeedsHumanRecord): void {
	if (["resolved", "cancelled", "superseded"].includes(item.state)) {
		throw new Error(`Needs-human row ${item.id} is already ${item.state}; refusing to acknowledge stale row.`);
	}
}

function assertTaskResponseResolutionAllowed(
	mode: "task_patch" | "child_message" | "combined",
	resolution: "acknowledged" | "resolved" | "cancelled" | "superseded",
): void {
	if (resolution === "acknowledged" && mode !== "task_patch") {
		throw new Error(`task_respond resolution=acknowledged is only allowed with mode=task_patch; mode=${mode} must use resolved, cancelled, or superseded before queueing a child message.`);
	}
}

function markTaskNeedsHumanResponse(
	item: TaskNeedsHumanRecord,
	resolution: "acknowledged" | "resolved" | "cancelled" | "superseded",
	resolutionKind: string,
	resolutionSummary: string,
): TaskNeedsHumanRecord {
	const db = getTmuxAgentsDb();
	const now = Date.now();
	const terminal = resolution !== "acknowledged";
	const claimed = claimTaskNeedsHumanResponse(db, item.id, {
		state: resolution,
		waitingOn: terminal ? null : item.waitingOn,
		responseRequired: !terminal,
		updatedAt: now,
		resolvedAt: terminal ? now : null,
		resolvedBy: terminal ? "coordinator" : null,
		resolutionKind,
		resolutionSummary,
	});
	if (!claimed) {
		const latest = listTaskNeedsHuman(db, { ids: [item.id], limit: 1 })[0];
		throw new Error(`Needs-human row ${item.id} is already ${latest?.state ?? "missing"}; refusing to reopen or double-respond.`);
	}
	const attentionItemId = item.legacyAttentionItemId ?? item.sourceMessageId;
	if (attentionItemId) {
		updateAttentionItem(db, attentionItemId, {
			state: resolution === "acknowledged" ? "acknowledged" : resolution,
			updatedAt: now,
			resolvedAt: terminal ? now : null,
			resolutionKind,
			resolutionSummary,
		});
	}
	return claimed;
}

async function respondToTaskNeedsHuman(params: {
	needsHumanId: string;
	mode?: "task_patch" | "child_message" | "combined";
	patch?: Partial<UpdateTaskInput>;
	kind?: "answer" | "note" | "redirect" | "cancel" | "priority";
	summary?: string;
	details?: string;
	files?: string[];
	actionPolicy?: DownwardMessageActionPolicy;
	deliveryMode?: DeliveryMode;
	resolution?: "acknowledged" | "resolved" | "cancelled" | "superseded";
	resolutionSummary?: string;
}): Promise<{ task: TaskRecord; item: TaskNeedsHumanRecord; patched: boolean; messageId: string | null; liveDelivery: Awaited<ReturnType<typeof deliverQueuedMessagesViaBridge>> | null; resolution: string }> {
	const db = getTmuxAgentsDb();
	const item = listTaskNeedsHuman(db, { ids: [params.needsHumanId], limit: 1 })[0];
	if (!item) throw new Error(`Unknown task needs-human id "${params.needsHumanId}".`);
	const task = getTask(db, item.taskId);
	if (!task) throw new Error(`Task ${item.taskId} for needs-human row ${item.id} is missing.`);
	assertTaskNeedsHumanRespondable(item);
	const mode = inferTaskResponseMode(item, params);
	const kind = params.kind ?? defaultTaskResponseKind(item);
	const resolution = params.resolution ?? (kind === "cancel" ? "cancelled" : "resolved");
	assertTaskResponseResolutionAllowed(mode, resolution);
	const patch = mode === "task_patch" || mode === "combined" || (mode === "child_message" && kind === "answer" && item.kind === "blocked")
		? deriveTaskPatchForResponse(item, kind, buildTaskResponsePatch(params.patch))
		: undefined;
	const responseSummary = params.resolutionSummary?.trim() || params.summary?.trim() || taskPatchSummary(patch);
	let agentForMessage: AgentSummary | null = null;
	if (mode !== "task_patch") {
		agentForMessage = getAgent(db, item.agentId);
		if (!agentForMessage) throw new Error(`Unknown linked agent id "${item.agentId}".`);
		assertCanMessageAgent(agentForMessage);
	}
	let messageId: string | null = null;
	let liveDelivery: Awaited<ReturnType<typeof deliverQueuedMessagesViaBridge>> | null = null;
	const claimedItem = markTaskNeedsHumanResponse(item, resolution, kind, responseSummary);
	let patched = false;
	let updatedTask = task;
	if (patch) {
		updateTask(db, task.id, { ...patch, updatedAt: Date.now() });
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: task.id,
			agentId: item.agentId,
			eventType: "needs_human_task_patch",
			summary: responseSummary,
			payload: { needsHumanId: item.id, route: mode, patch },
		});
		updatedTask = getTask(db, task.id) ?? task;
		patched = true;
	}
	if (mode !== "task_patch") {
		const agent = agentForMessage;
		if (!agent) throw new Error(`Unknown linked agent id "${item.agentId}".`);
		const summary = params.summary?.trim() || (patched ? taskPatchSummary(patch) : responseSummary);
		try {
			messageId = queueDownwardMessage(
				agent,
				kind,
				{
					summary,
					details: params.details,
					files: params.files,
					actionPolicy: params.actionPolicy ?? defaultTaskResponseActionPolicy(kind, item),
					inReplyToMessageId: item.sourceMessageId ?? undefined,
				},
				params.deliveryMode ?? "immediate",
				{ resolveNeedsHumanId: item.id, resolveTaskNeedsHuman: false },
			);
		} catch (error) {
			createTaskEvent(db, {
				id: randomUUID(),
				taskId: task.id,
				agentId: item.agentId,
				eventType: "needs_human_child_message_failed",
				summary: error instanceof Error ? error.message : String(error),
				payload: { needsHumanId: item.id, route: mode, patched, kind },
			});
			throw error;
		}
		liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: task.id,
			agentId: item.agentId,
			eventType: "needs_human_child_message",
			summary,
			payload: { needsHumanId: item.id, messageId, kind, inReplyToMessageId: item.sourceMessageId ?? null, deliveryMode: params.deliveryMode ?? "immediate", liveDelivery },
		});
	}
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: task.id,
		agentId: item.agentId,
		eventType: "needs_human_response",
		summary: responseSummary,
		payload: { needsHumanId: item.id, route: mode, resolution, messageId, patched },
	});
	return { task: updatedTask, item: claimedItem, patched, messageId, liveDelivery, resolution };
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

async function stopAgentById(id: string, force: boolean, reason?: string): Promise<{
	agent: AgentSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
}> {
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
		const db = getTmuxAgentsDb();
		const now = Date.now();
		const resolutionSummary = reason?.trim() || "tmux target missing; registry marked stopped.";
		updateAgent(db, agent.id, {
			state: "stopped",
			updatedAt: now,
			finishedAt: now,
			lastError: reason?.trim() || agent.lastError,
		});
		updateAttentionItemsForAgent(
			db,
			agent.id,
			{
				state: "cancelled",
				updatedAt: now,
				resolvedAt: now,
				resolutionKind: "force_stop",
				resolutionSummary,
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
		);
		updateTaskNeedsHumanForAgent(
			db,
			agent.id,
			{
				state: "cancelled",
				waitingOn: null,
				responseRequired: false,
				updatedAt: now,
				resolvedAt: now,
				resolvedBy: "coordinator",
				resolutionKind: "force_stop",
				resolutionSummary,
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"] },
		);
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
		const cancelMessageId = queueDownwardMessage(
			agent,
			"cancel",
			{
				summary: reason?.trim() || "Stop requested by coordinator.",
				details: reason?.trim() || "Please stop current work and provide a short completion or blocker handoff.",
			},
			"immediate",
		);
		const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
		const cancelStillQueued = listMessagesForRecipient(getTmuxAgentsDb(), agent.id, { targetKind: "child", limit: 50 }).some(
			(message) => message.id === cancelMessageId,
		);
		if (liveDelivery.delivered > 0 || cancelStillQueued || liveDelivery.deferred > 0 || liveDelivery.transportState === "busy") {
			createAgentEvent(getTmuxAgentsDb(), {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "graceful_stop_requested",
				summary: reason?.trim() || "Stop requested via RPC bridge.",
				payload: { liveDelivery, cancelMessageId, cancelStillQueued },
			});
			return {
				agent: getAgent(getTmuxAgentsDb(), agent.id) ?? agent,
				result: {
					stopped: false,
					graceful: true,
					command: liveDelivery.delivered > 0 ? "rpc cancel" : "queued cancel",
					reason:
						liveDelivery.delivered > 0
							? "Cancel delivered via RPC bridge. Waiting for the child to stop gracefully."
							: "Cancel is queued for graceful child delivery. Waiting for the child to stop before falling back to tmux kill.",
				},
			};
		}
	}
	const result = stopTmuxTarget(target, force);
	if (force) {
		const db = getTmuxAgentsDb();
		const now = Date.now();
		const resolutionSummary = reason?.trim() || "Force stop issued by coordinator.";
		updateAgent(db, agent.id, {
			state: "stopped",
			updatedAt: now,
			finishedAt: now,
			lastError: reason?.trim() || agent.lastError,
		});
		updateAttentionItemsForAgent(
			db,
			agent.id,
			{
				state: "cancelled",
				updatedAt: now,
				resolvedAt: now,
				resolutionKind: "force_stop",
				resolutionSummary,
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
		);
		updateTaskNeedsHumanForAgent(
			db,
			agent.id,
			{
				state: "cancelled",
				waitingOn: null,
				responseRequired: false,
				updatedAt: now,
				resolvedAt: now,
				resolvedBy: "coordinator",
				resolutionKind: "force_stop",
				resolutionSummary,
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"] },
		);
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

async function reconcileAgents(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session" | "descendants"; activeOnly?: boolean; limit?: number }): Promise<{
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; transportState: string; reason: string }>;
}> {
	const scope = params.scope ?? "current_project";
	const filters = resolveAgentFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getTmuxAgentsDb();
	const agents = listAgents(db, filters);
	const inventory = getTmuxInventory();
	const changed: Array<{ id: string; state: string; transportState: string; reason: string }> = [];
	const bridgeHealth = new Map(
		await Promise.all(
			agents
				.filter((agent) => agent.transportKind === "rpc_bridge")
				.map(async (agent) => [
					agent.id,
					{
						status: readRpcBridgeStatus(agent.bridgeStatusFile),
						ping: await pingRpcBridge(agent, 1200),
					},
				] as const),
		),
	);
	for (const agent of agents) {
		const latestStatus = readLatestStatus(agent);
		const bridge = bridgeHealth.get(agent.id);
		const bridgeStatus = bridge?.status ?? null;
		const bridgeReachable = Boolean(bridge?.ping?.success);
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
		if (bridgeStatus && bridgeStatus.updatedAt > (agent.bridgeUpdatedAt ?? 0)) {
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: bridgeStatus.transportState,
				bridgeSocketPath: bridgeStatus.socketPath ?? agent.bridgeSocketPath,
				bridgePid: bridgeStatus.bridgePid,
				bridgeConnectedAt: bridgeStatus.connectedAt ?? agent.bridgeConnectedAt,
				bridgeUpdatedAt: bridgeStatus.updatedAt,
				bridgeLastError: bridgeStatus.lastError ?? null,
			};
			reason = reason || "bridge-status.json was newer than the registry";
		}
		if (bridgeReachable) {
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: "live",
				bridgeSocketPath: getRpcBridgeSocketPath(agent),
				bridgeConnectedAt: bridgeStatus?.connectedAt ?? agent.bridgeConnectedAt ?? Date.now(),
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: null,
				updatedAt: Date.now(),
			};
			reason = reason || "RPC bridge responded to health check";
		} else if (agent.transportKind === "rpc_bridge") {
			const inferredTransportState = !targetExists
				? "lost"
				: bridgeStatus?.transportState === "error"
					? "error"
					: bridgeStatus?.transportState === "stopped"
						? "stopped"
						: bridgeStatus?.transportState === "listening" || bridgeStatus?.transportState === "launching"
							? "disconnected"
							: "fallback";
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: inferredTransportState,
				bridgeUpdatedAt: Date.now(),
				bridgeLastError:
					bridgeStatus?.lastError ??
					agent.bridgeLastError ??
					(targetExists ? "RPC bridge health check failed." : "tmux target missing during reconcile"),
			};
			reason = reason || (targetExists ? `RPC bridge not reachable; using ${inferredTransportState} transport state` : "tmux target missing during reconcile");
		}
		if (latestStatus && latestStatus.updatedAt > agent.updatedAt) {
			const preferLiveBridgeTransport = patch.transportKind === "rpc_bridge" && patch.transportState === "live";
			patch = {
				...patch,
				state: latestStatus.state,
				transportKind: preferLiveBridgeTransport ? patch.transportKind : latestStatus.transportKind ?? patch.transportKind,
				transportState: preferLiveBridgeTransport ? patch.transportState : latestStatus.transportState ?? patch.transportState,
				bridgeUpdatedAt:
					preferLiveBridgeTransport
						? patch.bridgeUpdatedAt
						: latestStatus.transportKind === "rpc_bridge" && latestStatus.transportState
							? latestStatus.updatedAt
							: patch.bridgeUpdatedAt,
				updatedAt: Math.max(latestStatus.updatedAt, patch.updatedAt ?? 0),
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
					transportState: agent.transportKind === "rpc_bridge" ? (latestStatus.state === "error" ? "error" : "stopped") : patch.transportState,
					updatedAt: Date.now(),
					finishedAt: latestStatus.finishedAt ?? Date.now(),
				};
				reason = reason || "tmux target exited after terminal latest-status update";
			} else if (["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)) {
				patch = {
					...patch,
					state: "lost",
					transportState: agent.transportKind === "rpc_bridge" ? "lost" : patch.transportState,
					bridgeUpdatedAt: agent.transportKind === "rpc_bridge" ? Date.now() : patch.bridgeUpdatedAt,
					updatedAt: Date.now(),
					lastError: agent.lastError ?? "tmux target missing during reconcile",
					bridgeLastError:
						agent.transportKind === "rpc_bridge"
							? (bridgeStatus?.lastError ?? agent.bridgeLastError ?? "tmux target missing during reconcile")
							: patch.bridgeLastError,
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
		if (Object.keys(patch).length > 0) {
			updateAgent(db, agent.id, patch);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "reconciled",
				summary: reason,
				payload: {
					state: patch.state ?? agent.state,
					transportState: patch.transportState ?? agent.transportState,
					targetExists,
					bridgeReachable,
				},
			});
			changed.push({
				id: agent.id,
				state: patch.state ?? agent.state,
				transportState: patch.transportState ?? agent.transportState,
				reason,
			});
		}
	}
	return { scope, reconciled: agents.length, changed };
}

function formatReconcileResult(result: { scope: string; reconciled: number; changed: Array<{ id: string; state: string; transportState: string; reason: string }> }): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} agents in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} agents in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · transport=${item.transportState} · ${item.reason}`),
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

function createTaskFromParams(ctx: ExtensionContext, params: {
	title: string;
	summary?: string;
	description?: string;
	cwd?: string;
	parentTaskId?: string;
	priority?: number;
	priorityLabel?: string;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	labels?: string[];
	files?: string[];
	status?: TaskState;
	blockedReason?: string;
	waitingOn?: TaskWaitingOn;
	requestedProfile?: string;
	assignedProfile?: string;
	launchPolicy?: TaskLaunchPolicy;
	autonomousStart?: boolean;
	promptTemplate?: string;
	roleHint?: string;
	workspaceStrategy?: TaskWorkspaceStrategy;
	worktreeId?: string;
	worktreeCwd?: string;
}): TaskRecord {
	const db = getTmuxAgentsDb();
	const now = Date.now();
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	const taskId = `task_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
	const input: CreateTaskInput = {
		id: taskId,
		parentTaskId: params.parentTaskId?.trim() || null,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
		spawnCwd,
		projectKey: getProjectKey(spawnCwd),
		title: params.title.trim(),
		summary: params.summary?.trim() || null,
		description: params.description?.trim() || null,
		status: params.status ?? "todo",
		priority: params.priority ?? 3,
		priorityLabel: params.priorityLabel?.trim() || null,
		waitingOn: params.waitingOn,
		blockedReason: params.blockedReason?.trim() || null,
		requestedProfile: params.requestedProfile?.trim() || null,
		assignedProfile: params.assignedProfile?.trim() || null,
		launchPolicy: params.autonomousStart ? "autonomous" : params.launchPolicy ?? "manual",
		promptTemplate: params.promptTemplate?.trim() || null,
		roleHint: params.roleHint?.trim() || null,
		workspaceStrategy: params.workspaceStrategy ?? null,
		worktreeId: params.worktreeId?.trim() || null,
		worktreeCwd: resolveNullableInputPath(spawnCwd, params.worktreeCwd) ?? null,
		acceptanceCriteria: params.acceptanceCriteria,
		planSteps: params.planSteps,
		validationSteps: params.validationSteps,
		labels: params.labels,
		files: params.files,
		createdAt: now,
		updatedAt: now,
		startedAt: params.status === "in_progress" ? now : null,
		reviewRequestedAt: params.status === "in_review" ? now : null,
		finishedAt: params.status === "done" ? now : null,
	};
	createTask(db, input);
	createTaskEvent(db, {
		id: randomUUID(),
		taskId,
		eventType: "created",
		summary: `Created task ${input.title}`,
		payload: {
			summary: input.summary,
			status: input.status,
			priority: input.priority,
			requestedProfile: input.requestedProfile,
			assignedProfile: input.assignedProfile,
			launchPolicy: input.launchPolicy,
			promptTemplate: input.promptTemplate,
			roleHint: input.roleHint,
			workspaceStrategy: input.workspaceStrategy,
			worktreeId: input.worktreeId,
			worktreeCwd: input.worktreeCwd,
		},
		createdAt: now,
	});
	return getTask(db, taskId)!;
}

function ensureTaskForSpawn(ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	cwd?: string;
	taskId?: string;
	priority?: string;
	profileSelectionReason?: string;
}): TaskRecord {
	const db = getTmuxAgentsDb();
	const existingTaskId = params.taskId?.trim() || null;
	if (existingTaskId) {
		const task = getTask(db, existingTaskId);
		if (!task) throw new Error(`Unknown task id \"${existingTaskId}\".`);
		const now = Date.now();
		updateTask(db, existingTaskId, {
			status: "in_progress",
			waitingOn: null,
			blockedReason: null,
			assignedProfile: params.profile,
			updatedAt: now,
			startedAt: task.startedAt ?? now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: existingTaskId,
			eventType: "spawn_requested",
			summary: `Spawn requested for ${params.profile}`,
			payload: { title: params.title, task: params.task, profileSelectionReason: params.profileSelectionReason ?? null },
			createdAt: now,
		});
		return getTask(db, existingTaskId)!;
	}
	return createTaskFromParams(ctx, {
		title: params.title,
		summary: params.task,
		description: params.task,
		cwd: params.cwd,
		priorityLabel: params.priority,
		status: "in_progress",
		assignedProfile: params.profile,
	});
}

function maybeAutonomousLaunchTask(pi: ExtensionAPI, ctx: ExtensionContext, task: TaskRecord): SpawnSubagentResult | null {
	if (task.launchPolicy !== "autonomous" || task.status !== "todo") return null;
	const activeLinks = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds: [task.id], activeOnly: true, limit: 1 });
	if (activeLinks.length > 0) return null;
	const resolution = resolveTaskLaunchProfile(task);
	const db = getTmuxAgentsDb();
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: task.id,
		eventType: "launch_profile_resolved",
		summary: `Autonomous launch selected ${resolution.profile.name}`,
		payload: {
			profile: resolution.profile.name,
			source: resolution.source,
			reason: resolution.reason,
			requestedProfile: task.requestedProfile,
			assignedProfile: task.assignedProfile,
			roleHint: task.roleHint,
			promptTemplate: task.promptTemplate,
		},
	});
	const taskPrompt = [
		task.promptTemplate ? `Prompt template: ${task.promptTemplate}` : null,
		task.roleHint ? `Role hint: ${task.roleHint}` : null,
		task.description ?? task.summary ?? task.title,
	].filter((value): value is string => Boolean(value)).join("\n\n");
	return spawnChildFromParams(pi, ctx, {
		title: task.title,
		task: taskPrompt,
		profile: resolution.profile.name,
		taskId: task.id,
		priority: task.priorityLabel ?? undefined,
		profileSelectionReason: resolution.reason,
	});
}

function getTaskLinkedAgents(taskId: string, activeOnly = false): AgentSummary[] {
	const db = getTmuxAgentsDb();
	const links = listTaskAgentLinks(db, { taskIds: [taskId], activeOnly, limit: 200 });
	const ids = Array.from(new Set(links.map((link) => link.agentId)));
	if (ids.length === 0) return [];
	const agents = listAgents(db, { ids, limit: ids.length });
	return activeOnly ? agents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)) : agents;
}

async function chooseAgentForTaskAction(ctx: ExtensionContext, taskId: string, actionLabel: string): Promise<AgentSummary | null> {
	const linkedAgents = getTaskLinkedAgents(taskId, true);
	if (linkedAgents.length === 0) return null;
	if (linkedAgents.length === 1 || !ctx.hasUI) return linkedAgents[0] ?? null;
	const selection = await ctx.ui.select(
		`${actionLabel}: choose linked agent`,
		linkedAgents.map((agent) => `${agent.id} · ${agent.profile} · ${agent.state}`),
	);
	if (!selection) return null;
	return linkedAgents.find((agent) => `${agent.id} · ${agent.profile} · ${agent.state}` === selection) ?? linkedAgents[0] ?? null;
}

function spawnChildFromParams(pi: ExtensionAPI, ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	taskId?: string;
	cwd?: string;
	workspaceStrategy?: TaskWorkspaceStrategy;
	model?: string;
	tools?: string[];
	parentAgentId?: string;
	priority?: string;
	profileSelectionReason?: string;
}): SpawnSubagentResult {
	const profile = requireProfile(params.profile);
	const db = getTmuxAgentsDb();
	const explicitCwd = params.cwd?.trim() ? resolveInputPath(ctx.cwd, params.cwd) : null;
	if (explicitCwd && params.workspaceStrategy === "dedicated_worktree") {
		throw new Error("workspaceStrategy=dedicated_worktree provisions and spawns in the deterministic task worktree; omit cwd. Explicit cwd is only valid with workspaceStrategy=spawn_cwd, existing_worktree, or inherited task workspace metadata.");
	}
	const existingTaskId = params.taskId?.trim() || null;
	const existingTask = existingTaskId ? getTask(db, existingTaskId) : null;
	if (existingTaskId && !existingTask) throw new Error(`Unknown task id \"${existingTaskId}\".`);
	const shouldInheritTaskWorktree = !explicitCwd && params.workspaceStrategy !== "spawn_cwd";
	const initialSpawnCwd = explicitCwd ?? (shouldInheritTaskWorktree ? existingTask?.worktreeCwd : null) ?? existingTask?.spawnCwd ?? ctx.cwd;
	assertDirectory(initialSpawnCwd);
	let task = ensureTaskForSpawn(ctx, {
		title: params.title,
		task: params.task,
		profile: params.profile,
		cwd: initialSpawnCwd,
		taskId: params.taskId,
		priority: params.priority,
		profileSelectionReason: params.profileSelectionReason,
	});
	let spawnCwd = explicitCwd ?? (shouldInheritTaskWorktree ? task.worktreeCwd : null) ?? task.spawnCwd ?? ctx.cwd;
	let workspaceStrategy = params.workspaceStrategy ?? (shouldInheritTaskWorktree ? task.workspaceStrategy : null);
	let worktreeId = shouldInheritTaskWorktree ? task.worktreeId : null;
	let worktreeCwd = shouldInheritTaskWorktree ? task.worktreeCwd : null;
	if (params.workspaceStrategy === "dedicated_worktree") {
		const provisioned = provisionTaskWorktree(task, task.spawnCwd ?? ctx.cwd);
		const now = Date.now();
		updateTask(db, task.id, {
			workspaceStrategy: "dedicated_worktree",
			worktreeId: provisioned.worktreeId,
			worktreeCwd: provisioned.worktreeCwd,
			updatedAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: task.id,
			eventType: "worktree_provisioned",
			summary: `${provisioned.reused ? "Reused" : "Created"} dedicated worktree ${provisioned.worktreeId}`,
			payload: {
				workspaceStrategy: "dedicated_worktree",
				worktreeId: provisioned.worktreeId,
				worktreeCwd: provisioned.worktreeCwd,
				branchName: provisioned.branchName,
				repoRoot: provisioned.repoRoot,
				reused: provisioned.reused,
			},
			createdAt: now,
		});
		task = getTask(db, task.id)!;
		workspaceStrategy = task.workspaceStrategy;
		worktreeId = task.worktreeId;
		worktreeCwd = task.worktreeCwd;
		spawnCwd = task.worktreeCwd ?? task.spawnCwd;
	} else if (params.workspaceStrategy === "spawn_cwd") {
		workspaceStrategy = "spawn_cwd";
		worktreeId = null;
		worktreeCwd = null;
		spawnCwd = explicitCwd ?? task.spawnCwd ?? ctx.cwd;
	} else if (params.workspaceStrategy === "existing_worktree") {
		assertExistingWorktreeCwd(spawnCwd);
		const existingWorktreeId = sanitizeWorktreeSegment(task.id);
		const now = Date.now();
		updateTask(db, task.id, {
			workspaceStrategy: "existing_worktree",
			worktreeId: existingWorktreeId,
			worktreeCwd: spawnCwd,
			updatedAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: task.id,
			eventType: "worktree_recorded",
			summary: `Recorded existing worktree cwd for ${task.id}`,
			payload: { workspaceStrategy: "existing_worktree", worktreeId: existingWorktreeId, worktreeCwd: spawnCwd },
			createdAt: now,
		});
		task = getTask(db, task.id)!;
		workspaceStrategy = task.workspaceStrategy;
		worktreeId = task.worktreeId;
		worktreeCwd = task.worktreeCwd;
	}
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
		taskId: task.id,
		parentAgentId: params.parentAgentId?.trim() || null,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
		workspaceStrategy,
		worktreeId,
		worktreeCwd,
	});
	linkTaskAgent(db, {
		taskId: task.id,
		agentId: result.agentId,
		role: profile.name,
		isActive: true,
		summary: params.profileSelectionReason ? `${params.title} · ${params.profileSelectionReason}` : params.title,
		syncTaskWorkspace: params.workspaceStrategy === "spawn_cwd" ? false : !(explicitCwd && params.workspaceStrategy == null),
	});
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: task.id,
		agentId: result.agentId,
		eventType: "child_spawned",
		summary: `Spawned ${profile.name} in ${result.spawnCwd}`,
		payload: {
			spawnCwd: result.spawnCwd,
			workspaceStrategy: result.workspaceStrategy,
			worktreeId: result.worktreeId,
			worktreeCwd: result.worktreeCwd,
			explicitCwd: Boolean(explicitCwd),
		},
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
	const needsHumanByScope = {
		all: listTaskAttention(db, { limit: 100 }),
		current_project: listTaskAttention(db, { projectKey: getProjectKey(ctx.cwd), limit: 100 }),
		current_session: listTaskAttention(db, {
			spawnSessionId: ctx.sessionManager.getSessionId(),
			spawnSessionFile: ctx.sessionManager.getSessionFile(),
			limit: 100,
		}),
		descendants: listTaskAttention(db, { ids: listAgents(db, { descendantOf: getLinkedChildIds(ctx), limit: 200 }).map((agent) => agent.taskId).filter((id): id is string => Boolean(id)), limit: 100 }),
	};
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
		needsHumanByScope,
		childrenByParent,
	};
}

function boardLaneForTask(task: TaskRecord): BoardLaneId {
	return task.status;
}

function buildBoardScopeData(tasks: TaskRecord[], agents: AgentSummary[], attentionItems: AttentionItemRecord[]): AgentsBoardData["scopes"]["all"] {
	const taskIds = tasks.map((task) => task.id);
	const needsHumanQueue = listTaskAttention(getTmuxAgentsDb(), { ids: taskIds, limit: 100 });
	const links = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds, activeOnly: true, limit: 500 });
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const agentsByTaskId = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (!agent) continue;
		const existing = agentsByTaskId.get(link.taskId) ?? [];
		existing.push(agent);
		agentsByTaskId.set(link.taskId, existing);
	}
	const openAttentionCounts = new Map<string, number>();
	for (const item of attentionItems) {
		const agent = agentsById.get(item.agentId);
		if (!agent?.taskId) continue;
		openAttentionCounts.set(agent.taskId, (openAttentionCounts.get(agent.taskId) ?? 0) + 1);
	}
	const lanes: Record<BoardLaneId, BoardTicket[]> = {
		todo: [],
		blocked: [],
		in_progress: [],
		in_review: [],
		done: [],
	};
	const tasksById = new Map<string, TaskRecord>();
	for (const task of tasks) {
		tasksById.set(task.id, task);
		const linkedAgents = agentsByTaskId.get(task.id) ?? [];
		const activeAgentCount = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)).length;
		const linkedProfiles = Array.from(new Set(linkedAgents.map((agent) => agent.profile))).sort();
		const laneId = boardLaneForTask(task);
		const ticket: BoardTicket = {
			taskId: task.id,
			laneId,
			title: task.title,
			priority: task.priority,
			priorityLabel: task.priorityLabel,
			waitingOn: task.waitingOn,
			blockedReason: task.blockedReason,
			updatedAt: task.updatedAt,
			activeAgentCount,
			linkedProfiles,
			openAttentionCount: openAttentionCounts.get(task.id) ?? 0,
			summary: task.blockedReason ?? task.reviewSummary ?? task.summary ?? task.finalSummary ?? task.description ?? "-",
		};
		lanes[laneId].push(ticket);
	}
	for (const laneId of Object.keys(lanes) as BoardLaneId[]) {
		lanes[laneId].sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
	}
	return { lanes, tasksById, agentsByTaskId, needsHumanQueue };
}

function buildBoardData(ctx: ExtensionContext): AgentsBoardData {
	const db = getTmuxAgentsDb();
	const scopeTasks = {
		all: listTasks(db, { includeDone: true, limit: 200 }),
		current_project: listTasks(db, { projectKey: getProjectKey(ctx.cwd), includeDone: true, limit: 200 }),
		current_session: listTasks(db, {
			spawnSessionId: ctx.sessionManager.getSessionId(),
			spawnSessionFile: ctx.sessionManager.getSessionFile(),
			includeDone: true,
			limit: 200,
		}),
		descendants: listTasks(db, resolveTaskFilters(ctx, "descendants", { includeDone: true, limit: 200 })),
	};
	const scopeAgents = {
		all: listAgents(db, { limit: 200 }),
		current_project: listAgents(db, { projectKey: getProjectKey(ctx.cwd), limit: 200 }),
		current_session: listAgents(db, {
			spawnSessionId: ctx.sessionManager.getSessionId(),
			spawnSessionFile: ctx.sessionManager.getSessionFile(),
			limit: 200,
		}),
		descendants: listAgents(db, { descendantOf: getLinkedChildIds(ctx), limit: 200 }),
	};
	const scopeAttention = {
		all: listAttentionItems(db, { states: OPEN_ATTENTION_STATES, limit: 500 }),
		current_project: listAttentionItems(db, { projectKey: getProjectKey(ctx.cwd), states: OPEN_ATTENTION_STATES, limit: 500 }),
		current_session: listAttentionItems(db, {
			spawnSessionId: ctx.sessionManager.getSessionId(),
			spawnSessionFile: ctx.sessionManager.getSessionFile(),
			states: OPEN_ATTENTION_STATES,
			limit: 500,
		}),
		descendants: listAttentionItems(db, { agentIds: getLinkedChildIds(ctx), states: OPEN_ATTENTION_STATES, limit: 500 }),
	};
	return {
		scopes: {
			all: buildBoardScopeData(scopeTasks.all, scopeAgents.all, scopeAttention.all),
			current_project: buildBoardScopeData(scopeTasks.current_project, scopeAgents.current_project, scopeAttention.current_project),
			current_session: buildBoardScopeData(scopeTasks.current_session, scopeAgents.current_session, scopeAttention.current_session),
			descendants: buildBoardScopeData(scopeTasks.descendants, scopeAgents.descendants, scopeAttention.descendants),
		},
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
	const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
	ctx.ui.notify(
		liveDelivery.delivered > 0 ? `Queued ${kind} for ${agent.id} and delivered via RPC bridge.` : `Queued ${kind} for ${agent.id}.`,
		"info",
	);
}

async function runStopFlow(ctx: ExtensionContext, agentId: string): Promise<void> {
	const choice = await ctx.ui.select("Stop mode:", ["Graceful stop", "Force stop", "Cancel"]);
	if (!choice || choice === "Cancel") return;
	const force = choice === "Force stop";
	const reason = await ctx.ui.input("Reason (optional):", "");
	const { agent, result } = await stopAgentById(agentId, force, reason?.trim() || undefined);
	ctx.ui.notify(formatStopResult(agent, result, force), force ? "warning" : "info");
}

function moveTaskById(taskId: string, params: { status: TaskState; reason?: string; waitingOn?: TaskWaitingOn; blockedReason?: string; reviewSummary?: string; finalSummary?: string; force?: boolean }): TaskRecord {
	const db = getTmuxAgentsDb();
	const task = getTask(db, taskId);
	if (!task) throw new Error(`Unknown task id \"${taskId}\".`);
	if (task.status === "done" && params.status !== "done" && !params.force) {
		throw new Error(`Task ${task.id} is already done. Pass force=true to reopen it.`);
	}
	const now = Date.now();
	updateTask(db, taskId, {
		status: params.status,
		waitingOn: params.status === "blocked" ? params.waitingOn ?? task.waitingOn : null,
		blockedReason: params.status === "blocked" ? params.blockedReason ?? task.blockedReason : null,
		reviewSummary: params.reviewSummary !== undefined ? params.reviewSummary : params.status === "in_review" ? task.reviewSummary : task.reviewSummary,
		finalSummary: params.finalSummary !== undefined ? params.finalSummary : params.status === "done" ? task.finalSummary : task.finalSummary,
		updatedAt: now,
		startedAt: params.status === "in_progress" ? task.startedAt ?? now : task.startedAt,
		reviewRequestedAt: params.status === "in_review" ? task.reviewRequestedAt ?? now : params.status === "todo" ? null : task.reviewRequestedAt,
		finishedAt: params.status === "done" ? task.finishedAt ?? now : null,
	});
	createTaskEvent(db, {
		id: randomUUID(),
		taskId,
		eventType: "state_changed",
		summary: params.reason?.trim() || `Moved to ${params.status}`,
		payload: {
			from: task.status,
			to: params.status,
			waitingOn: params.waitingOn ?? null,
			blockedReason: params.blockedReason ?? null,
		},
		createdAt: now,
	});
	return getTask(db, taskId)!;
}

async function runTaskCreateWizard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<TaskRecord | null> {
	if (!ctx.hasUI) return null;
	const title = await ctx.ui.input("Task title:", "new task");
	if (!title?.trim()) return null;
	const summary = await ctx.ui.input("Task summary (optional):", "");
	const description = await ctx.ui.editor("Task description (optional):", "");
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return null;
	const status = (await ctx.ui.select("Initial task status:", ["todo", "blocked", "in_progress", "in_review", "done"])) as TaskState | null;
	if (!status) return null;
	const autonomousStart = status === "todo" ? await ctx.ui.confirm("Autonomous start", "Launch an appropriate child agent for this ready todo task now?") : false;
	const requestedProfile = autonomousStart ? (await ctx.ui.input("Requested profile override (optional):", ""))?.trim() || undefined : undefined;
	const roleHint = autonomousStart ? (await ctx.ui.input("Role hint (optional: planning, implementation, review):", ""))?.trim() || undefined : undefined;
	const created = createTaskFromParams(ctx, {
		title: title.trim(),
		summary: summary?.trim() || undefined,
		description: description?.trim() || undefined,
		cwd: cwd.trim(),
		status,
		autonomousStart,
		requestedProfile,
		roleHint,
	});
	let launched: SpawnSubagentResult | null = null;
	if (autonomousStart) launched = maybeAutonomousLaunchTask(pi, ctx, created);
	ctx.ui.notify(launched ? `Created task ${created.id} and spawned ${launched.agentId}.` : `Created task ${created.id}.`, "info");
	return launched ? getTask(getTmuxAgentsDb(), created.id) ?? created : created;
}

async function runNeedsHumanOpenFlow(ctx: ExtensionContext, needsHumanId: string): Promise<void> {
	const db = getTmuxAgentsDb();
	const item = listTaskNeedsHuman(db, { ids: [needsHumanId], limit: 1 })[0];
	if (!item) throw new Error(`Unknown task needs-human id \"${needsHumanId}\".`);
	const task = getTask(db, item.taskId);
	if (!task) throw new Error(`Task ${item.taskId} for needs-human row ${item.id} is missing.`);
	assertTaskNeedsHumanOpenable(item);
	if (item.state !== "acknowledged") {
		markTaskNeedsHumanResponse(item, "acknowledged", "opened", "Needs-human item opened from board queue.");
		createTaskEvent(db, { id: randomUUID(), taskId: task.id, agentId: item.agentId, eventType: "needs_human_opened", summary: "Needs-human item opened from board queue.", payload: { needsHumanId: item.id, sourceMessageId: item.sourceMessageId ?? null } });
	}
	const agent = getAgent(db, item.agentId);
	const latest = listMessagesForRecipient(db, item.agentId, { includeDelivered: true, limit: 1 })[0];
	await ctx.ui.editor(`Needs-human ${item.id}`, [
		`Needs-human: ${item.id}`,
		`Task: ${task.id} · ${task.title}`,
		`Status: ${task.status} · waiting: ${task.waitingOn ?? "-"} · priority: ${task.priority}`,
		`Agent: ${item.agentId}${agent ? ` · ${agent.profile} · ${agent.state}` : ""}`,
		`Kind: ${item.kind}/${item.category} · state: ${item.state} · waiting: ${item.waitingOn ?? "-"}`,
		`Summary: ${item.summary}`,
		`Prompt: ${item.responsePrompt ?? "-"}`,
		`Blocked: ${task.blockedReason ?? "-"}`,
		`Review: ${task.reviewSummary ?? "-"}`,
		`Latest message: ${latest ? `${latest.kind} · ${JSON.stringify(latest.payload).slice(0, 1200)}` : "-"}`,
		"",
		"Routes: R respond, d defer, A approve review, J reject review, o focus, c capture.",
	].join("\n"));
}

async function runNeedsHumanRespondFlow(ctx: ExtensionContext, needsHumanId: string): Promise<void> {
	const mode = await ctx.ui.select("Response route:", ["combined", "task_patch", "child_message"]);
	if (!mode) return;
	const summary = await ctx.ui.input("Response summary:", "");
	if (!summary?.trim()) return;
	const result = await respondToTaskNeedsHuman({ needsHumanId, mode: mode as "combined" | "task_patch" | "child_message", summary: summary.trim() });
	ctx.ui.notify(`Responded to ${needsHumanId}; patched=${result.patched}; message=${result.messageId ?? "none"}.`, "info");
}

async function runNeedsHumanDeferFlow(ctx: ExtensionContext, needsHumanId: string): Promise<void> {
	const item = listTaskNeedsHuman(getTmuxAgentsDb(), { ids: [needsHumanId], limit: 1 })[0];
	if (!item) throw new Error(`Unknown task needs-human id \"${needsHumanId}\".`);
	assertTaskNeedsHumanOpenable(item);
	const reason = await ctx.ui.input("Defer note (optional):", "Deferred from board queue.");
	markTaskNeedsHumanResponse(item, "acknowledged", "deferred", reason?.trim() || "Deferred from board queue.");
	ctx.ui.notify(`Deferred ${needsHumanId}.`, "info");
}

function assertNeedsHumanReviewActionAllowed(item: TaskNeedsHumanRecord, action: "approve" | "reject"): void {
	if (item.category !== "review_gate" && item.kind !== "complete") {
		throw new Error(`Cannot ${action} needs-human row ${item.id} because it is ${item.kind}/${item.category}; use respond or defer instead.`);
	}
}

async function runNeedsHumanReviewFlow(ctx: ExtensionContext, needsHumanId: string, approved: boolean): Promise<void> {
	const item = listTaskNeedsHuman(getTmuxAgentsDb(), { ids: [needsHumanId], limit: 1 })[0];
	if (!item) throw new Error(`Unknown task needs-human id \"${needsHumanId}\".`);
	assertNeedsHumanReviewActionAllowed(item, approved ? "approve" : "reject");
	const summary = approved ? "Review approved from needs-human queue." : ((await ctx.ui.input("Reject reason:", "Changes requested."))?.trim() || "Changes requested.");
	await respondToTaskNeedsHuman({
		needsHumanId,
		mode: "task_patch",
		kind: approved ? "answer" : "redirect",
		summary,
		patch: approved ? { status: "done", finalSummary: summary } : { status: "in_progress", reviewSummary: summary },
		resolution: approved ? "resolved" : "superseded",
	});
	ctx.ui.notify(`${approved ? "Approved" : "Rejected"} ${needsHumanId}.`, approved ? "info" : "warning");
}

async function runTaskMoveFlow(ctx: ExtensionContext, taskId: string): Promise<void> {
	const task = getTask(getTmuxAgentsDb(), taskId);
	if (!task) throw new Error(`Unknown task id \"${taskId}\".`);
	const status = (await ctx.ui.select("Move task to:", ["todo", "blocked", "in_progress", "in_review", "done"])) as TaskState | null;
	if (!status) return;
	let waitingOn: TaskWaitingOn | undefined;
	let blockedReason: string | undefined;
	if (status === "blocked") {
		const selectedWaitingOn = (await ctx.ui.select("Waiting on:", ["user", "coordinator", "service", "external"])) as TaskWaitingOn | null;
		waitingOn = selectedWaitingOn ?? undefined;
		blockedReason = (await ctx.ui.input("Blocked reason:", task.blockedReason ?? ""))?.trim() || undefined;
	}
	const reason = await ctx.ui.input("Move reason (optional):", "");
	const moved = moveTaskById(taskId, {
		status,
		reason: reason?.trim() || undefined,
		waitingOn,
		blockedReason,
		force: true,
	});
	ctx.ui.notify(`Moved ${moved.id} to ${moved.status}.`, "info");
}

async function runTaskSpawnWizard(pi: ExtensionAPI, ctx: ExtensionContext, taskId?: string): Promise<void> {
	if (!ctx.hasUI) return;
	const gateItems = listAttentionItems(getTmuxAgentsDb(), resolveAttentionFilters(ctx, "current_project", { limit: 5 }));
	if (gateItems.length > 0) {
		const gateAgents = new Map(listAgents(getTmuxAgentsDb(), { projectKey: getProjectKey(ctx.cwd), limit: 100 }).map((agent) => [agent.id, agent]));
		const ok = await ctx.ui.confirm("Open attention items", `${formatAttentionGateWarning(gateItems, gateAgents)}\n\nSpawn anyway?`);
		if (!ok) return;
	}
	const linkedTask = taskId ? getTask(getTmuxAgentsDb(), taskId) : null;
	const profile = await chooseProfile(ctx);
	if (!profile) return;
	const title = await ctx.ui.input("Child title:", linkedTask?.title ?? `${profile.name} task`);
	if (!title?.trim()) return;
	const task = await ctx.ui.editor("Child task:", linkedTask?.description ?? linkedTask?.summary ?? "");
	if (!task?.trim()) return;
	const cwd = await ctx.ui.input("Working directory:", linkedTask?.spawnCwd ?? ctx.cwd);
	if (!cwd?.trim()) return;
	const selectedTaskId = taskId ?? ((await ctx.ui.input("Existing task id (optional, blank = auto-create):", ""))?.trim() || undefined);
	try {
		const result = spawnChildFromParams(pi, ctx, {
			title: title.trim(),
			task: task.trim(),
			profile: profile.name,
			taskId: selectedTaskId,
			cwd: cwd.trim(),
		});
		ctx.ui.notify(`Spawned ${result.agentId} in tmux ${result.tmuxSessionName}.`, "info");
		await ctx.ui.editor(`Spawned ${result.agentId}`, formatSpawnSuccess(result));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

async function runAgentsDashboard(pi: ExtensionAPI, ctx: ExtensionContext, initialState: AgentsDashboardState): Promise<AgentsDashboardState> {
	let state = initialState;
	while (ctx.hasUI) {
		const action = await openAgentsDashboard(ctx, () => buildDashboardData(ctx), state, 5000);
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
					const result = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					ctx.ui.notify(formatReconcileResult(result), "info");
					break;
				}
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

async function runAgentsBoard(pi: ExtensionAPI, ctx: ExtensionContext, initialState: AgentsBoardState): Promise<AgentsBoardState> {
	let state = initialState;
	while (ctx.hasUI) {
		const action = await openAgentsBoard(ctx, () => buildBoardData(ctx), state, 5000);
		if (!action || action.type === "close") return action?.state ?? state;
		state = action.state;
		const selectedId = action.selectedId;
		if (!selectedId && !["spawn", "sync", "create"].includes(action.type)) continue;
		try {
			switch (action.type) {
				case "attention_open":
					await runNeedsHumanOpenFlow(ctx, selectedId!);
					break;
				case "attention_respond":
					await runNeedsHumanRespondFlow(ctx, selectedId!);
					break;
				case "attention_defer":
					await runNeedsHumanDeferFlow(ctx, selectedId!);
					break;
				case "attention_approve":
					await runNeedsHumanReviewFlow(ctx, selectedId!, true);
					break;
				case "attention_reject":
					await runNeedsHumanReviewFlow(ctx, selectedId!, false);
					break;
				case "inspect": {
					const task = getTask(getTmuxAgentsDb(), selectedId!);
					if (task) await ctx.ui.editor(`Task ${task.id}`, formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [task.id], limit: 20 })));
					break;
				}
				case "focus": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Focus");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					const { result } = focusAgentById(agent.id);
					lastFocusedActiveAgentId = agent.id;
					ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
					break;
				}
				case "stop": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Stop");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					await runStopFlow(ctx, agent.id);
					break;
				}
				case "reply": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Reply");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					await runReplyFlow(ctx, agent.id);
					break;
				}
				case "capture": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Capture");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					const capture = captureAgentById(agent.id, 200);
					await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
					break;
				}
				case "spawn":
					await runTaskSpawnWizard(pi, ctx, selectedId || undefined);
					break;
				case "move":
					await runTaskMoveFlow(ctx, selectedId!);
					break;
				case "create":
					await runTaskCreateWizard(pi, ctx);
					break;
				case "sync": {
					const taskResult = reconcileTasks(getTmuxAgentsDb(), resolveTaskFilters(ctx, state.scope, { includeDone: true, limit: 200 }));
					const agentResult = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					ctx.ui.notify(`Tasks: ${taskResult.backfilled} backfilled, ${taskResult.needsHumanBackfilled} needs-human backfilled, ${taskResult.linkPointersRepaired + taskResult.agentTaskPointersRepaired} pointers repaired, ${taskResult.deactivatedLinks} links deactivated.\n${formatReconcileResult(agentResult)}`, "info");
					break;
				}
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
	await runTaskSpawnWizard(pi, ctx);
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
	}

	let dashboardState: AgentsDashboardState = {
		scope: "current_project",
		sort: "priority",
		activeOnly: false,
		blockedOnly: false,
		unreadOnly: false,
	};
	let boardState: AgentsBoardState = {
		scope: "current_project",
		mode: "tasks",
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
			"Prefer attaching the child to an existing taskId. If taskId is omitted, a new task is auto-created.",
			"Before spawning more work, inspect unresolved attention with subagent_attention and handle blockers/questions first when appropriate.",
			"Pick the most appropriate profile and keep the delegated task narrowly scoped.",
			"For writing implementation agents, pass workspaceStrategy=dedicated_worktree and omit cwd; dedicated worktree spawns reject explicit cwd and run in the deterministic task worktree. Pass workspaceStrategy=spawn_cwd to intentionally opt out of task worktree inheritance.",
			"Do not pass `find` in tool overrides. Use `grep` and `bash` with `rg --files` instead.",
		],
		parameters: SubagentSpawnParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const gateItems = listAttentionItems(getTmuxAgentsDb(), resolveAttentionFilters(ctx, "current_project", { limit: 5 }));
			const gateAgents = new Map(listAgents(getTmuxAgentsDb(), { projectKey: getProjectKey(ctx.cwd), limit: 100 }).map((agent) => [agent.id, agent]));
			const result = spawnChildFromParams(pi, ctx, params);
			const warning = formatAttentionGateWarning(gateItems, gateAgents);
			return {
				content: [{ type: "text", text: `${warning ? `${warning}\n\n` : ""}${formatSpawnSuccess(result)}` }],
				details: { result, attentionGate: gateItems },
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
			const { agent, result } = await stopAgentById(params.id, params.force ?? false, params.reason);
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
		description: "Send a structured control-plane message to a tracked child agent.",
		promptSnippet: "Send structured answer, note, redirect, cancel, or priority updates to a tracked child agent, with an explicit action policy when useful.",
		promptGuidelines: [
			"Use subagent_message to answer child questions, redirect work, cancel, or change priority.",
			"Prefer messages plus child publish updates over transcript capture for normal orchestration.",
			"Keep the message concrete and minimal, with exact file paths when relevant.",
			"Use actionPolicy when you need the child to replan, resume, or stop instead of merely reading the note.",
			"When replying to a specific child blocker/question, include inReplyToMessageId when available from subagent_inbox or subagent_get.",
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
			const kind = params.kind as "answer" | "note" | "redirect" | "cancel" | "priority";
			const actionPolicy = params.actionPolicy ?? defaultDownwardActionPolicy(kind);
			queueDownwardMessage(
				agent,
				kind,
				{
					summary: params.summary,
					details: params.details,
					files: params.files,
					actionPolicy,
					inReplyToMessageId: params.inReplyToMessageId,
				},
				params.deliveryMode ?? "immediate",
			);
			const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
			updateFleetUi(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							liveDelivery.delivered > 0
								? `Queued ${kind} message for ${agent.id} (${actionPolicy}) and delivered ${liveDelivery.delivered} via RPC bridge.`
								: `Queued ${kind} message for ${agent.id} (${actionPolicy}).`,
					},
				],
				details: {
					agentId: agent.id,
					kind,
					actionPolicy,
					inReplyToMessageId: params.inReplyToMessageId ?? null,
					deliveryMode: params.deliveryMode ?? "immediate",
					liveDelivery,
				},
			};
		},
	});

	pi.registerTool({
		name: "subagent_capture",
		label: "Subagent Capture",
		description: "Debug-only: capture recent tmux pane output for a tracked child agent.",
		promptSnippet: "Debug a tracked subagent by capturing recent tmux pane output only when structured reporting is insufficient.",
		promptGuidelines: [
			"Prefer subagent_attention, subagent_inbox, subagent_get, and subagent_message for normal orchestration.",
			"Use subagent_capture only when child reporting is stale, missing, or clearly inconsistent and you need raw transcript context.",
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
			const result = await reconcileAgents(ctx, params);
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
		name: "subagent_attention",
		label: "Subagent Attention",
		description: "List open attention items derived from child questions, blockers, and completions.",
		promptSnippet: "List open attention items for coordinator or user triage.",
		promptGuidelines: [
			"Use subagent_attention before spawning more work or giving a confident status answer when child questions, blockers, or completions may be pending.",
			"Prefer this over raw inbox reads when you need the unresolved queue rather than low-level mailbox rows.",
		],
		parameters: SubagentAttentionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveAttentionFilters(ctx, scope, params);
			const items = listAttentionItems(getTmuxAgentsDb(), filters);
			const agentsById = new Map(
				listAgents(getTmuxAgentsDb(), { ids: [...new Set(items.map((item) => item.agentId))], limit: 200 }).map((agent) => [agent.id, agent]),
			);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildAttentionText(items, agentsById, params.includeResolved ?? false) }],
				details: { scope, filters, items },
			};
		},
	});

	pi.registerTool({
		name: "subagent_cleanup",
		label: "Subagent Cleanup",
		description: "Remove finished child tmux targets after their work has been completed and synthesized.",
		promptSnippet: "Clean up terminal child tmux windows that no longer need to remain open.",
		promptGuidelines: [
			"Use subagent_cleanup after completion has been reviewed or synthesized so old tmux windows do not accumulate.",
			"Prefer dryRun=true first when you are unsure which agents are eligible.",
			"Do not clean blocked or question-bearing agents unless force=true is intentional.",
		],
		parameters: SubagentCleanupParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { id?: string; ids?: string[] };
			if (typeof input.id === "string" && !Array.isArray(input.ids)) {
				return { ids: [input.id] };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const candidates = listCleanupCandidates(ctx, params);
			const dryRun = params.dryRun ?? false;
			if (dryRun) {
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatCleanupCandidates(candidates, true) }],
					details: { candidates, dryRun: true },
				};
			}
			const ready = candidates.filter((candidate) => candidate.cleanupAllowed);
			const skipped = candidates.filter((candidate) => !candidate.cleanupAllowed);
			const results = ready.map((candidate) => cleanupAgentTarget(candidate, params.force ?? false));
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatCleanupResults(results, skipped) }],
				details: { candidates, results, skipped, dryRun: false },
			};
		},
	});

	pi.registerTool({
		name: "task_create",
		label: "Task Create",
		description: "Create a tracked task ticket for the task-first board and orchestration flow.",
		promptSnippet: "Create a task ticket before delegation so the board tracks work instead of agent instances.",
		promptGuidelines: [
			"Create or select a task before spawning subagents for new work.",
			"Use blocked + waitingOn instead of creating separate waiting swim lanes.",
		],
		parameters: TaskCreateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = createTaskFromParams(ctx, params);
			const launched = params.autonomousStart || params.launchPolicy === "autonomous" ? maybeAutonomousLaunchTask(pi, ctx, task) : null;
			const currentTask = getTask(getTmuxAgentsDb(), task.id) ?? task;
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: launched ? `${formatTaskDetails(currentTask)}\n\nspawnedAgent: ${launched.agentId}` : formatTaskDetails(currentTask) }],
				details: { task: currentTask, launched },
			};
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "Task List",
		description: "List tracked task tickets from the task-first board.",
		promptSnippet: "List tasks by scope, status, waiting-on target, and sort order.",
		promptGuidelines: [
			"Use task_list before spawning new work when you need to see whether a task already exists.",
			"Prefer current_project or current_session scope unless the user asks for a global view.",
		],
		parameters: TaskListParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { id?: string; ids?: string[] };
			if (typeof input.id === "string" && !Array.isArray(input.ids)) {
				return { ids: [input.id] };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, {
				statuses: params.statuses as TaskState[] | undefined,
				waitingOn: params.waitingOn as TaskWaitingOn[] | undefined,
				includeDone: params.includeDone,
				limit: params.limit,
				linkedAgentId: params.linkedAgentId,
			});
			if (params.ids && params.ids.length > 0) filters.ids = params.ids;
			const tasks = sortTasksForList(listTasks(getTmuxAgentsDb(), filters), (params.sort ?? "priority") as "priority" | "updated" | "created" | "title" | "status");
			const links = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds: tasks.map((task) => task.id), activeOnly: true, limit: 500 });
			const agents = listAgents(getTmuxAgentsDb(), { ids: [...new Set(links.map((link) => link.agentId))], limit: 500 });
			const agentsByTask = new Map<string, AgentSummary[]>();
			const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
			for (const link of links) {
				const agent = agentsById.get(link.agentId);
				if (!agent) continue;
				const existing = agentsByTask.get(link.taskId) ?? [];
				existing.push(agent);
				agentsByTask.set(link.taskId, existing);
			}
			const header = `scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
			const body = tasks.length === 0 ? "No tasks matched." : tasks.map((task) => formatTaskLine(task, agentsByTask.get(task.id) ?? [])).join("\n");
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${header}\n\n${body}` }],
				details: { scope, filters, tasks },
			};
		},
	});

	pi.registerTool({
		name: "task_get",
		label: "Task Get",
		description: "Inspect one or more tracked tasks in detail.",
		promptSnippet: "Get full task details including acceptance criteria, plan steps, linked agents, and recent events.",
		promptGuidelines: [
			"Use task_get after task_list when you need full task context or recent event history.",
		],
		parameters: TaskGetParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { id?: string; ids?: string[] };
			if (typeof input.id === "string" && !Array.isArray(input.ids)) {
				return { ids: [input.id] };
			}
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const tasks = params.ids.map((id) => getTask(getTmuxAgentsDb(), id)).filter((task): task is TaskRecord => task !== null);
			const links = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds: tasks.map((task) => task.id), activeOnly: true, limit: 500 });
			const agents = listAgents(getTmuxAgentsDb(), { ids: [...new Set(links.map((link) => link.agentId))], limit: 500 });
			const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
			const agentsByTask = new Map<string, AgentSummary[]>();
			for (const link of links) {
				const agent = agentsById.get(link.agentId);
				if (!agent) continue;
				const existing = agentsByTask.get(link.taskId) ?? [];
				existing.push(agent);
				agentsByTask.set(link.taskId, existing);
			}
			const eventsByTask = new Map<string, ReturnType<typeof listTaskEvents>>();
			if (params.includeEvents ?? true) {
				for (const task of tasks) {
					eventsByTask.set(task.id, listTaskEvents(getTmuxAgentsDb(), { taskIds: [task.id], limit: params.eventLimit ?? 20 }));
				}
			}
			const text = tasks.length === 0 ? "No matching tasks found." : tasks.map((task) => formatTaskDetails(task, agentsByTask.get(task.id) ?? [], eventsByTask.get(task.id) ?? [])).join("\n\n---\n\n");
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text }],
				details: { tasks },
			};
		},
	});

	pi.registerTool({
		name: "task_update",
		label: "Task Update",
		description: "Patch task metadata such as summary, acceptance criteria, plan steps, labels, or files.",
		promptSnippet: "Update the non-state metadata of a tracked task.",
		promptGuidelines: [
			"Use task_update to refine ticket contents without necessarily changing its board column.",
		],
		parameters: TaskUpdateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = getTask(getTmuxAgentsDb(), params.id);
			if (!task) throw new Error(`Unknown task id \"${params.id}\".`);
			const patch: UpdateTaskInput = {
				title: params.title,
				summary: params.summary,
				description: params.description,
				parentTaskId: params.parentTaskId,
				priority: params.priority,
				priorityLabel: params.priorityLabel,
				acceptanceCriteria: params.acceptanceCriteria,
				planSteps: params.planSteps,
				validationSteps: params.validationSteps,
				labels: params.labels,
				files: params.files,
				blockedReason: params.blockedReason,
				waitingOn: params.waitingOn as TaskWaitingOn | undefined,
				requestedProfile: params.requestedProfile,
				assignedProfile: params.assignedProfile,
				launchPolicy: params.launchPolicy as TaskLaunchPolicy | undefined,
				promptTemplate: params.promptTemplate,
				roleHint: params.roleHint,
				workspaceStrategy: params.workspaceStrategy === undefined ? undefined : params.workspaceStrategy as TaskWorkspaceStrategy | null,
				worktreeId: normalizeNullableMetadataString(params.worktreeId),
				worktreeCwd: resolveNullableInputPath(task.spawnCwd, params.worktreeCwd),
				reviewSummary: params.reviewSummary,
				finalSummary: params.finalSummary,
				updatedAt: Date.now(),
			};
			updateTask(getTmuxAgentsDb(), params.id, patch);
			createTaskEvent(getTmuxAgentsDb(), {
				id: randomUUID(),
				taskId: params.id,
				eventType: "updated",
				summary: `Updated task ${task.title}`,
				payload: patch,
			});
			const updated = getTask(getTmuxAgentsDb(), params.id)!;
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatTaskDetails(updated, getTaskLinkedAgents(updated.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [updated.id], limit: 10 })) }],
				details: { task: updated },
			};
		},
	});

	pi.registerTool({
		name: "task_move",
		label: "Task Move",
		description: "Move a tracked task between board columns.",
		promptSnippet: "Move a task to todo, blocked, in_progress, in_review, or done with optional blockers or review summaries.",
		promptGuidelines: [
			"Use task_move for persistent board state transitions.",
			"Use blocked + waitingOn instead of introducing extra swim lanes.",
		],
		parameters: TaskMoveParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const moved = moveTaskById(params.id, {
				status: params.status as TaskState,
				reason: params.reason,
				waitingOn: params.waitingOn as TaskWaitingOn | undefined,
				blockedReason: params.blockedReason,
				reviewSummary: params.reviewSummary,
				finalSummary: params.finalSummary,
				force: params.force,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatTaskDetails(moved, getTaskLinkedAgents(moved.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [moved.id], limit: 10 })) }],
				details: { task: moved },
			};
		},
	});

	pi.registerTool({
		name: "task_note",
		label: "Task Note",
		description: "Append a structured task-level note or handoff event.",
		promptSnippet: "Add a note to the task history without changing board state.",
		parameters: TaskNoteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = getTask(getTmuxAgentsDb(), params.id);
			if (!task) throw new Error(`Unknown task id \"${params.id}\".`);
			createTaskEvent(getTmuxAgentsDb(), {
				id: randomUUID(),
				taskId: params.id,
				eventType: "note",
				summary: params.summary,
				payload: { details: params.details ?? null, files: params.files ?? [] },
			});
			updateTask(getTmuxAgentsDb(), params.id, { updatedAt: Date.now(), files: params.files ? [...new Set([...task.files, ...params.files])] : task.files });
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `Added note to ${task.id}: ${params.summary}` }],
				details: { taskId: task.id },
			};
		},
	});

	pi.registerTool({
		name: "task_link_agent",
		label: "Task Link Agent",
		description: "Link an existing agent to a tracked task.",
		promptSnippet: "Attach an agent to a task so the board reflects task ownership and execution.",
		parameters: TaskLinkAgentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const link = linkTaskAgent(getTmuxAgentsDb(), {
				taskId: params.taskId,
				agentId: params.agentId,
				role: params.role,
				isActive: params.active,
			});
			if (params.active ?? true) {
				updateTask(getTmuxAgentsDb(), params.taskId, { status: "in_progress", waitingOn: null, blockedReason: null, updatedAt: Date.now() });
			}
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `Linked ${link.agentId} to ${link.taskId} as ${link.role}.` }],
				details: { link },
			};
		},
	});

	pi.registerTool({
		name: "task_unlink_agent",
		label: "Task Unlink Agent",
		description: "Unlink an agent from a tracked task.",
		promptSnippet: "Remove the active task/agent link when execution ownership changes.",
		parameters: TaskUnlinkAgentParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const changes = unlinkTaskAgent(getTmuxAgentsDb(), params.taskId, params.agentId, params.reason);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: changes > 0 ? `Unlinked ${params.agentId} from ${params.taskId}.` : `No active link found for ${params.agentId} on ${params.taskId}.` }],
				details: { taskId: params.taskId, agentId: params.agentId, changes },
			};
		},
	});

	pi.registerTool({
		name: "task_attention",
		label: "Task Attention",
		description: "List per task/agent needs-human queue rows that need coordinator, user, service, external, or review attention.",
		promptSnippet: "List task-agent unresolved needs-human rows with payload needed to respond or open the source message.",
		promptGuidelines: [
			"Use task_attention as the task-first unresolved queue.",
			"Use task_response_open to acknowledge and inspect one row before responding when needed.",
			"Use task_respond to route a response as task_patch, child_message, or combined without relying on pane capture.",
		],
		parameters: TaskAttentionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
			const db = getTmuxAgentsDb();
			const items = listTaskAttention(db, { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: params.limit });
			const agentsById = new Map(listAgents(db, { limit: 500 }).map((agent) => [agent.id, agent]));
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildTaskAttentionText(items, agentsById) }],
				details: { scope, items },
			};
		},
	});

	pi.registerTool({
		name: "task_response_open",
		label: "Task Response Open",
		description: "Open and optionally acknowledge a task needs-human queue item before responding.",
		promptSnippet: "Inspect a task_needs_human row by id and optionally mark it acknowledged.",
		promptGuidelines: [
			"Use needsHumanId from task_attention.",
			"Set acknowledge=false when you only want a read-only lookup.",
		],
		parameters: TaskOpenResponseParams,
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const db = getTmuxAgentsDb();
			const item = listTaskNeedsHuman(db, { ids: [params.needsHumanId], limit: 1 })[0];
			if (!item) throw new Error(`Unknown task needs-human id "${params.needsHumanId}".`);
			const task = getTask(db, item.taskId);
			if (!task) throw new Error(`Task ${item.taskId} for needs-human row ${item.id} is missing.`);
			assertTaskNeedsHumanOpenable(item);
			if ((params.acknowledge ?? true) && item.state !== "acknowledged") {
				markTaskNeedsHumanResponse(item, "acknowledged", "opened", "Needs-human item opened for response.");
				createTaskEvent(db, {
					id: randomUUID(),
					taskId: task.id,
					agentId: item.agentId,
					eventType: "needs_human_opened",
					summary: "Needs-human item opened for response.",
					payload: { needsHumanId: item.id, sourceMessageId: item.sourceMessageId ?? null },
				});
			}
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${params.acknowledge ?? true ? "Acknowledged" : "Opened"} ${item.id} for task ${task.id}: ${item.summary}` }],
				details: { item: listTaskNeedsHuman(db, { ids: [item.id], limit: 1 })[0] ?? item, task },
			};
		},
	});

	pi.registerTool({
		name: "task_respond",
		label: "Task Respond",
		description: "Respond to a task needs-human row by patching task metadata, messaging the child, or doing both in order.",
		promptSnippet: "Route a needs-human response as task_patch, child_message, or combined. Combined applies patch first then queues a concise child message.",
		promptGuidelines: [
			"Use mode=task_patch to update acceptanceCriteria, planSteps, files, priority, status, waitingOn, etc. without sending a child message.",
			"Use mode=child_message to send answer/note/redirect/cancel/priority to the linked child with inReplyToMessageId inferred from the queue row.",
			"Use mode=combined to patch the task first, then send a concise child message telling the child what changed.",
			"Use resolution=acknowledged only with mode=task_patch; child_message and combined require resolved/cancelled/superseded so duplicates cannot queue another child message.",
			"For blockers, answer defaults to resume_if_blocked and can move the task back to in_progress.",
			"For completion/review gates, a patch-less response defaults to marking the task done.",
		],
		parameters: TaskRespondParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = await respondToTaskNeedsHuman(params);
			updateFleetUi(ctx);
			const route = inferTaskResponseMode(result.item, params);
			const delivered = result.liveDelivery ? ` · delivered=${result.liveDelivery.delivered}` : "";
			return {
				content: [{ type: "text", text: `Responded to ${params.needsHumanId} via ${route}; resolution=${result.resolution}; patched=${result.patched}; message=${result.messageId ?? "none"}${delivered}.` }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "task_reconcile",
		label: "Task Reconcile",
		description: "Backfill or repair task records and task-agent links.",
		promptSnippet: "Reconcile task records, legacy backfills, and task-agent links.",
		parameters: TaskReconcileParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
			const result = reconcileTasks(getTmuxAgentsDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: params.limit });
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `Reconciled tasks · ${result.backfilled} tasks backfilled · ${result.needsHumanBackfilled} needs-human rows backfilled · ${result.needsHumanResolved} needs-human rows resolved · ${result.linkPointersRepaired + result.agentTaskPointersRepaired} link pointers repaired · ${result.deactivatedLinks} links deactivated.` }],
				details: { scope, result },
			};
		},
	});

	pi.registerTool({
		name: "task_worktree_cleanup",
		label: "Task Worktree Cleanup",
		description: "Preview or explicitly remove eligible dedicated task git worktrees after tasks are done. Branches are never deleted.",
		promptSnippet: "Preview task-linked worktree cleanup, then pass remove=true and dryRun=false to remove eligible dedicated done-task worktrees only.",
		promptGuidelines: [
			"Prefer dryRun=true first to show active/reusable/stale/ready-cleanup status.",
			"Cleanup only removes dedicated_worktree git worktree checkouts for done tasks with no active linked agents.",
			"existing_worktree, spawn_cwd, inherited, dirty, missing, conflicting, and active worktrees are preserved/skipped by default.",
			"This tool never deletes git branches; branch deletion is a separate manual operator decision after review.",
		],
		parameters: TaskWorktreeCleanupParams,
		execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const candidates = listTaskWorktreeCleanupCandidates(ctx, params);
			const dryRun = params.dryRun ?? true;
			if (dryRun || !params.remove) {
				return {
					content: [{ type: "text", text: formatTaskWorktreeCleanupCandidates(candidates, true) }],
					details: { candidates, dryRun: true, remove: params.remove ?? false },
				};
			}
			const ready = candidates.filter((candidate) => candidate.eligible);
			const skipped = candidates.filter((candidate) => !candidate.eligible);
			const results = ready.map((candidate) => cleanupTaskWorktree(candidate, params.force ?? false));
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatTaskWorktreeCleanupResults(results, skipped) }],
				details: { candidates, results, skipped, dryRun: false, remove: true },
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

	pi.registerCommand("task-board", {
		description: "Open the tracked task Kanban board",
		handler: async (_args, ctx) => {
			boardState = await runAgentsBoard(pi, ctx, boardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("needs-human", {
		description: "Open the task-first needs-human queue on the task board",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) || boardState.scope || "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /needs-human [all|current_project|current_session|descendants]", "warning");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(buildNeedsHumanFallbackText(ctx, scope), "info");
				updateFleetUi(ctx);
				return;
			}
			boardState = await runAgentsBoard(pi, ctx, { ...boardState, scope, mode: "queue" });
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("tasks", {
		description: "List tracked tasks",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /tasks [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const tasks = listTasks(getTmuxAgentsDb(), filters);
			const text = `${`scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}${tasks.length === 0 ? "\n\nNo tasks matched." : `\n\n${tasks.map((task) => formatTaskLine(task, getTaskLinkedAgents(task.id))).join("\n")}`}`;
			if (ctx.hasUI) await ctx.ui.editor("tasks", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-new", {
		description: "Create a tracked task",
		handler: async (_args, ctx) => {
			const created = await runTaskCreateWizard(pi, ctx);
			if (created && ctx.hasUI) await ctx.ui.editor(`Task ${created.id}`, formatTaskDetails(created));
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-open", {
		description: "Inspect a tracked task by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /task-open <id>", "warning");
				return;
			}
			const task = getTask(getTmuxAgentsDb(), id);
			if (!task) {
				ctx.ui.notify(`Unknown task id \"${id}\".`, "error");
				return;
			}
			const text = formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [task.id], limit: 20 }));
			if (ctx.hasUI) await ctx.ui.editor(`Task ${task.id}`, text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-move", {
		description: "Move a tracked task to a new board state",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const id = parts[0];
			const status = parts[1] as TaskState | undefined;
			if (!id) {
				ctx.ui.notify("Usage: /task-move <id> [todo|blocked|in_progress|in_review|done]", "warning");
				return;
			}
			if (status && ["todo", "blocked", "in_progress", "in_review", "done"].includes(status)) {
				const moved = moveTaskById(id, { status, force: true });
				ctx.ui.notify(`Moved ${moved.id} to ${moved.status}.`, "info");
			} else if (ctx.hasUI) {
				await runTaskMoveFlow(ctx, id);
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-note", {
		description: "Append a note to a task",
		handler: async (args, ctx) => {
			const [id, ...rest] = args?.trim().split(/\s+/) ?? [];
			const summary = rest.join(" ").trim();
			if (!id || !summary) {
				ctx.ui.notify("Usage: /task-note <id> <message>", "warning");
				return;
			}
			const task = getTask(getTmuxAgentsDb(), id);
			if (!task) {
				ctx.ui.notify(`Unknown task id \"${id}\".`, "error");
				return;
			}
			createTaskEvent(getTmuxAgentsDb(), { id: randomUUID(), taskId: id, eventType: "note", summary });
			updateTask(getTmuxAgentsDb(), id, { updatedAt: Date.now() });
			ctx.ui.notify(`Added note to ${task.id}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-link-agent", {
		description: "Link an existing agent to a task",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const taskId = parts[0];
			const agentId = parts[1];
			const role = parts[2];
			if (!taskId || !agentId) {
				ctx.ui.notify("Usage: /task-link-agent <task-id> <agent-id> [role]", "warning");
				return;
			}
			const link = linkTaskAgent(getTmuxAgentsDb(), { taskId, agentId, role, isActive: true });
			updateTask(getTmuxAgentsDb(), taskId, { status: "in_progress", waitingOn: null, blockedReason: null, updatedAt: Date.now() });
			ctx.ui.notify(`Linked ${link.agentId} to ${link.taskId}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-unlink-agent", {
		description: "Unlink an agent from a task",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const taskId = parts[0];
			const agentId = parts[1];
			if (!taskId || !agentId) {
				ctx.ui.notify("Usage: /task-unlink-agent <task-id> <agent-id>", "warning");
				return;
			}
			const changes = unlinkTaskAgent(getTmuxAgentsDb(), taskId, agentId, "manual unlink");
			ctx.ui.notify(changes > 0 ? `Unlinked ${agentId} from ${taskId}.` : `No active link found for ${agentId} on ${taskId}.`, changes > 0 ? "info" : "warning");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-attention", {
		description: "List task-first needs-human queue rows",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /task-attention [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const text = buildNeedsHumanFallbackText(ctx, scope);
			if (ctx.hasUI) await ctx.ui.editor("task attention", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-response-open", {
		description: "Open and acknowledge a task needs-human queue row",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /task-response-open <needs-human-id>", "warning");
				return;
			}
			const item = listTaskNeedsHuman(getTmuxAgentsDb(), { ids: [id], limit: 1 })[0];
			if (!item) {
				ctx.ui.notify(`Unknown task needs-human id "${id}".`, "error");
				return;
			}
			try {
				assertTaskNeedsHumanOpenable(item);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}
			if (item.state !== "acknowledged") markTaskNeedsHumanResponse(item, "acknowledged", "opened", "Needs-human item opened for response.");
			const task = getTask(getTmuxAgentsDb(), item.taskId);
			if (task && item.state !== "acknowledged") {
				createTaskEvent(getTmuxAgentsDb(), { id: randomUUID(), taskId: task.id, agentId: item.agentId, eventType: "needs_human_opened", summary: "Needs-human item opened for response.", payload: { needsHumanId: item.id, sourceMessageId: item.sourceMessageId ?? null } });
			}
			ctx.ui.notify(`${item.state === "acknowledged" ? "Already acknowledged" : "Acknowledged"} ${item.id} for task ${item.taskId}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-respond", {
		description: "Respond to a task needs-human row; JSON supports mode, patch, kind, summary, details, resolution",
		handler: async (args, ctx) => {
			const raw = args?.trim() ?? "";
			const [id, ...rest] = raw.split(/\s+/);
			if (!id) {
				ctx.ui.notify("Usage: /task-respond <needs-human-id> [summary text | JSON object with mode/patch/kind/summary/resolution]; resolution=acknowledged only with mode=task_patch", "warning");
				return;
			}
			const body = rest.join(" ").trim();
			let params: Parameters<typeof respondToTaskNeedsHuman>[0] = { needsHumanId: id };
			if (body.startsWith("{")) {
				params = { needsHumanId: id, ...(JSON.parse(body) as Omit<Parameters<typeof respondToTaskNeedsHuman>[0], "needsHumanId">) };
			} else if (body) {
				params.summary = body;
			}
			const result = await respondToTaskNeedsHuman(params);
			ctx.ui.notify(`Responded to ${id}; resolution=${result.resolution}; message=${result.messageId ?? "none"}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-sync", {
		description: "Reconcile task records and task-agent links",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /task-sync [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const result = reconcileTasks(getTmuxAgentsDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: 200 });
			ctx.ui.notify(`Reconciled tasks · ${result.backfilled} backfilled · ${result.needsHumanBackfilled} needs-human backfilled · ${result.linkPointersRepaired + result.agentTaskPointersRepaired} pointers repaired · ${result.deactivatedLinks} links deactivated.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-worktree-cleanup", {
		description: "Preview or explicitly remove eligible done-task dedicated git worktrees",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const remove = parts.includes("remove") || parts.includes("--remove");
			const dryRun = !remove || parts.includes("dry-run") || parts.includes("--dry-run");
			const force = parts.includes("force") || parts.includes("--force");
			const scope = parts.find((part) => ["all", "current_project", "current_session", "descendants"].includes(part)) as "all" | "current_project" | "current_session" | "descendants" | undefined;
			const id = parts.find((part) => !["all", "current_project", "current_session", "descendants", "remove", "--remove", "dry-run", "--dry-run", "force", "--force"].includes(part));
			const candidates = listTaskWorktreeCleanupCandidates(ctx, { scope: scope ?? "current_project", ids: id ? [id] : undefined, force, limit: 200 });
			if (dryRun) {
				const text = formatTaskWorktreeCleanupCandidates(candidates, true);
				if (ctx.hasUI) await ctx.ui.editor("task worktree cleanup preview", text);
				else ctx.ui.notify(text, "info");
				return;
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Remove eligible task worktrees", `${formatTaskWorktreeCleanupCandidates(candidates, true)}\n\nProceed? Branches will not be deleted.`);
				if (!ok) return;
			}
			const ready = candidates.filter((candidate) => candidate.eligible);
			const skipped = candidates.filter((candidate) => !candidate.eligible);
			const results = ready.map((candidate) => cleanupTaskWorktree(candidate, force));
			const text = formatTaskWorktreeCleanupResults(results, skipped);
			if (ctx.hasUI) await ctx.ui.editor("task worktree cleanup", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-spawn", {
		description: "Spawn a child agent against a task",
		handler: async (args, ctx) => {
			const id = args?.trim();
			await runTaskSpawnWizard(pi, ctx, id || undefined);
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
				const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
				ctx.ui.notify(
					liveDelivery.delivered > 0 ? `Queued ${kind} for ${id} and delivered via RPC bridge.` : `Queued ${kind} for ${id}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-capture", {
		description: "Debug-capture recent tmux pane output for a tracked child",
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
				const { agent, result } = await stopAgentById(id, force);
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
				const result = await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 });
				updateFleetUi(ctx);
				ctx.ui.notify(formatReconcileResult(result), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-attention", {
		description: "List unresolved subagent attention items",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /agent-attention [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveAttentionFilters(ctx, scope, { limit: 200 });
			const items = listAttentionItems(getTmuxAgentsDb(), filters);
			const agentsById = new Map(
				listAgents(getTmuxAgentsDb(), { ids: [...new Set(items.map((item) => item.agentId))], limit: 200 }).map((agent) => [agent.id, agent]),
			);
			const text = buildAttentionText(items, agentsById, false);
			if (ctx.hasUI) await ctx.ui.editor("subagent attention", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-cleanup", {
		description: "Clean up completed/terminal child tmux targets",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const force = parts.includes("force") || parts.includes("--force");
			const scope = parts.find((part) => ["all", "current_project", "current_session", "descendants"].includes(part)) as
				| "all"
				| "current_project"
				| "current_session"
				| "descendants"
				| undefined;
			const id = parts.find((part) => !["all", "current_project", "current_session", "descendants", "force", "--force"].includes(part));
			if (parts.length > 0 && !scope && !id && !force) {
				ctx.ui.notify("Usage: /agent-cleanup [<id>|all|current_project|current_session|descendants] [force]", "warning");
				return;
			}
			const candidates = listCleanupCandidates(ctx, { scope: scope ?? "current_project", ids: id ? [id] : undefined, force, limit: 200 });
			if (candidates.length === 0) {
				ctx.ui.notify("No terminal agents matched for cleanup.", "info");
				updateFleetUi(ctx);
				return;
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Cleanup terminal agents", `${formatCleanupCandidates(candidates, true)}\n\nProceed?`);
				if (!ok) return;
			}
			const ready = candidates.filter((candidate) => candidate.cleanupAllowed);
			const skipped = candidates.filter((candidate) => !candidate.cleanupAllowed);
			const results = ready.map((candidate) => cleanupAgentTarget(candidate, force));
			const text = formatCleanupResults(results, skipped);
			if (ctx.hasUI) await ctx.ui.editor("subagent cleanup", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
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

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Open tracked task board",
		handler: async (ctx) => {
			boardState = await runAgentsBoard(pi, ctx, boardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("n"), {
		description: "Spawn a task-linked tmux child agent",
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
		const db = getTmuxAgentsDb();
		reconcileTasks(db, { projectKey: getProjectKey(ctx.cwd), limit: 500 });
		await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 }).catch(() => {});
		const activeAgents = listAgents(db, { projectKey: getProjectKey(ctx.cwd), activeOnly: true, limit: 200 });
		for (const agent of activeAgents) {
			if (agent.transportKind === "rpc_bridge") {
				void deliverQueuedMessagesViaBridge(agent.id);
			}
		}
		if (!childRuntimeEnvironment) {
			if (attentionWakePoll) clearInterval(attentionWakePoll);
			attentionWakePoll = setInterval(() => {
				void wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
			}, ATTENTION_WAKE_POLL_MS);
			await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		}
		updateFleetUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!childRuntimeEnvironment) {
			await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		}
		updateFleetUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (attentionWakePoll) clearInterval(attentionWakePoll);
		attentionWakePoll = undefined;
		closeTmuxAgentsDb();
	});
}
