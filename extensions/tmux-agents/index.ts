import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
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
import {
	appendNoWaitPolicyToSystemPrompt,
	classifyNoWaitBashCommand,
	formatNoWaitPolicyViolation,
	getBashCommandFromToolInput,
} from "./no-wait-policy.js";
import { SESSION_CHILD_LINK_ENTRY_TYPE } from "./paths.js";
import { getAllowedBuiltinToolNames, getSubagentProfile, listSubagentProfiles, normalizeBuiltinTools } from "./profiles.js";
import { getProjectKey } from "./project.js";
import {
	AgentMessagePermissionError,
	canSendMessage,
	createAgentEvent,
	createAgentMessage,
	createMessageWithRecipients,
	createRootActorContext,
	fetchAgentInboxV2,
	getAgent,
	getFleetSummary,
	listAgentAttentionItemsV2,
	listAgents,
	listAttentionItems,
	listDescendantAgentIds,
	listHierarchyVisibleAgentIds,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessages,
	resolveAgentActorContext,
	updateAgent,
	updateAgentAttentionItemsV2ForOwner,
	updateAttentionItemsForAgent,
} from "./registry.js";
import type { ListAgentAttentionItemsV2Filters } from "./registry.js";
import { collectQueuedWakeCoalescingContext } from "./wake-coalescing.js";
import {
	assertTaskLeaseAvailable,
	cancelTaskLink,
	createTask,
	createTaskEvent,
	createTaskLink,
	deriveTaskHealth,
	formatTaskLeaseConflict,
	getTask,
	getTaskLease,
	getTaskLeaseConflict,
	getTaskSummary,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTaskEvents,
	listTaskHealth,
	listTaskLinks,
	listTaskReadiness,
	listTasks,
	listTaskSubtreeWithMeta,
	listUnresolvedTaskDependencies,
	reconcileTasks,
	refreshTaskDependencyBlockState,
	resolveDependenciesForCompletedTask,
	taskLeaseKindForProfile,
	unlinkTaskAgent,
	updateTask,
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
	AgentActorContext,
	AgentAttentionV2Record,
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentRecipientKind,
	AgentRecipientRef,
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
	TaskInteractionRecord,
	UpdateAgentInput,
} from "./types.js";
import type {
	CreateTaskInput,
	ListTaskAgentLinksFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskHealthSnapshot,
	TaskLinkState,
	TaskLinkType,
	TaskLinkWithTasksRecord,
	TaskReadinessRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
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

const LIST_SCOPE = StringEnum(["all", "current_project", "current_session", "descendants"] as const, {
	description: "Which slice of the global registry to inspect.",
	default: "current_project",
});

const SubagentSpawnParams = Type.Object({
	title: Type.String({ description: "Short title for the child agent." }),
	task: Type.String({ description: "Task to delegate to the child agent." }),
	profile: Type.String({ description: "Agent profile name from ~/.pi/agent/agents/*.md." }),
	taskId: Type.Optional(Type.String({ description: "Optional existing task id to attach this child to. If omitted, a task is auto-created." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the child. Defaults to the current cwd." })),
	model: Type.Optional(Type.String({ description: "Optional model override." })),
	tools: Type.Optional(
		Type.Array(Type.String({ description: "Child tool name" }), {
			description: `Optional child tool override. Allowed: ${getAllowedBuiltinToolNames().join(", ")}.`,
			maxItems: 16,
		}),
	),
	parentAgentId: Type.Optional(Type.String({ description: "Optional parent child-agent id for hierarchical delegation." })),
	priority: Type.Optional(Type.String({ description: "Optional human-readable priority label." })),
	allowDuplicateOwner: Type.Optional(Type.Boolean({ description: "Allow spawning an additional exclusive owner when the task already has an active exclusive owner. Reviewer profiles are allowed without this override.", default: false })),
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

const TASK_SORT = StringEnum(["priority", "updated", "created", "title", "status"] as const, {
	description: "Task list sort order.",
	default: "priority",
});

const TASK_LINK_TYPE = StringEnum(["depends_on", "relates_to", "duplicates", "spawned_from"] as const, {
	description: "Task relationship type. For depends_on, sourceTaskId is blocked by targetTaskId.",
	default: "depends_on",
});

const TASK_LINK_STATE = StringEnum(["active", "resolved", "cancelled"] as const, {
	description: "Task relationship state.",
});

const TASK_SUBTREE_CONTROL_ACTION = StringEnum(["preview", "pause", "resume", "cancel"] as const, {
	description: "Safe subtree control action. Non-preview actions require explicit confirmation.",
	default: "preview",
});

const TaskCreateParams = Type.Object({
	title: Type.String({ description: "Short task title." }),
	summary: Type.Optional(Type.String({ description: "Short task summary." })),
	description: Type.Optional(Type.String({ description: "Longer task description or delegation context." })),
	cwd: Type.Optional(Type.String({ description: "Working directory for the task. Defaults to the current cwd." })),
	parentTaskId: Type.Optional(Type.String({ description: "Optional parent task id." })),
	priority: Type.Optional(Type.Integer({ description: "Priority from 0 (highest) to 9 (lowest).", minimum: 0, maximum: 9 })),
	priorityLabel: Type.Optional(Type.String({ description: "Optional human-readable priority label." })),
	recommendedProfile: Type.Optional(Type.String({ description: "Recommended subagent profile to dispatch when this task is dependency-ready." })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	labels: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	status: Type.Optional(TASK_STATE),
	blockedReason: Type.Optional(Type.String({ description: "Optional reason if creating directly in blocked." })),
	waitingOn: Type.Optional(TASK_WAITING_ON),
});

const TaskListParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	statuses: Type.Optional(Type.Array(TASK_STATE, { maxItems: 10 })),
	waitingOn: Type.Optional(Type.Array(TASK_WAITING_ON, { maxItems: 10 })),
	recommendedProfile: Type.Optional(Type.String({ description: "Only show tasks with this recommended subagent profile." })),
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
	recommendedProfile: Type.Optional(Type.String({ description: "Recommended subagent profile for dependency-ready dispatch." })),
	acceptanceCriteria: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	planSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	validationSteps: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	labels: Type.Optional(Type.Array(Type.String(), { maxItems: 100 })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	blockedReason: Type.Optional(Type.String()),
	waitingOn: Type.Optional(TASK_WAITING_ON),
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
	autoDispatchReadyDependents: Type.Optional(Type.Boolean({ description: "When moving to done, automatically dispatch newly unblocked dependent tasks with recommendedProfile/fallbackProfile.", default: true })),
	fallbackProfile: Type.Optional(Type.String({ description: "Profile to use for newly ready dependent tasks missing recommendedProfile." })),
	maxDispatch: Type.Optional(Type.Integer({ description: "Maximum newly ready dependent tasks to dispatch.", minimum: 1, maximum: 20, default: 5 })),
});

const TASK_INTERACTION_RESOLUTION_KIND = StringEnum(["resolved", "approved", "rejected", "changes_requested", "superseded", "cancelled"] as const, {
	description: "How an attached task interaction should be dispositioned by this note.",
	default: "resolved",
});

const TaskNoteParams = Type.Object({
	id: Type.String({ description: "Task id." }),
	summary: Type.String({ description: "Short task note summary." }),
	details: Type.Optional(Type.String({ description: "Longer task note details." })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	resolveInteractionId: Type.Optional(Type.String({ description: "Optional structured task interaction id to resolve with this note, e.g. legacy:<id> or v2:<id>." })),
	resolutionKind: Type.Optional(TASK_INTERACTION_RESOLUTION_KIND),
	resolutionSummary: Type.Optional(Type.String({ description: "Optional resolution summary for the task interaction; defaults to the note summary." })),
});

const TaskLinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	role: Type.Optional(Type.String({ description: "Role of this agent on the task." })),
	active: Type.Optional(Type.Boolean({ description: "Whether the link should be active.", default: true })),
	allowDuplicateOwner: Type.Optional(Type.Boolean({ description: "Allow an additional exclusive owner when this task already has an active exclusive owner. Reviewer roles are allowed without this override.", default: false })),
});

const TaskUnlinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	reason: Type.Optional(Type.String({ description: "Why the agent is being unlinked." })),
});

const TaskLinkParams = Type.Object({
	sourceTaskId: Type.String({ description: "Source task id. For depends_on, this is the blocked/dependent task." }),
	targetTaskId: Type.String({ description: "Target task id. For depends_on, this is the prerequisite task." }),
	linkType: Type.Optional(TASK_LINK_TYPE),
	summary: Type.Optional(Type.String({ description: "Optional relationship summary." })),
	blockSource: Type.Optional(Type.Boolean({ description: "For depends_on links, automatically mark the source blocked while prerequisites are unresolved.", default: true })),
});

const TaskUnlinkParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Task link id to cancel." })),
	sourceTaskId: Type.Optional(Type.String({ description: "Source task id if cancelling by pair." })),
	targetTaskId: Type.Optional(Type.String({ description: "Target task id if cancelling by pair." })),
	linkType: Type.Optional(TASK_LINK_TYPE),
	reason: Type.Optional(Type.String({ description: "Why the task relationship is being cancelled." })),
});

const TaskLinksParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	taskId: Type.Optional(Type.String({ description: "Show links where this task is source or target." })),
	sourceTaskId: Type.Optional(Type.String({ description: "Show links from this source task." })),
	targetTaskId: Type.Optional(Type.String({ description: "Show links to this target task." })),
	linkTypes: Type.Optional(Type.Array(TASK_LINK_TYPE, { maxItems: 10 })),
	states: Type.Optional(Type.Array(TASK_LINK_STATE, { maxItems: 10 })),
	includeResolved: Type.Optional(Type.Boolean({ description: "Include resolved/cancelled links when states are not provided.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of task links to return.", minimum: 1, maximum: 500, default: 100 })),
});

const TaskReadyParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 200 })),
	recommendedProfile: Type.Optional(Type.String({ description: "Only include ready tasks with this recommended profile." })),
	includeBlocked: Type.Optional(Type.Boolean({ description: "Include non-ready tasks with dependency/readiness reasons.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of tasks to inspect.", minimum: 1, maximum: 500, default: 100 })),
});

const TaskDispatchReadyParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100 })),
	fallbackProfile: Type.Optional(Type.String({ description: "Profile to use for ready tasks missing recommendedProfile." })),
	maxDispatch: Type.Optional(Type.Integer({ description: "Maximum number of ready tasks to dispatch.", minimum: 1, maximum: 20, default: 5 })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview dispatchable ready tasks without spawning agents.", default: false })),
});

const TaskAttentionParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of task attention items.", minimum: 1, maximum: 500, default: 100 })),
});

const TaskReconcileParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of items to reconcile.", minimum: 1, maximum: 500, default: 200 })),
});

const TaskSubtreeControlParams = Type.Object({
	id: Type.String({ description: "Root task id for the task family subtree." }),
	action: Type.Optional(TASK_SUBTREE_CONTROL_ACTION),
	includeRoot: Type.Optional(Type.Boolean({ description: "Include the root task itself in the selected subtree. Defaults true.", default: true })),
	confirm: Type.Optional(Type.Boolean({ description: "Required true to apply pause/resume/cancel. False returns the preview only.", default: false })),
	previewToken: Type.Optional(Type.String({ description: "Preview token returned by the prior dry-run preview. Required with confirm=true for pause/resume/cancel." })),
	reason: Type.Optional(Type.String({ description: "Reason written to task events and graceful stop messages." })),
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
	if (agent.taskId) parts.push(`task=${agent.taskId}`);
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
		`parentAgentId: ${agent.parentAgentId ?? "-"}`,
		`orgId: ${agent.orgId ?? "-"}`,
		`roleKey: ${agent.roleKey ?? "-"}`,
		`spawnedByAgentId: ${agent.spawnedByAgentId ?? "-"}`,
		`hierarchyState: ${agent.hierarchyState}`,
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

function getTaskHealthSnapshot(task: TaskRecord): TaskHealthSnapshot {
	return listTaskHealth(getTmuxAgentsDb(), [task]).get(task.id) ?? deriveTaskHealth({ task });
}

function formatTaskLine(task: TaskRecord, linkedAgents: AgentSummary[] = [], readiness?: TaskReadinessRecord, health: TaskHealthSnapshot = getTaskHealthSnapshot(task)): string {
	const activeLinkedAgents = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state));
	const activeExclusiveOwners = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(agent.profile) === "exclusive");
	const activeReviewers = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(agent.profile) === "review");
	const flags = [
		`status=${task.status}`,
		`health=${health.state}`,
		`lastUseful=${formatStandupAge(health.lastUsefulUpdateAt ?? 0)}`,
		task.waitingOn ? `waiting=${task.waitingOn}` : null,
		task.recommendedProfile ? `profile=${task.recommendedProfile}` : null,
		readiness && readiness.unresolvedDependencies.length > 0 ? `deps=${readiness.unresolvedDependencies.length}` : null,
		activeExclusiveOwners.length > 0 ? `owner=${activeExclusiveOwners.map((agent) => agent.id).join(",")}` : null,
		activeReviewers.length > 0 ? `reviewers=${activeReviewers.length}` : null,
		`p${task.priority}`,
		linkedAgents.length > 0 ? `${linkedAgents.length} agent${linkedAgents.length === 1 ? "" : "s"}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${task.id} · ${truncateText(task.title, 48)} · ${flags}\n  next: ${health.nextAction}`;
}

function formatTaskLinkLine(link: TaskLinkWithTasksRecord, perspective: "dependency" | "dependent" | "any" = "any"): string {
	const direction =
		perspective === "dependency"
			? `depends on ${link.targetTaskId}`
			: perspective === "dependent"
				? `blocks ${link.sourceTaskId}`
				: `${link.sourceTaskId} -> ${link.targetTaskId}`;
	const unresolved = link.unresolved ? "unresolved" : link.state === "resolved" || link.targetStatus === "done" ? "resolved" : link.state;
	const title = perspective === "dependent" ? link.sourceTitle : link.targetTitle;
	return `- ${link.id} · ${link.linkType} · ${direction} · ${unresolved} · ${truncateText(title, 60)}${link.summary ? ` — ${truncateText(link.summary, 80)}` : ""}`;
}

function formatTaskReadinessLine(item: TaskReadinessRecord): string {
	const profile = item.task.recommendedProfile ? ` · profile=${item.task.recommendedProfile}` : "";
	const deps = item.unresolvedDependencies.length > 0 ? ` · blockedBy=${item.unresolvedDependencies.map((link) => link.targetTaskId).join(",")}` : "";
	return `- ${item.task.id} · ${truncateText(item.task.title, 60)} · ${item.reason}${profile}${deps}`;
}

function buildTaskLinksText(links: TaskLinkWithTasksRecord[]): string {
	if (links.length === 0) return "No task links matched.";
	return links.map((link) => formatTaskLinkLine(link)).join("\n");
}

function buildTaskReadyText(items: TaskReadinessRecord[], includeBlocked: boolean): string {
	const visible = includeBlocked ? items : items.filter((item) => item.ready);
	if (visible.length === 0) return includeBlocked ? "No matching tasks found." : "No dependency-ready tasks found.";
	return visible.map(formatTaskReadinessLine).join("\n");
}

function buildTaskDispatchText(result: ReturnType<typeof dispatchReadyTasks>, dryRun: boolean): string {
	const lines = [dryRun ? "# Ready dispatch preview" : "# Ready dispatch result"];
	if (result.preview.length > 0) {
		lines.push("", "Dispatchable:", ...result.preview.map((item) => `- ${item.taskId} · ${truncateText(item.title, 60)} · profile=${item.profile}`));
	}
	if (result.dispatched.length > 0) {
		lines.push("", "Dispatched:", ...result.dispatched.map((item) => `- ${item.taskId} · ${item.agentId} · profile=${item.profile}`));
	}
	if (result.skipped.length > 0) {
		lines.push("", "Skipped:", ...result.skipped.map((item) => `- ${item.taskId} · ${item.reason}`));
	}
	if (result.preview.length === 0 && result.skipped.length === 0) lines.push("", "No dependency-ready tasks found.");
	return lines.join("\n");
}

interface TaskSubtreeControlPreview {
	action: TaskSubtreeControlAction;
	rootTask: TaskRecord;
	includeRoot: boolean;
	reason: string | null;
	previewToken: string;
	isComplete: boolean;
	truncationWarnings: string[];
	tasks: TaskRecord[];
	taskIdsToUpdate: string[];
	links: TaskAgentLinkRecord[];
	linkedAgents: AgentSummary[];
	activeAgents: AgentSummary[];
	agentIdsToStop: string[];
	agentsByTaskId: Map<string, AgentSummary[]>;
	blockers: TaskRecord[];
	attentionItems: AttentionItemRecord[];
	agentAttentionItems: AgentAttentionV2Record[];
	cleanupCandidates: CleanupCandidate[];
}

interface TaskSubtreeControlApplyResult {
	preview: TaskSubtreeControlPreview;
	updatedTasks: TaskRecord[];
	stopResults: Array<{ agentId: string; stopped: boolean; graceful: boolean; command: string; reason?: string }>;
	stopErrors: Array<{ agentId: string; error: string }>;
	taskEventsCreated: number;
}

function normalizeSubtreeReason(action: TaskSubtreeControlAction, reason: string | null | undefined): string {
	const trimmed = reason?.trim();
	if (trimmed) return trimmed;
	switch (action) {
		case "pause":
			return "Subtree paused by coordinator.";
		case "resume":
			return "Subtree resumed by coordinator.";
		case "cancel":
			return "Subtree cancelled by coordinator.";
		case "preview":
		default:
			return "Subtree preview requested.";
	}
}

function isTaskPausedBySubtree(task: TaskRecord): boolean {
	return task.status === "blocked" && Boolean(task.blockedReason?.startsWith(SUBTREE_PAUSED_PREFIX));
}

function isActiveAgent(agent: AgentSummary): boolean {
	return ACTIVE_AGENT_STATES.includes(agent.state);
}

function taskShouldUpdateForSubtreeAction(task: TaskRecord, action: TaskSubtreeControlAction): boolean {
	switch (action) {
		case "pause":
			return task.status !== "done" && task.status !== "blocked";
		case "resume":
			return isTaskPausedBySubtree(task);
		case "cancel":
			return task.status !== "done";
		case "preview":
		default:
			return false;
	}
}

function subtreeBlockedReason(prefix: string, reason: string): string {
	return `${prefix} ${reason}`.trim();
}

function addAgentToTaskMap(map: Map<string, AgentSummary[]>, taskId: string, agent: AgentSummary): void {
	const agents = map.get(taskId) ?? [];
	if (!agents.some((existing) => existing.id === agent.id)) agents.push(agent);
	map.set(taskId, agents);
}

function buildTaskSubtreePreviewToken(input: {
	action: TaskSubtreeControlAction;
	rootTaskId: string;
	includeRoot: boolean;
	reason: string | null;
	taskIds: string[];
	taskIdsToUpdate: string[];
	agentIdsToStop: string[];
	truncationWarnings: string[];
}): string {
	return createHash("sha256")
		.update(JSON.stringify({
			action: input.action,
			rootTaskId: input.rootTaskId,
			includeRoot: input.includeRoot,
			reason: input.reason,
			taskIds: [...input.taskIds].sort(),
			taskIdsToUpdate: [...input.taskIdsToUpdate].sort(),
			agentIdsToStop: [...input.agentIdsToStop].sort(),
			truncationWarnings: input.truncationWarnings,
		}))
		.digest("hex")
		.slice(0, 16);
}

function buildTaskSubtreeControlPreview(
	ctx: ExtensionContext,
	rootTaskId: string,
	action: TaskSubtreeControlAction,
	options: { includeRoot?: boolean; reason?: string } = {},
): TaskSubtreeControlPreview {
	const db = getTmuxAgentsDb();
	const rootTask = getTask(db, rootTaskId);
	if (!rootTask) throw new Error(`Unknown task id \"${rootTaskId}\".`);
	const includeRoot = options.includeRoot ?? true;
	const reason = action === "preview" ? null : normalizeSubtreeReason(action, options.reason);
	const truncationWarnings: string[] = [];
	const subtree = listTaskSubtreeWithMeta(db, rootTask.id, { includeRoot, includeDone: true, limit: SUBTREE_QUERY_TASK_LIMIT, maxDepth: SUBTREE_QUERY_TASK_LIMIT });
	const tasks = subtree.tasks;
	if (subtree.hitLimit) truncationWarnings.push(`task subtree reached safety cap ${subtree.limit}; apply is disabled until the subtree is narrowed or the cap is raised`);
	if (subtree.hitDepthLimit) truncationWarnings.push(`task subtree reached depth safety cap ${subtree.maxDepth}; descendants may be omitted below depth ${subtree.maxReturnedDepth}, so apply is disabled until the subtree is narrowed or the depth cap is raised`);
	const taskIds = tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const links = taskIds.length > 0 ? listTaskAgentLinks(db, { taskIds, limit: SUBTREE_QUERY_LINK_LIMIT }) : [];
	if (links.length >= SUBTREE_QUERY_LINK_LIMIT) truncationWarnings.push(`task-agent links reached safety cap ${SUBTREE_QUERY_LINK_LIMIT}; apply is disabled to avoid partial linked-agent control`);
	const activeLinkAgentIds = new Set(links.filter((link) => link.isActive).map((link) => link.agentId));
	const linkedAgentIds = new Set(links.map((link) => link.agentId));
	const agentsById = new Map<string, AgentSummary>();
	if (linkedAgentIds.size > SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`linked agent id set has ${linkedAgentIds.size} agents, exceeding list cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled to avoid partial agent control`);
	if (linkedAgentIds.size > 0) {
		for (const agent of listAgents(db, { ids: [...linkedAgentIds], limit: SUBTREE_QUERY_AGENT_LIMIT })) agentsById.set(agent.id, agent);
	}
	if (taskIds.length > 0) {
		const taskAgents = listAgents(db, { taskIds, limit: SUBTREE_QUERY_AGENT_LIMIT });
		if (taskAgents.length >= SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`agents attached directly by task_id reached safety cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled to avoid partial agent control`);
		for (const agent of taskAgents) agentsById.set(agent.id, agent);
	}
	const linkedAgents = [...agentsById.values()]
		.filter((agent) => (agent.taskId ? taskIdSet.has(agent.taskId) : false) || links.some((link) => link.agentId === agent.id))
		.sort((left, right) => {
			const leftActive = isActiveAgent(left) ? 0 : 1;
			const rightActive = isActiveAgent(right) ? 0 : 1;
			return leftActive - rightActive || left.profile.localeCompare(right.profile) || left.id.localeCompare(right.id);
		});
	const agentsByTaskId = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (agent) addAgentToTaskMap(agentsByTaskId, link.taskId, agent);
	}
	for (const agent of linkedAgents) {
		if (agent.taskId && taskIdSet.has(agent.taskId)) addAgentToTaskMap(agentsByTaskId, agent.taskId, agent);
	}
	const activeAgents = linkedAgents.filter((agent) => isActiveAgent(agent) && ((agent.taskId ? taskIdSet.has(agent.taskId) : false) || activeLinkAgentIds.has(agent.id)));
	const agentIds = linkedAgents.map((agent) => agent.id);
	const attentionItems = agentIds.length > 0 ? listAttentionItems(db, { agentIds, states: OPEN_ATTENTION_STATES, limit: SUBTREE_QUERY_ATTENTION_LIMIT }) : [];
	if (attentionItems.length >= SUBTREE_QUERY_ATTENTION_LIMIT) truncationWarnings.push(`legacy attention reached safety cap ${SUBTREE_QUERY_ATTENTION_LIMIT}; apply is disabled until attention fanout is narrowed`);
	const directAgentAttentionItems = taskIds.length > 0 ? listAgentAttentionItemsV2(db, { taskIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: SUBTREE_QUERY_ATTENTION_LIMIT }) : [];
	if (directAgentAttentionItems.length >= SUBTREE_QUERY_ATTENTION_LIMIT) truncationWarnings.push(`direct hierarchy attention reached safety cap ${SUBTREE_QUERY_ATTENTION_LIMIT}; apply is disabled until attention fanout is narrowed`);
	const subjectAgentAttentionItems = agentIds.length > 0 ? listAgentAttentionItemsV2(db, { subjectAgentIds: agentIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: SUBTREE_QUERY_ATTENTION_LIMIT }) : [];
	if (subjectAgentAttentionItems.length >= SUBTREE_QUERY_ATTENTION_LIMIT) truncationWarnings.push(`subject hierarchy attention reached safety cap ${SUBTREE_QUERY_ATTENTION_LIMIT}; apply is disabled until attention fanout is narrowed`);
	const agentAttentionItems = [...new Map([...directAgentAttentionItems, ...subjectAgentAttentionItems].map((item) => [item.id, item])).values()];
	const cleanupCandidates = agentIds.length > 0 ? listCleanupCandidates(ctx, { ids: agentIds, limit: agentIds.length, force: false }) : [];
	if (agentIds.length > SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`cleanup candidate lookup is incomplete for ${agentIds.length} agents due agent list cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled`);
	const taskIdsToUpdate = tasks.filter((task) => taskShouldUpdateForSubtreeAction(task, action)).map((task) => task.id);
	const agentIdsToStop = action === "pause" || action === "cancel" ? activeAgents.map((agent) => agent.id) : [];
	const isComplete = truncationWarnings.length === 0;
	const previewToken = buildTaskSubtreePreviewToken({ action, rootTaskId: rootTask.id, includeRoot, reason, taskIds, taskIdsToUpdate, agentIdsToStop, truncationWarnings });
	return {
		action,
		rootTask,
		includeRoot,
		reason,
		previewToken,
		isComplete,
		truncationWarnings,
		tasks,
		taskIdsToUpdate,
		links,
		linkedAgents,
		activeAgents,
		agentIdsToStop,
		agentsByTaskId,
		blockers: tasks.filter((task) => task.status === "blocked" || Boolean(task.waitingOn) || Boolean(task.blockedReason)),
		attentionItems,
		agentAttentionItems,
		cleanupCandidates,
	};
}

function taskStatusCounts(tasks: TaskRecord[]): Record<TaskState, number> {
	return tasks.reduce<Record<TaskState, number>>(
		(counts, task) => {
			counts[task.status] += 1;
			return counts;
		},
		{ todo: 0, blocked: 0, in_progress: 0, in_review: 0, done: 0 },
	);
}

function formatTaskStatusCounts(tasks: TaskRecord[]): string {
	const counts = taskStatusCounts(tasks);
	return [`todo=${counts.todo}`, `blocked=${counts.blocked}`, `in_progress=${counts.in_progress}`, `in_review=${counts.in_review}`, `done=${counts.done}`].join(" · ");
}

function appendPreviewSection<T>(lines: string[], title: string, items: T[], formatter: (item: T) => string, empty = "- none", limit = 40): void {
	lines.push("", `## ${title}`);
	if (items.length === 0) {
		lines.push(empty);
		return;
	}
	for (const item of items.slice(0, limit)) lines.push(formatter(item));
	if (items.length > limit) lines.push(`- display truncated: showing ${limit} of ${items.length}; apply still uses the full counted selection when previewComplete=true`);
}

function formatTaskSubtreePreviewTaskLine(preview: TaskSubtreeControlPreview, task: TaskRecord): string {
	const action = preview.taskIdsToUpdate.includes(task.id) ? `will-${preview.action}` : "unchanged";
	const agents = preview.agentsByTaskId.get(task.id) ?? [];
	const agentText = agents.length > 0 ? ` · agents=${agents.map((agent) => `${agent.id}:${agent.state}`).join(",")}` : "";
	const waitingText = task.waitingOn ? ` · waiting=${task.waitingOn}` : "";
	const blockedText = task.blockedReason ? `\n  blocked: ${truncateText(task.blockedReason, 140)}` : "";
	return `- ${task.id} · ${action} · ${task.status} · parent=${task.parentTaskId ?? "-"} · ${truncateText(task.title, 72)}${waitingText}${agentText}${blockedText}`;
}

function formatTaskSubtreePreviewAgentLine(preview: TaskSubtreeControlPreview, agent: AgentSummary): string {
	const willStop = preview.agentIdsToStop.includes(agent.id);
	const next = willStop ? "will request graceful stop (no force kill)" : "no stop request";
	return `- ${agent.id} · ${agent.profile} · ${agent.state} · task=${agent.taskId ?? "-"} · transport=${agent.transportState} · ${next}`;
}

function formatTaskSubtreePreviewAttentionLine(item: AttentionItemRecord): string {
	return `- ${item.agentId} · ${item.kind} · ${item.state} · ${truncateText(item.summary, 140)}`;
}

function formatTaskSubtreePreviewAgentAttentionLine(item: AgentAttentionV2Record): string {
	const owner = `${item.ownerKind}:${item.ownerAgentId ?? "-"}`;
	return `- ${item.kind} · ${item.state} · task=${item.taskId ?? "-"} · subject=${item.subjectAgentId ?? "-"} · owner=${owner} · ${truncateText(item.summary, 140)}`;
}

function formatTaskSubtreeCleanupLine(candidate: CleanupCandidate): string {
	const attention = candidate.attentionItems.length > 0 ? candidate.attentionItems.map((item) => item.kind).join(",") : "none";
	return `- ${candidate.cleanupAllowed ? "✓" : "-"} ${candidate.agent.id} · ${candidate.agent.state} · ${candidate.reason} · attention=${attention}`;
}

function formatTaskSubtreeControlConsequences(preview: TaskSubtreeControlPreview): string[] {
	if (preview.action === "preview") return ["- Read-only preview; no task, agent, attention, or tmux state changes will be applied."];
	if (preview.action === "resume") {
		return [
			`- ${preview.taskIdsToUpdate.length} task(s) with ${SUBTREE_PAUSED_PREFIX} will move back to todo and clear pause blockers.`,
			"- Dependency checks still run after resume; tasks with unresolved dependencies may remain blocked.",
			"- No agents are spawned automatically; dispatch explicitly after reviewing the resumed subtree.",
		];
	}
	if (preview.action === "pause") {
		return [
			`- ${preview.taskIdsToUpdate.length} non-blocked open task(s) will move to blocked/waitingOn=coordinator with ${SUBTREE_PAUSED_PREFIX}.`,
			`- ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests; no force kill is used.`,
			"- Already blocked tasks keep their existing blocker state and receive only durable subtree-control notes when linked agents are affected.",
			"- Terminal cleanup candidates are not cleaned automatically; use subagent_cleanup after reviewing handoffs.",
		];
	}
	return [
		`- ${preview.taskIdsToUpdate.length} non-done task(s) will be parked blocked/waitingOn=coordinator with ${SUBTREE_CANCELLED_PREFIX}.`,
		`- ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests; no force kill is used.`,
		"- Cancel does not mark work accepted/done and does not delete task records; finalize or archive manually after reviewing notes.",
		"- Terminal cleanup candidates are not cleaned automatically; use subagent_cleanup after reviewing handoffs.",
	];
}

function formatTaskSubtreeControlPreview(preview: TaskSubtreeControlPreview): string {
	const lines = [
		`# Subtree control preview · action=${preview.action}`,
		`root: ${preview.rootTask.id} · ${truncateText(preview.rootTask.title, 90)}`,
		`selection: ${preview.includeRoot ? "root task plus " : ""}recursive descendants via tasks.parentTaskId; linked agents come from task_agent_links plus agents.taskId for selected tasks.`,
		`confirmation: ${preview.action === "preview" ? "not required for read-only preview" : `rerun with confirm=true and previewToken=${preview.previewToken}`}`,
		`previewToken: ${preview.previewToken}`,
		`previewComplete: ${preview.isComplete ? "yes" : "no — apply is disabled until warnings are resolved"}`,
		preview.reason ? `reason: ${preview.reason}` : null,
		`counts: ${preview.tasks.length} task(s) (${formatTaskStatusCounts(preview.tasks)}) · ${preview.linkedAgents.length} linked agent(s) · ${preview.activeAgents.length} active · ${preview.blockers.length} blocked task(s) · ${preview.attentionItems.length + preview.agentAttentionItems.length} open attention · ${preview.cleanupCandidates.length} cleanup candidate(s)`,
		...preview.truncationWarnings.map((warning) => `warning: ${warning}`),
	]
		.filter((line): line is string => Boolean(line));
	lines.push("", "## Consequences", ...formatTaskSubtreeControlConsequences(preview));
	appendPreviewSection(lines, "Affected tasks", preview.tasks, (task) => formatTaskSubtreePreviewTaskLine(preview, task), preview.includeRoot ? "- none (root task not found)" : "- none (root excluded and no descendants)", 60);
	appendPreviewSection(lines, "Active linked agents", preview.activeAgents, (agent) => formatTaskSubtreePreviewAgentLine(preview, agent), "- none", 40);
	appendPreviewSection(lines, "Task blockers", preview.blockers, (task) => `- ${task.id} · waiting=${task.waitingOn ?? "-"} · ${truncateText(task.blockedReason ?? task.summary ?? task.title, 140)}`, "- none", 40);
	appendPreviewSection(lines, "Open linked-agent attention", preview.attentionItems, formatTaskSubtreePreviewAttentionLine, "- none", 40);
	appendPreviewSection(lines, "Open hierarchy attention", preview.agentAttentionItems, formatTaskSubtreePreviewAgentAttentionLine, "- none", 40);
	appendPreviewSection(lines, "Terminal cleanup candidates", preview.cleanupCandidates, formatTaskSubtreeCleanupLine, "- none", 40);
	return lines.join("\n");
}

function formatTaskSubtreeControlConfirmation(preview: TaskSubtreeControlPreview): string {
	return [
		`Apply subtree ${preview.action} to ${preview.rootTask.id}?`,
		`${preview.taskIdsToUpdate.length} task(s) will be updated; ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests.`,
		`${preview.blockers.length} blocked task(s), ${preview.attentionItems.length + preview.agentAttentionItems.length} open attention item(s), and ${preview.cleanupCandidates.length} cleanup candidate(s) were shown in the preview.`,
		`Preview token required for tool/API apply: ${preview.previewToken}.`,
		preview.isComplete ? "Preview is complete; apply may proceed after confirmation." : "Preview is incomplete; apply is disabled until warnings are resolved.",
		"No force stop or cleanup will run from this action.",
	].join("\n");
}

async function applyTaskSubtreeControl(
	ctx: ExtensionContext,
	rootTaskId: string,
	action: Exclude<TaskSubtreeControlAction, "preview">,
	options: { includeRoot?: boolean; reason?: string; previewToken?: string } = {},
): Promise<TaskSubtreeControlApplyResult> {
	const db = getTmuxAgentsDb();
	const preview = buildTaskSubtreeControlPreview(ctx, rootTaskId, action, options);
	if (!preview.isComplete) {
		throw new Error(`Refusing to apply subtree ${action}: preview is incomplete. ${preview.truncationWarnings.join(" ")}`);
	}
	if (!options.previewToken || options.previewToken !== preview.previewToken) {
		throw new Error(`Refusing to apply subtree ${action}: rerun preview and pass previewToken=${preview.previewToken} with confirm=true to acknowledge the exact selection.`);
	}
	const now = Date.now();
	const reason = normalizeSubtreeReason(action, options.reason);
	const stopResults: TaskSubtreeControlApplyResult["stopResults"] = [];
	const stopErrors: TaskSubtreeControlApplyResult["stopErrors"] = [];
	const stopReason = `Subtree ${action} for ${preview.rootTask.id}: ${reason}`;
	for (const agent of preview.activeAgents.filter((item) => preview.agentIdsToStop.includes(item.id))) {
		try {
			const stopped = await stopAgentById(agent.id, false, stopReason);
			stopResults.push({
				agentId: stopped.agent.id,
				stopped: stopped.result.stopped,
				graceful: stopped.result.graceful,
				command: stopped.result.command,
				reason: stopped.result.reason,
			});
		} catch (error) {
			stopErrors.push({ agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const taskIdsToUpdate = new Set(preview.taskIdsToUpdate);
	const updatedTasks: TaskRecord[] = [];
	for (const task of preview.tasks) {
		if (!taskIdsToUpdate.has(task.id)) continue;
		if (action === "pause") {
			updateTask(db, task.id, {
				status: "blocked",
				waitingOn: "coordinator",
				blockedReason: subtreeBlockedReason(SUBTREE_PAUSED_PREFIX, reason),
				updatedAt: now,
			});
			updatedTasks.push(getTask(db, task.id)!);
			continue;
		}
		if (action === "resume") {
			updateTask(db, task.id, {
				status: "todo",
				waitingOn: null,
				blockedReason: null,
				reviewRequestedAt: null,
				finishedAt: null,
				updatedAt: now,
			});
			updatedTasks.push(refreshTaskDependencyBlockState(db, task.id, now) ?? getTask(db, task.id)!);
			continue;
		}
		updateTask(db, task.id, {
			status: "blocked",
			waitingOn: "coordinator",
			blockedReason: subtreeBlockedReason(SUBTREE_CANCELLED_PREFIX, reason),
			finishedAt: null,
			updatedAt: now,
		});
		updatedTasks.push(getTask(db, task.id)!);
	}
	const updatedById = new Map(updatedTasks.map((task) => [task.id, task]));
	const noteTaskIds = new Set(preview.taskIdsToUpdate);
	for (const [taskId, agents] of preview.agentsByTaskId.entries()) {
		if (agents.some((agent) => preview.agentIdsToStop.includes(agent.id))) noteTaskIds.add(taskId);
	}
	let taskEventsCreated = 0;
	for (const taskId of noteTaskIds) {
		const before = preview.tasks.find((task) => task.id === taskId) ?? preview.rootTask;
		const after = updatedById.get(taskId) ?? getTask(db, taskId) ?? before;
		if (!updatedById.has(taskId)) updateTask(db, taskId, { updatedAt: now });
		const linkedStopAgentIds = (preview.agentsByTaskId.get(taskId) ?? [])
			.filter((agent) => preview.agentIdsToStop.includes(agent.id))
			.map((agent) => agent.id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "subtree_control",
			summary: `Subtree ${action} applied from root ${preview.rootTask.id}`,
			payload: {
				action,
				rootTaskId: preview.rootTask.id,
				reason,
				previousStatus: before.status,
				newStatus: after.status,
				previousWaitingOn: before.waitingOn,
				newWaitingOn: after.waitingOn,
				previousBlockedReason: before.blockedReason,
				newBlockedReason: after.blockedReason,
				gracefulStopRequestedAgentIds: linkedStopAgentIds,
				stopErrors: stopErrors.filter((item) => linkedStopAgentIds.includes(item.agentId)),
			},
			createdAt: now,
		});
		taskEventsCreated += 1;
	}
	return { preview, updatedTasks, stopResults, stopErrors, taskEventsCreated };
}

function formatTaskSubtreeControlApplyResult(result: TaskSubtreeControlApplyResult): string {
	const lines = [
		`# Subtree control result · action=${result.preview.action}`,
		`root: ${result.preview.rootTask.id}`,
		`updatedTasks: ${result.updatedTasks.length}`,
		`gracefulStopRequests: ${result.stopResults.length}`,
		`stopErrors: ${result.stopErrors.length}`,
		`taskEventsCreated: ${result.taskEventsCreated}`,
	];
	appendPreviewSection(lines, "Updated tasks", result.updatedTasks, (task) => `- ${task.id} · ${task.status} · waiting=${task.waitingOn ?? "-"} · ${truncateText(task.title, 80)}`, "- none", 60);
	appendPreviewSection(lines, "Graceful stop requests", result.stopResults, (item) => `- ${item.agentId} · ${item.command} · ${item.reason ?? "queued"}`, "- none", 40);
	appendPreviewSection(lines, "Stop errors", result.stopErrors, (item) => `- ${item.agentId} · ${item.error}`, "- none", 40);
	return lines.join("\n");
}

function formatTaskDetails(
	task: TaskRecord,
	linkedAgents: AgentSummary[] = [],
	events: ReturnType<typeof listTaskEvents> = [],
	links: { dependencies?: TaskLinkWithTasksRecord[]; dependents?: TaskLinkWithTasksRecord[] } = {},
	interactions: TaskInteractionRecord[] = [],
	health: TaskHealthSnapshot = getTaskHealthSnapshot(task),
): string {
	const lines = [
		`id: ${task.id}`,
		`status: ${task.status} (Kanban lane; health is derived separately)`,
		`health: ${health.state}`,
		`healthSignals: ${health.signals.join(", ")}`,
		`lastUsefulUpdateAt: ${health.lastUsefulUpdateAt ? new Date(health.lastUsefulUpdateAt).toISOString() : "-"}`,
		`lastUsefulUpdate: ${health.lastUsefulUpdateSummary}`,
		`nextAction: ${health.nextAction}`,
		`healthReason: ${health.reason}`,
		`title: ${task.title}`,
		`summary: ${task.summary ?? "-"}`,
		`description: ${task.description ?? "-"}`,
		`priority: ${task.priority}${task.priorityLabel ? ` (${task.priorityLabel})` : ""}`,
		`recommendedProfile: ${task.recommendedProfile ?? "-"}`,
		`waitingOn: ${task.waitingOn ?? "-"}`,
		`blockedReason: ${task.blockedReason ?? "-"}`,
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
		"dependencies:",
		...((links.dependencies ?? []).length > 0 ? (links.dependencies ?? []).map((link) => formatTaskLinkLine(link, "dependency")) : ["- none"]),
		"",
		"blocks:",
		...((links.dependents ?? []).length > 0 ? (links.dependents ?? []).map((link) => formatTaskLinkLine(link, "dependent")) : ["- none"]),
		"",
		`reviewSummary: ${task.reviewSummary ?? "-"}`,
		`finalSummary: ${task.finalSummary ?? "-"}`,
		"",
		"interactions:",
		...(interactions.length > 0 ? interactions.map(formatTaskInteractionCard) : ["- none"]),
		"",
		"linkedAgents:",
		...(linkedAgents.length > 0 ? linkedAgents.map((agent) => `- ${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}`) : ["- none"]),
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
	if (filters.recommendedProfile) parts.push(`recommendedProfile=${filters.recommendedProfile}`);
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

function resolveToolActorContext(ctx: ExtensionContext): AgentActorContext {
	const db = getTmuxAgentsDb();
	if (childRuntimeEnvironment) {
		return resolveAgentActorContext(db, { currentAgentId: childRuntimeEnvironment.childId });
	}
	return createRootActorContext({
		projectKey: getProjectKey(ctx.cwd),
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

function applyHierarchyVisibilityToAgentFilters(ctx: ExtensionContext, filters: ListAgentsFilters): ListAgentsFilters {
	if (!childRuntimeEnvironment) return filters;
	const db = getTmuxAgentsDb();
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return filters;
	let requestedIds: string[] | undefined = filters.ids;
	if (filters.descendantOf) {
		requestedIds = listDescendantAgentIds(db, filters.descendantOf);
	}
	const visibleIds = listHierarchyVisibleAgentIds(db, actor, {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
	});
	const visibleSet = new Set(visibleIds);
	const ids = requestedIds ? requestedIds.filter((id) => visibleSet.has(id)) : visibleIds;
	return { ...filters, ids, descendantOf: undefined };
}

function getVisibleAgentIdsForTool(ctx: ExtensionContext, requestedIds?: string[]): string[] | null {
	if (!childRuntimeEnvironment) return requestedIds ?? null;
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return requestedIds ?? null;
	const visibleIds = listHierarchyVisibleAgentIds(getTmuxAgentsDb(), actor, { projectKey: getProjectKey(ctx.cwd) });
	if (!requestedIds) return visibleIds;
	const visibleSet = new Set(visibleIds);
	return requestedIds.filter((id) => visibleSet.has(id));
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
	params: { statuses?: TaskState[]; waitingOn?: TaskWaitingOn[]; recommendedProfile?: string; includeDone?: boolean; limit?: number; linkedAgentId?: string },
): ListTasksFilters {
	const filters: ListTasksFilters = {
		statuses: params.statuses,
		waitingOn: params.waitingOn,
		recommendedProfile: params.recommendedProfile,
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

function formatFleetSummary(taskSummary: TaskSummaryCounts, agentSummary: FleetSummary): string | undefined {
	const taskText = formatTaskCounts(taskSummary);
	const hasAgentSignals = agentSummary.active > 0 || agentSummary.blocked > 0 || agentSummary.attentionOpen > 0 || agentSummary.unread > 0;
	const agentText =
		!taskText && !hasAgentSignals
			? undefined
			: `🤖 ${agentSummary.active} active · ${agentSummary.blocked} blocked · ${agentSummary.attentionOpen} open attention · ${agentSummary.unread} unread`;
	if (!taskText && !agentText) return undefined;
	return [taskText, agentText].filter((value): value is string => Boolean(value)).join(" · ");
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
	const items = listAttentionItems(db, {
		projectKey,
		states: ["open", "waiting_on_coordinator", "waiting_on_user"],
		limit: 25,
	});
	if (items.length === 0) return;
	const agents = new Map(listAgents(db, { projectKey, limit: 200 }).map((agent) => [agent.id, agent]));

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
	ctx.ui.setStatus("tmux-agents", formatFleetSummary(taskSummary, agentSummary));
	const taskItems = listTaskAttention(db, { projectKey, limit: 4 });
	if (taskItems.length > 0) {
		ctx.ui.setWidget(
			"tmux-agents",
			taskItems.map((item) => `${item.health === "stale" || item.health === "empty_or_no_progress" ? "⚠" : item.status === "blocked" ? "⛔" : "◍"} ${truncateText(item.title, 32)} · ${item.status} · health=${item.health}${item.waitingOn ? ` · ${item.waitingOn}` : ""}`),
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
const OPEN_AGENT_ATTENTION_V2_STATES: AgentAttentionV2Record["state"][] = ["open", "acknowledged", "waiting_on_owner"];
const ACTIVE_AGENT_STATES: AgentSummary["state"][] = ["launching", "running", "idle", "waiting", "blocked"];
const TERMINAL_AGENT_STATES: AgentSummary["state"][] = ["done", "error", "stopped", "lost"];
const SUBTREE_PAUSED_PREFIX = "[subtree paused]";
const SUBTREE_CANCELLED_PREFIX = "[subtree cancelled]";
const SUBTREE_QUERY_TASK_LIMIT = 1000;
const SUBTREE_QUERY_LINK_LIMIT = 1000;
const SUBTREE_QUERY_AGENT_LIMIT = 200;
const SUBTREE_QUERY_ATTENTION_LIMIT = 500;

type TaskSubtreeControlAction = "preview" | "pause" | "resume" | "cancel";

interface CleanupCandidate {
	agent: AgentSummary;
	attentionItems: AttentionItemRecord[];
	targetExists: boolean;
	cleanupAllowed: boolean;
	reason: string;
}

function buildInboxText(messages: AgentMessageRecord[], readReceiptCount = 0): string {
	if (messages.length === 0) return "No unread child-originated messages.";
	const body = messages
		.map((message) => {
			const payloadText = truncateText(JSON.stringify(message.payload), 160);
			return `${message.id} · ${message.kind} · ${message.targetKind} · sender=${message.senderAgentId ?? "-"} · recipient=${message.recipientAgentId ?? "root/user"}\n${payloadText}`;
		})
		.join("\n\n");
	if (readReceiptCount <= 0) return body;
	return `${body}\n\nRead receipt: marked ${readReceiptCount} message${readReceiptCount === 1 ? "" : "s"} delivered. Future unread inbox reads will omit ${readReceiptCount === 1 ? "it" : "them"}; pass includeDelivered=true for history.`;
}

function buildInboxV2Text(messages: AgentInboxMessageV2Record[], readReceiptCount = 0): string {
	if (messages.length === 0) return "No unread hierarchy inbox messages.";
	const body = messages
		.map((entry) => {
			const payloadText = truncateText(JSON.stringify(entry.message.payload), 180);
			const recipient = entry.recipient.recipientKind === "agent" ? entry.recipient.recipientAgentId : entry.recipient.recipientKind;
			return `${entry.message.id} · ${entry.message.kind} · sender=${entry.message.senderKind}:${entry.message.senderAgentId ?? "-"} · recipient=${entry.recipient.recipientKind}:${recipient ?? "-"} · recipientRow=${entry.recipient.id} · status=${entry.recipient.status} · route=${entry.recipient.routeId ?? "-"}\n${payloadText}`;
		})
		.join("\n\n");
	if (readReceiptCount <= 0) return body;
	return `${body}\n\nRead receipt: marked ${readReceiptCount} recipient row${readReceiptCount === 1 ? "" : "s"} read. Future unread inbox reads will omit ${readReceiptCount === 1 ? "it" : "them"}; pass includeDelivered=true for history.`;
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

function buildAttentionV2Text(items: AgentAttentionV2Record[], agentsById: Map<string, AgentSummary>, includeResolved: boolean): string {
	if (items.length === 0) return includeResolved ? "No hierarchy attention items matched." : "No open hierarchy attention items.";
	return items
		.map((item) => {
			const subject = item.subjectAgentId ? agentsById.get(item.subjectAgentId) : undefined;
			const owner = item.ownerKind === "agent" && item.ownerAgentId ? agentsById.get(item.ownerAgentId) : undefined;
			const payloadText = truncateText(JSON.stringify(item.payload), 180);
			return `${item.kind} · ${item.state} · owner=${item.ownerKind}:${item.ownerAgentId ?? "-"}${owner ? ` (${owner.profile})` : ""} · subject=${item.subjectAgentId ?? "-"}${subject ? ` (${truncateText(subject.title, 32)})` : ""}\nsummary: ${item.summary}\nmessageId: ${item.messageId ?? "-"}\nrecipientRowId: ${item.recipientRowId ?? "-"}\npayload: ${payloadText}`;
		})
		.join("\n\n");
}

function buildAdminAttentionText(
	legacyItems: AttentionItemRecord[],
	v2Items: AgentAttentionV2Record[],
	agentsById: Map<string, AgentSummary>,
	includeResolved: boolean,
): string {
	if (legacyItems.length === 0 && v2Items.length === 0) return includeResolved ? "No attention items matched." : "No open attention items.";
	const sections: string[] = [];
	if (legacyItems.length > 0) sections.push(`Legacy attention\n${buildAttentionText(legacyItems, agentsById, includeResolved)}`);
	if (v2Items.length > 0) sections.push(`Hierarchy attention\n${buildAttentionV2Text(v2Items, agentsById, includeResolved)}`);
	return sections.join("\n\n");
}

function attentionOwnerKindsForAudience(audience?: "all" | "coordinator" | "user"): AgentRecipientKind[] | undefined {
	if (audience === "user") return ["user"];
	if (audience === "coordinator") return ["root", "agent"];
	return undefined;
}

function resolveAdminAttentionV2Filters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { audience?: "all" | "coordinator" | "user"; includeResolved?: boolean; limit?: number },
	actor: AgentActorContext,
): ListAgentAttentionItemsV2Filters {
	const filters: ListAgentAttentionItemsV2Filters = {
		limit: params.limit,
		ownerKinds: attentionOwnerKindsForAudience(params.audience),
		states: params.includeResolved ? undefined : ["open", "acknowledged", "waiting_on_owner"],
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.subjectAgentIds = listHierarchyVisibleAgentIds(getTmuxAgentsDb(), actor, {
				spawnSessionId: ctx.sessionManager.getSessionId(),
				spawnSessionFile: ctx.sessionManager.getSessionFile(),
			});
			break;
		case "descendants":
			filters.subjectAgentIds = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

function attentionV2MatchesAudience(item: AgentAttentionV2Record, audience?: "all" | "coordinator" | "user"): boolean {
	if (audience === "user") return item.ownerKind === "user";
	if (audience === "coordinator") return item.ownerKind !== "user";
	return true;
}

function legacyAttentionDuplicatesV2(item: AttentionItemRecord, v2MessageIds: Set<string>, v2RecipientRowIds: Set<string>): boolean {
	if (item.messageId && v2MessageIds.has(item.messageId)) return true;
	const payload = item.payload && typeof item.payload === "object" ? (item.payload as Record<string, unknown>) : null;
	const payloadV2MessageId = typeof payload?.v2MessageId === "string" ? payload.v2MessageId : null;
	const payloadV2RecipientRowId = typeof payload?.v2RecipientRowId === "string" ? payload.v2RecipientRowId : null;
	return !!((payloadV2MessageId && v2MessageIds.has(payloadV2MessageId)) || (payloadV2RecipientRowId && v2RecipientRowIds.has(payloadV2RecipientRowId)));
}

function suppressDuplicateLegacyAttentionItems(legacyItems: AttentionItemRecord[], v2Items: AgentAttentionV2Record[]): AttentionItemRecord[] {
	const v2MessageIds = new Set(v2Items.map((item) => item.messageId).filter((value): value is string => Boolean(value)));
	const v2RecipientRowIds = new Set(v2Items.map((item) => item.recipientRowId).filter((value): value is string => Boolean(value)));
	if (v2MessageIds.size === 0 && v2RecipientRowIds.size === 0) return legacyItems;
	return legacyItems.filter((item) => !legacyAttentionDuplicatesV2(item, v2MessageIds, v2RecipientRowIds));
}

function payloadRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function payloadString(payload: unknown, key: string): string | null {
	const value = payloadRecord(payload)[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function payloadStringArray(payload: unknown, key: string): string[] {
	const value = payloadRecord(payload)[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function taskInteractionKindFromAttention(
	kind: AttentionItemRecord["kind"] | AgentAttentionV2Record["kind"],
	ownerKind: AgentRecipientKind,
): TaskInteractionRecord["kind"] {
	switch (kind) {
		case "question_for_user":
			return "user_question";
		case "question":
			return ownerKind === "user" ? "user_question" : "coordinator_question";
		case "approval":
			return "approval_request";
		case "change_request":
			return "change_request";
		case "blocked":
			return "blocker";
		case "complete":
			return "completion";
		default:
			return "coordinator_question";
	}
}

function taskInteractionIcon(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "❓";
		case "coordinator_question":
			return "?";
		case "approval_request":
			return "☑";
		case "change_request":
			return "↻";
		case "blocker":
			return "⛔";
		case "completion":
			return "✓";
		default:
			return "•";
	}
}

function taskInteractionLabel(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "user question";
		case "coordinator_question":
			return "coordinator question";
		case "approval_request":
			return "approval request";
		case "change_request":
			return "change request";
		case "blocker":
			return "blocker";
		case "completion":
			return "completion";
		default:
			return kind;
	}
}

function actorLabelForInteraction(agent: AgentSummary | undefined, fallbackAgentId: string | null): string {
	if (agent) return `${agent.profile}:${agent.id}`;
	return fallbackAgentId ? `agent:${fallbackAgentId}` : "system";
}

function ownerLabelForInteraction(interaction: TaskInteractionRecord): string {
	return interaction.ownerKind === "agent" ? `agent:${interaction.ownerAgentId ?? "-"}` : interaction.ownerKind;
}

function buildTaskInteractionActions(
	kind: TaskInteractionRecord["kind"],
	taskId: string,
	agentId: string | null,
	messageId: string | null,
	options: { interactionId?: string; canMessageAgent?: boolean } = {},
): { nextAction: string; actions: string[] } {
	const replyRef = messageId ? ` inReplyToMessageId=${messageId}` : "";
	const resolveRef = options.interactionId ? ` resolveInteractionId=${options.interactionId}` : "";
	const noteAction = (summary: string, resolutionKind = "resolved") => `task_note id=${taskId} summary="${summary}"${resolveRef} resolutionKind=${resolutionKind}`;
	const canMessageAgent = Boolean(agentId && options.canMessageAgent);
	const childAnswer = canMessageAgent
		? `subagent_message id=${agentId} kind=answer summary="<answer>" actionPolicy=resume_if_blocked${replyRef}`
		: noteAction("Answer recorded");
	const childRedirect = canMessageAgent
		? `subagent_message id=${agentId} kind=redirect summary="<requested change>" actionPolicy=replan${replyRef}`
		: noteAction("Change requested", "changes_requested");
	const notifyApproval = canMessageAgent ? `; subagent_message id=${agentId} kind=answer summary="Approved" actionPolicy=resume_if_blocked${replyRef}` : "";
	const notifyRejection = canMessageAgent ? `; subagent_message id=${agentId} kind=redirect summary="Rejected" actionPolicy=replan${replyRef}` : "";
	const notifyChanges = canMessageAgent ? `; subagent_message id=${agentId} kind=redirect summary="Changes requested" actionPolicy=replan${replyRef}` : "";
	switch (kind) {
		case "user_question":
			return {
				nextAction: "answer user-facing question, then resume or acknowledge the child",
				actions: [`answer: ${childAnswer}`, `fallback: ${noteAction("User answer recorded")}`],
			};
		case "coordinator_question":
			return {
				nextAction: "answer coordinator question through the child control plane",
				actions: [`answer: ${childAnswer}`, `note-only fallback: ${noteAction("Coordinator answer recorded")}`],
			};
		case "blocker":
			return {
				nextAction: "unblock with an answer, redirect, or resolved task note",
				actions: [`unblock: ${childAnswer}`, `redirect: ${childRedirect}`, `fallback: ${noteAction("Blocker disposition")}`],
			};
		case "approval_request":
			return {
				nextAction: "approve, reject, or request changes; disposition the interaction with task_note so the card closes",
				actions: [
					`approve: ${noteAction("Approved", "approved")}${notifyApproval}`,
					`reject: ${noteAction("Rejected", "rejected")}${notifyRejection}`,
					`request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`,
				],
			};
		case "change_request":
			return {
				nextAction: "record requested changes and disposition the interaction",
				actions: [`request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`, `resolve: ${noteAction("Change request recorded")}`],
			};
		case "completion":
			return {
				nextAction: "review handoff, then accept or request changes; task_note closes the completion card even for terminal agents",
				actions: [`approve: ${noteAction("Completion accepted", "approved")}`, `request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`],
			};
		default:
			return { nextAction: "triage interaction", actions: [`note: ${noteAction("Interaction triaged")}`] };
	}
}

function taskInteractionFromLegacyAttention(item: AttentionItemRecord, agent: AgentSummary | undefined): TaskInteractionRecord | null {
	const taskId = agent?.taskId ?? null;
	if (!taskId) return null;
	const ownerKind: AgentRecipientKind = item.audience === "user" ? "user" : "root";
	const messageId = payloadString(item.payload, "v2MessageId") ?? item.messageId;
	const recipientRowId = payloadString(item.payload, "v2RecipientRowId");
	const kind = taskInteractionKindFromAttention(item.kind, ownerKind);
	const interactionId = `legacy:${item.id}`;
	const actionInfo = buildTaskInteractionActions(kind, taskId, item.agentId, messageId, {
		interactionId,
		canMessageAgent: Boolean(agent && !TERMINAL_AGENT_STATES.includes(agent.state)),
	});
	return {
		id: interactionId,
		source: "legacy_attention",
		sourceId: item.id,
		taskId,
		agentId: item.agentId,
		actorLabel: actorLabelForInteraction(agent, item.agentId),
		ownerKind,
		ownerAgentId: null,
		kind,
		state: item.state,
		priority: item.priority,
		summary: item.summary,
		details: payloadString(item.payload, "details"),
		answerNeeded: payloadString(item.payload, "answerNeeded"),
		recommendedNextAction: payloadString(item.payload, "recommendedNextAction"),
		files: payloadStringArray(item.payload, "files"),
		messageId,
		recipientRowId,
		nextAction: actionInfo.nextAction,
		actions: actionInfo.actions,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

function taskInteractionFromAgentAttentionV2(item: AgentAttentionV2Record, agentsById: Map<string, AgentSummary>): TaskInteractionRecord | null {
	const subject = item.subjectAgentId ? agentsById.get(item.subjectAgentId) : undefined;
	const taskId = item.taskId ?? subject?.taskId ?? null;
	if (!taskId) return null;
	const kind = taskInteractionKindFromAttention(item.kind, item.ownerKind);
	const interactionId = `v2:${item.id}`;
	const actionInfo = buildTaskInteractionActions(kind, taskId, item.subjectAgentId, item.messageId, {
		interactionId,
		canMessageAgent: Boolean(subject && !TERMINAL_AGENT_STATES.includes(subject.state)),
	});
	return {
		id: interactionId,
		source: "hierarchy_attention",
		sourceId: item.id,
		taskId,
		agentId: item.subjectAgentId,
		actorLabel: actorLabelForInteraction(subject, item.subjectAgentId),
		ownerKind: item.ownerKind,
		ownerAgentId: item.ownerAgentId,
		kind,
		state: item.state,
		priority: item.priority,
		summary: item.summary,
		details: payloadString(item.payload, "details"),
		answerNeeded: payloadString(item.payload, "answerNeeded"),
		recommendedNextAction: payloadString(item.payload, "recommendedNextAction"),
		files: payloadStringArray(item.payload, "files"),
		messageId: item.messageId,
		recipientRowId: item.recipientRowId,
		nextAction: actionInfo.nextAction,
		actions: actionInfo.actions,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

function addTaskInteraction(result: Map<string, TaskInteractionRecord[]>, interaction: TaskInteractionRecord | null, taskIds?: Set<string>): void {
	if (!interaction) return;
	if (taskIds && !taskIds.has(interaction.taskId)) return;
	const existing = result.get(interaction.taskId) ?? [];
	existing.push(interaction);
	result.set(interaction.taskId, existing);
}

function sortTaskInteractionsByPriority(items: TaskInteractionRecord[]): TaskInteractionRecord[] {
	return [...items].sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt || left.createdAt - right.createdAt);
}

function buildTaskInteractionsByTask(
	legacyItems: AttentionItemRecord[],
	v2Items: AgentAttentionV2Record[],
	agentsById: Map<string, AgentSummary>,
	taskIds?: Set<string>,
): Map<string, TaskInteractionRecord[]> {
	const result = new Map<string, TaskInteractionRecord[]>();
	for (const item of v2Items) {
		addTaskInteraction(result, taskInteractionFromAgentAttentionV2(item, agentsById), taskIds);
	}
	for (const item of suppressDuplicateLegacyAttentionItems(legacyItems, v2Items)) {
		addTaskInteraction(result, taskInteractionFromLegacyAttention(item, agentsById.get(item.agentId)), taskIds);
	}
	for (const [taskId, interactions] of result.entries()) {
		result.set(taskId, sortTaskInteractionsByPriority(interactions));
	}
	return result;
}

function mergeAgentAttentionV2Items(...groups: AgentAttentionV2Record[][]): AgentAttentionV2Record[] {
	const byId = new Map<string, AgentAttentionV2Record>();
	for (const group of groups) {
		for (const item of group) byId.set(item.id, item);
	}
	return [...byId.values()];
}

function listTaskInteractionsForTaskIds(taskIds: string[]): Map<string, TaskInteractionRecord[]> {
	if (taskIds.length === 0) return new Map();
	const db = getTmuxAgentsDb();
	const links = listTaskAgentLinks(db, { taskIds, limit: Math.max(1, Math.min(taskIds.length * 50, 500)) });
	const agentIds = Array.from(new Set(links.map((link) => link.agentId)));
	const agents = agentIds.length > 0 ? listAgents(db, { ids: agentIds, limit: agentIds.length }) : [];
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const legacyItems = agentIds.length > 0 ? listAttentionItems(db, { agentIds, states: OPEN_ATTENTION_STATES, limit: 500 }) : [];
	const directV2Items = listAgentAttentionItemsV2(db, { taskIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 });
	const subjectV2Items = agentIds.length > 0
		? listAgentAttentionItemsV2(db, { subjectAgentIds: agentIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 })
		: [];
	return buildTaskInteractionsByTask(legacyItems, mergeAgentAttentionV2Items(directV2Items, subjectV2Items), agentsById, new Set(taskIds));
}

function getTaskInteractions(taskId: string): TaskInteractionRecord[] {
	return listTaskInteractionsForTaskIds([taskId]).get(taskId) ?? [];
}

function formatTaskInteractionCard(interaction: TaskInteractionRecord): string {
	const lines = [
		`- ${taskInteractionIcon(interaction.kind)} ${taskInteractionLabel(interaction.kind)} · ${interaction.state} · from=${interaction.actorLabel} · owner=${ownerLabelForInteraction(interaction)}`,
		`  summary: ${interaction.summary}`,
	];
	if (interaction.answerNeeded) lines.push(`  answerNeeded: ${interaction.answerNeeded}`);
	if (interaction.recommendedNextAction) lines.push(`  childNext: ${interaction.recommendedNextAction}`);
	if (interaction.details) lines.push(`  details: ${truncateText(interaction.details, 220)}`);
	if (interaction.files.length > 0) lines.push(`  files: ${interaction.files.join(", ")}`);
	lines.push(`  next: ${interaction.nextAction}`);
	for (const action of interaction.actions) lines.push(`  action: ${action}`);
	return lines.join("\n");
}

function resolvedInteractionState(resolutionKind: string): "resolved" | "superseded" | "cancelled" {
	if (resolutionKind === "cancelled") return "cancelled";
	if (["rejected", "changes_requested", "superseded"].includes(resolutionKind)) return "superseded";
	return "resolved";
}

function sqlPlaceholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

function resolveTaskInteractionWithNote(taskId: string, interactionId: string, resolutionKind: string, resolutionSummary: string): { source: "legacy" | "v2"; changes: number } {
	const [source, ...rest] = interactionId.split(":");
	const sourceId = rest.join(":");
	if (!sourceId || (source !== "legacy" && source !== "v2")) {
		throw new Error(`Invalid task interaction id \"${interactionId}\". Expected legacy:<id> or v2:<id>.`);
	}
	const db = getTmuxAgentsDb();
	const now = Date.now();
	const state = resolvedInteractionState(resolutionKind);
	if (source === "legacy") {
		const result = db.prepare(
			`UPDATE attention_items
			 SET state = ?, updated_at = ?, resolved_at = ?, resolution_kind = ?, resolution_summary = ?
			 WHERE id = ?
				AND state IN (${sqlPlaceholders(OPEN_ATTENTION_STATES.length)})
				AND agent_id IN (SELECT id FROM agents WHERE task_id = ?)`,
		).run(state, now, now, resolutionKind, resolutionSummary, sourceId, ...OPEN_ATTENTION_STATES, taskId) as { changes?: number };
		return { source, changes: Number(result.changes ?? 0) };
	}
	const result = db.prepare(
		`UPDATE agent_attention_items_v2
		 SET state = ?, updated_at = ?, resolved_at = ?, resolution_kind = ?, resolution_summary = ?
		 WHERE id = ?
			AND state IN (${sqlPlaceholders(OPEN_AGENT_ATTENTION_V2_STATES.length)})
			AND (task_id = ? OR subject_agent_id IN (SELECT id FROM agents WHERE task_id = ?))`,
	).run(state, now, now, resolutionKind, resolutionSummary, sourceId, ...OPEN_AGENT_ATTENTION_V2_STATES, taskId, taskId) as { changes?: number };
	return { source, changes: Number(result.changes ?? 0) };
}

function formatTaskAttentionLine(item: TaskAttentionRecord): string {
	const bits = [
		item.status,
		`health=${item.health}`,
		`lastUseful=${formatStandupAge(item.lastUsefulUpdateAt ?? 0)}`,
		item.waitingOn ? `waiting=${item.waitingOn}` : null,
		item.unresolvedDependencyCount > 0 ? `deps=${item.unresolvedDependencyCount}` : null,
		item.readyUnblocked ? "dependency-ready" : null,
		`${item.activeAgentCount} active-agent`,
		`${item.openAttentionCount} attention`,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${item.taskId} · ${truncateText(item.title, 42)} · ${bits}`;
}

function buildTaskAttentionText(items: TaskAttentionRecord[], interactionsByTask: Map<string, TaskInteractionRecord[]> = new Map()): string {
	if (items.length === 0) return "No task attention items.";
	return items
		.map((item) => {
			const interactions = interactionsByTask.get(item.taskId) ?? [];
			const interactionText = interactions.length > 0 ? `\ninteractions:\n${interactions.map(formatTaskInteractionCard).join("\n")}` : "";
			return `${formatTaskAttentionLine(item)}\nnext: ${item.nextAction}\nsummary: ${item.summary}\nblocked: ${item.blockedReason ?? "-"}\nreview: ${item.reviewSummary ?? "-"}${interactionText}`;
		})
		.join("\n\n");
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
	const attentionByAgent = new Map<string, AttentionItemRecord[]>();
	const attentionItems = listAttentionItems(db, {
		agentIds: agents.map((agent) => agent.id),
		states: OPEN_ATTENTION_STATES,
		limit: 500,
	});
	for (const item of attentionItems) {
		const items = attentionByAgent.get(item.agentId) ?? [];
		items.push(item);
		attentionByAgent.set(item.agentId, items);
	}
	return agents
		.filter((agent) => TERMINAL_AGENT_STATES.includes(agent.state))
		.map((agent) => {
			const items = (attentionByAgent.get(agent.id) ?? []).sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
			const targetExists = tmuxTargetExists(
				{
					sessionId: agent.tmuxSessionId,
					sessionName: agent.tmuxSessionName,
					windowId: agent.tmuxWindowId,
					paneId: agent.tmuxPaneId,
				},
				inventory,
			);
			const blockingItems = items.filter((item) => item.kind !== "complete");
			let cleanupAllowed = targetExists;
			let reason = !targetExists ? "tmux target already gone" : items.length === 0 ? "no unresolved attention items" : "completion attention can be resolved during cleanup";
			if (blockingItems.length > 0 && !(params.force ?? false)) {
				cleanupAllowed = false;
				reason = `blocked by unresolved ${blockingItems[0]!.kind}`;
			}
			if (blockingItems.length > 0 && (params.force ?? false)) {
				reason = `force cleanup despite unresolved ${blockingItems[0]!.kind}`;
			}
			return { agent, attentionItems: items, targetExists, cleanupAllowed, reason };
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
	if (completionItems.length > 0) {
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
	}
	if (force) {
		const blockingKinds = candidate.attentionItems.filter((item) => item.kind !== "complete").map((item) => item.kind);
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
		}
	}
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: "cleaned_up",
		summary: force ? "Cleaned up tmux target with force." : "Cleaned up tmux target after terminal state.",
		payload: { command: result.command, force },
	});
	if (agent.taskId) {
		unlinkTaskAgent(db, agent.taskId, agent.id, force ? "cleanup_force" : "cleanup_terminal_agent");
	}
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
			return `${candidate.cleanupAllowed ? "✓" : "-"} ${candidate.agent.id} · ${candidate.agent.state} · ${candidate.reason} · attention=${attention}`;
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

function isCoalescableWake(kind: AgentMessageRecord["kind"], actionPolicy: DownwardMessageActionPolicy | undefined): boolean {
	return actionPolicy === "resume_if_blocked" && ["answer", "note", "priority"].includes(kind);
}

function coalesceQueuedDownwardWakeMessages(
	db: ReturnType<typeof getTmuxAgentsDb>,
	agent: AgentSummary,
	kind: "answer" | "note" | "redirect" | "cancel" | "priority",
	actionPolicy: DownwardMessageActionPolicy,
): { expiredMessageIds: string[]; expiredV2MessageIds: string[]; expiredV2RecipientRowIds: string[]; coalescedWakeMessages: NonNullable<DownwardMessagePayload["coalescedWakeMessages"]> } {
	if (!isCoalescableWake(kind, actionPolicy)) {
		return { expiredMessageIds: [], expiredV2MessageIds: [], expiredV2RecipientRowIds: [], coalescedWakeMessages: [] };
	}
	const queued = listMessagesForRecipient(db, agent.id, { targetKind: "child", limit: 100 }).filter((message) => {
		const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
		return isCoalescableWake(message.kind, payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind as "answer" | "note" | "redirect" | "cancel" | "priority"));
	});
	if (queued.length === 0) {
		return { expiredMessageIds: [], expiredV2MessageIds: [], expiredV2RecipientRowIds: [], coalescedWakeMessages: [] };
	}
	const { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages } = collectQueuedWakeCoalescingContext(queued);
	markAgentMessages(db, expiredMessageIds, "expired");
	markAgentMessageRecipientsByMessageIds(db, expiredV2MessageIds, "expired", { recipientAgentId: agent.id, transportKind: "inbox" });
	markAgentMessageRecipientsByIds(db, expiredV2RecipientRowIds, "expired", { recipientAgentId: agent.id, transportKind: "inbox" });
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: "downward_wake_coalesced",
		summary: `Coalesced ${queued.length} queued resume/wake message${queued.length === 1 ? "" : "s"}.`,
		payload: { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages, replacementKind: kind, actionPolicy },
	});
	return { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages };
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
	if (payload.coalescedMessageIds && payload.coalescedMessageIds.length > 0) {
		lines.push("", `Coalesced prior resume/wake messages: ${payload.coalescedMessageIds.join(", ")}`);
	}
	if (payload.coalescedWakeMessages && payload.coalescedWakeMessages.length > 0) {
		lines.push("", "Prior coalesced wake context:");
		for (const prior of payload.coalescedWakeMessages) {
			lines.push(`- ${prior.kind} ${prior.id}: ${prior.summary}`);
			if (prior.details) lines.push(`  details: ${truncateText(prior.details, 220)}`);
			if (prior.files && prior.files.length > 0) lines.push(`  files: ${prior.files.join(", ")}`);
			if (prior.inReplyToMessageId) lines.push(`  inReplyToMessageId: ${prior.inReplyToMessageId}`);
		}
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
			const v2Payload = (message.payload && typeof message.payload === "object" ? message.payload : null) as DownwardMessagePayload | null;
			if (v2Payload?.v2RecipientRowId) {
				markAgentMessageRecipientsByIds(db, [v2Payload.v2RecipientRowId], "acked", {
					recipientAgentId: agent.id,
					transportKind: "rpc_bridge",
				});
			} else if (v2Payload?.v2MessageId) {
				markAgentMessageRecipientsByMessageIds(db, [v2Payload.v2MessageId], "acked", {
					recipientAgentId: agent.id,
					transportKind: "rpc_bridge",
				});
			}
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
	actor: AgentActorContext = createRootActorContext(),
): string {
	const db = getTmuxAgentsDb();
	const messageId = randomUUID();
	const fullPayload: DownwardMessagePayload = {
		...payload,
		senderKind: actor.kind === "root" ? "root" : "agent",
		senderAgentId: actor.kind === "agent" ? actor.agentId : null,
		actionPolicy: payload.actionPolicy ?? defaultDownwardActionPolicy(kind),
	};
	const coalescedWake = coalesceQueuedDownwardWakeMessages(db, agent, kind, fullPayload.actionPolicy!);
	if (coalescedWake.expiredMessageIds.length > 0) {
		fullPayload.coalescedMessageIds = coalescedWake.expiredMessageIds;
		fullPayload.coalescedV2MessageIds = coalescedWake.expiredV2MessageIds;
		fullPayload.coalescedV2RecipientRowIds = coalescedWake.expiredV2RecipientRowIds;
		fullPayload.coalescedWakeMessages = coalescedWake.coalescedWakeMessages;
	}
	createAgentMessage(db, {
		id: messageId,
		threadId: agent.id,
		senderAgentId: actor.kind === "agent" ? actor.agentId : null,
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
		payload: { messageId, deliveryMode, coalescedWake, ...fullPayload },
	});
	if (kind === "cancel") {
		updateAttentionItemsForAgent(
			db,
			agent.id,
			{
				state: "cancelled",
				updatedAt: Date.now(),
				resolvedAt: Date.now(),
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
		);
	} else if (["answer", "redirect", "priority"].includes(kind)) {
		updateAttentionItemsForAgent(
			db,
			agent.id,
			{
				state: "acknowledged",
				updatedAt: Date.now(),
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			},
			{
				states: ["open", "waiting_on_coordinator", "waiting_on_user"],
				kinds: ["question", "question_for_user", "blocked"],
			},
		);
	}
	if (actor.kind === "agent") {
		updateAgentAttentionItemsV2ForOwner(
			db,
			{ kind: "agent", agentId: actor.agentId },
			{
				state: kind === "cancel" ? "cancelled" : "acknowledged",
				updatedAt: Date.now(),
				resolvedAt: kind === "cancel" ? Date.now() : undefined,
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			},
			{
				states: ["open", "waiting_on_owner"],
				kinds: ["question", "question_for_user", "blocked"],
				subjectAgentIds: [agent.id],
			},
		);
	} else {
		updateAgentAttentionItemsV2ForOwner(
			db,
			{ kind: "root" },
			{
				state: kind === "cancel" ? "cancelled" : "acknowledged",
				updatedAt: Date.now(),
				resolvedAt: kind === "cancel" ? Date.now() : undefined,
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			},
			{
				states: ["open", "waiting_on_owner"],
				kinds: ["question", "question_for_user", "blocked"],
				subjectAgentIds: [agent.id],
			},
		);
	}
	updateAgent(db, agent.id, { updatedAt: Date.now() });
	return messageId;
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
		updateAgent(getTmuxAgentsDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		if (agent.taskId) {
			unlinkTaskAgent(getTmuxAgentsDb(), agent.taskId, agent.id, reason?.trim() || "force_stop_missing_tmux_target");
		}
		updateAttentionItemsForAgent(
			getTmuxAgentsDb(),
			agent.id,
			{
				state: "cancelled",
				updatedAt: Date.now(),
				resolvedAt: Date.now(),
				resolutionKind: "force_stop",
				resolutionSummary: reason?.trim() || "tmux target missing; registry marked stopped.",
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
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
		updateAgent(getTmuxAgentsDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		if (agent.taskId) {
			unlinkTaskAgent(getTmuxAgentsDb(), agent.taskId, agent.id, reason?.trim() || "force_stop");
		}
		updateAttentionItemsForAgent(
			getTmuxAgentsDb(),
			agent.id,
			{
				state: "cancelled",
				updatedAt: Date.now(),
				resolvedAt: Date.now(),
				resolutionKind: "force_stop",
				resolutionSummary: reason?.trim() || "Force stop issued by coordinator.",
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
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
	recommendedProfile?: string;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	labels?: string[];
	files?: string[];
	status?: TaskState;
	blockedReason?: string;
	waitingOn?: TaskWaitingOn;
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
		recommendedProfile: params.recommendedProfile?.trim() || null,
		waitingOn: params.waitingOn,
		blockedReason: params.blockedReason?.trim() || null,
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
			recommendedProfile: input.recommendedProfile ?? null,
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
	allowDuplicateOwner?: boolean;
}): TaskRecord {
	const db = getTmuxAgentsDb();
	const existingTaskId = params.taskId?.trim() || null;
	if (existingTaskId) {
		const task = getTask(db, existingTaskId);
		if (!task) throw new Error(`Unknown task id \"${existingTaskId}\".`);
		const unresolved = listUnresolvedTaskDependencies(db, [existingTaskId]).get(existingTaskId) ?? [];
		if (unresolved.length > 0) {
			throw new Error(`Task ${existingTaskId} has unresolved dependencies: ${unresolved.map((link) => link.targetTaskId).join(", ")}. Do not spawn an agent for this ticket until dependencies resolve.`);
		}
		assertTaskLeaseAvailable(db, {
			taskId: existingTaskId,
			profile: params.profile,
			allowDuplicateOwner: params.allowDuplicateOwner,
		});
		const now = Date.now();
		const requestedLeaseKind = taskLeaseKindForProfile(params.profile);
		const status: TaskState = requestedLeaseKind === "review" && task.status === "in_review" ? "in_review" : "in_progress";
		updateTask(db, existingTaskId, {
			status,
			waitingOn: null,
			blockedReason: null,
			updatedAt: now,
			startedAt: status === "in_progress" ? task.startedAt ?? now : task.startedAt,
			reviewRequestedAt: status === "in_review" ? task.reviewRequestedAt ?? now : task.reviewRequestedAt,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: existingTaskId,
			eventType: "spawn_requested",
			summary: `Spawn requested for ${params.profile}`,
			payload: { title: params.title, task: params.task },
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
	const linkedAgents = getTaskLinkedAgents(taskId, true).sort(
		(left, right) =>
			(taskLeaseKindForProfile(left.profile) === "exclusive" ? 0 : 1) - (taskLeaseKindForProfile(right.profile) === "exclusive" ? 0 : 1) ||
			left.createdAt - right.createdAt,
	);
	if (linkedAgents.length === 0) return null;
	if (linkedAgents.length === 1 || !ctx.hasUI) return linkedAgents[0] ?? null;
	const selection = await ctx.ui.select(
		`${actionLabel}: choose linked agent`,
		linkedAgents.map((agent) => `${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}`),
	);
	if (!selection) return null;
	return linkedAgents.find((agent) => `${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}` === selection) ?? linkedAgents[0] ?? null;
}

function spawnChildFromParams(pi: ExtensionAPI, ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	taskId?: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	parentAgentId?: string;
	priority?: string;
	allowDuplicateOwner?: boolean;
}): SpawnSubagentResult {
	const profile = requireProfile(params.profile);
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	const actor = resolveToolActorContext(ctx);
	let parentAgentId = params.parentAgentId?.trim() || null;
	if (actor.kind === "agent") {
		if (!parentAgentId) {
			parentAgentId = actor.agentId;
		} else if (parentAgentId !== actor.agentId && !actor.canAdminOverride) {
			throw new Error(`Child session ${actor.agentId} may only spawn direct children under itself; requested parentAgentId=${parentAgentId}.`);
		}
	}
	const task = ensureTaskForSpawn(ctx, {
		title: params.title,
		task: params.task,
		profile: params.profile,
		cwd: spawnCwd,
		taskId: params.taskId,
		priority: params.priority,
		allowDuplicateOwner: params.allowDuplicateOwner,
	});
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
		parentAgentId,
		spawnedByAgentId: actor.kind === "agent" ? actor.agentId : null,
		createdByKind: actor.kind === "agent" ? "agent" : "root",
		allowDuplicateOwner: params.allowDuplicateOwner,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
	pi.appendEntry(SESSION_CHILD_LINK_ENTRY_TYPE, result.sessionLinkData);
	updateFleetUi(ctx);
	return result;
}

function buildDispatchTaskPrompt(task: TaskRecord): string {
	return [
		`Task ${task.id}: ${task.title}`,
		task.summary ? `Summary: ${task.summary}` : null,
		task.description ? `Description: ${task.description}` : null,
		task.acceptanceCriteria.length > 0 ? "" : null,
		task.acceptanceCriteria.length > 0 ? "Acceptance criteria:" : null,
		...task.acceptanceCriteria.map((item) => `- ${item}`),
		task.validationSteps.length > 0 ? "" : null,
		task.validationSteps.length > 0 ? "Validation:" : null,
		...task.validationSteps.map((item) => `- ${item}`),
		task.files.length > 0 ? "" : null,
		task.files.length > 0 ? "Relevant files:" : null,
		...task.files.map((item) => `- ${item}`),
		"",
		"This ticket is dependency-ready. Work only this task. If blocked, publish one concrete question/blocker and recommend the task state. On completion, include files changed, validation run, and whether it should move to in_review/done.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function getReadyTasksForDispatch(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session" | "descendants"; ids?: string[]; recommendedProfile?: string; limit?: number }): TaskReadinessRecord[] {
	const scope = params.scope ?? "current_project";
	const filters = resolveTaskFilters(ctx, scope, {
		statuses: ["todo"],
		recommendedProfile: params.recommendedProfile,
		includeDone: false,
		limit: params.limit ?? 100,
	});
	if (params.ids && params.ids.length > 0) filters.ids = params.ids;
	return listTaskReadiness(getTmuxAgentsDb(), filters).filter((item) => item.ready);
}

function dispatchReadyTasks(pi: ExtensionAPI, ctx: ExtensionContext, items: TaskReadinessRecord[], options: { fallbackProfile?: string; maxDispatch?: number; dryRun?: boolean } = {}): {
	dispatched: Array<{ taskId: string; profile: string; agentId: string; title: string }>;
	skipped: Array<{ taskId: string; reason: string }>;
	preview: Array<{ taskId: string; profile: string; title: string }>;
} {
	const maxDispatch = Math.max(1, Math.min(options.maxDispatch ?? 5, 20));
	const dispatched: Array<{ taskId: string; profile: string; agentId: string; title: string }> = [];
	const skipped: Array<{ taskId: string; reason: string }> = [];
	const preview: Array<{ taskId: string; profile: string; title: string }> = [];
	for (const item of items) {
		if (preview.length >= maxDispatch) break;
		const profileName = item.task.recommendedProfile ?? options.fallbackProfile?.trim() ?? null;
		if (!profileName) {
			skipped.push({ taskId: item.task.id, reason: "missing recommendedProfile and no fallbackProfile provided" });
			continue;
		}
		try {
			requireProfile(profileName);
		} catch (error) {
			skipped.push({ taskId: item.task.id, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		preview.push({ taskId: item.task.id, profile: profileName, title: item.task.title });
		if (options.dryRun) continue;
		const result = spawnChildFromParams(pi, ctx, {
			title: item.task.title,
			task: buildDispatchTaskPrompt(item.task),
			profile: profileName,
			taskId: item.task.id,
			cwd: item.task.spawnCwd,
			priority: item.task.priorityLabel ?? `p${item.task.priority}`,
		});
		dispatched.push({ taskId: item.task.id, profile: profileName, agentId: result.agentId, title: item.task.title });
	}
	return { dispatched, skipped, preview };
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

function boardLaneForTask(task: TaskRecord): BoardLaneId {
	return task.status;
}

function buildBoardScopeData(
	tasks: TaskRecord[],
	agents: AgentSummary[],
	attentionItems: AttentionItemRecord[],
	v2AttentionItems: AgentAttentionV2Record[] = [],
): AgentsBoardData["scopes"]["all"] {
	const db = getTmuxAgentsDb();
	const taskIds = tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const links = listTaskAgentLinks(db, { taskIds, limit: 500 });
	const linkRoleByTaskAgent = new Map(links.map((link) => [`${link.taskId}:${link.agentId}`, link.role] as const));
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const agentsByTaskId = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (!agent) continue;
		const existing = agentsByTaskId.get(link.taskId) ?? [];
		existing.push(agent);
		agentsByTaskId.set(link.taskId, existing);
	}
	const interactionsByTaskId = buildTaskInteractionsByTask(attentionItems, v2AttentionItems, agentsById, taskIdSet);
	const healthByTaskId = listTaskHealth(db, tasks);
	const openAttentionCounts = new Map<string, number>();
	for (const [taskId, interactions] of interactionsByTaskId.entries()) {
		openAttentionCounts.set(taskId, interactions.length);
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
		const activeLinkedAgents = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state));
		const activeExclusiveOwners = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "exclusive");
		const activeReviewers = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "review");
		const activeAgentCount = activeLinkedAgents.length;
		const linkedProfiles = Array.from(new Set(linkedAgents.map((agent) => agent.profile))).sort();
		const laneId = boardLaneForTask(task);
		const openAttentionCount = openAttentionCounts.get(task.id) ?? 0;
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
			exclusiveOwnerCount: activeExclusiveOwners.length,
			reviewerCount: activeReviewers.length,
			ownerAgentIds: activeExclusiveOwners.map((agent) => agent.id),
			linkedProfiles,
			openAttentionCount,
			health: healthByTaskId.get(task.id) ?? deriveTaskHealth({ task, activeAgentCount, linkedAgentCount: linkedAgents.length, openAttentionCount }),
			summary: task.blockedReason ?? task.reviewSummary ?? task.summary ?? task.finalSummary ?? task.description ?? "-",
		};
		lanes[laneId].push(ticket);
	}
	for (const laneId of Object.keys(lanes) as BoardLaneId[]) {
		lanes[laneId].sort(
			(left, right) =>
				right.openAttentionCount - left.openAttentionCount ||
				(left.waitingOn === "user" ? -1 : 0) - (right.waitingOn === "user" ? -1 : 0) ||
				left.priority - right.priority ||
				right.updatedAt - left.updatedAt,
		);
	}
	return { lanes, tasksById, agentsByTaskId, interactionsByTaskId };
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
	const scopeAttentionV2 = {
		all: listAgentAttentionItemsV2(db, { states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
		current_project: listAgentAttentionItemsV2(db, { projectKey: getProjectKey(ctx.cwd), states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
		current_session: mergeAgentAttentionV2Items(
			listAgentAttentionItemsV2(db, { taskIds: scopeTasks.current_session.map((task) => task.id), states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
			listAgentAttentionItemsV2(db, { subjectAgentIds: scopeAgents.current_session.map((agent) => agent.id), states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
		),
		descendants: mergeAgentAttentionV2Items(
			listAgentAttentionItemsV2(db, { taskIds: scopeTasks.descendants.map((task) => task.id), states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
			listAgentAttentionItemsV2(db, { subjectAgentIds: scopeAgents.descendants.map((agent) => agent.id), states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
		),
	};
	return {
		scopes: {
			all: buildBoardScopeData(scopeTasks.all, scopeAgents.all, scopeAttention.all, scopeAttentionV2.all),
			current_project: buildBoardScopeData(scopeTasks.current_project, scopeAgents.current_project, scopeAttention.current_project, scopeAttentionV2.current_project),
			current_session: buildBoardScopeData(scopeTasks.current_session, scopeAgents.current_session, scopeAttention.current_session, scopeAttentionV2.current_session),
			descendants: buildBoardScopeData(scopeTasks.descendants, scopeAgents.descendants, scopeAttention.descendants, scopeAttentionV2.descendants),
		},
	};
}

function formatStandupAge(timestamp: number): string {
	if (!timestamp) return "unknown";
	const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function standupNextAction(ticket: BoardTicket, linkedAgents: AgentSummary[]): string {
	if (ticket.openAttentionCount > 0) return ticket.waitingOn === "user" ? "answer user interaction" : "triage task interaction";
	if (ticket.health.nextAction) return ticket.health.nextAction;
	if (ticket.waitingOn) return `waiting on ${ticket.waitingOn}`;
	if (ticket.laneId === "blocked") return "add waitingOn or unblock";
	if (ticket.laneId === "in_review") return "run/synthesize review gate";
	if (ticket.laneId === "in_progress") return ticket.exclusiveOwnerCount > 0 ? "let owner run; inspect only if stale" : "assign owner or move todo";
	if (ticket.laneId === "todo") return ticket.exclusiveOwnerCount > 0 ? "inspect existing owner before spawning" : "spawn next specialist";
	if (ticket.laneId === "done") return ticket.activeAgentCount > 0 ? "cleanup active links/agents" : "archive context if useful";
	return "inspect task";
}

function formatStandupTicketLine(ticket: BoardTicket, linkedAgents: AgentSummary[] = []): string {
	const flags = [
		`status=${ticket.laneId}`,
		`health=${ticket.health.state}`,
		`lastUseful=${formatStandupAge(ticket.health.lastUsefulUpdateAt ?? 0)}`,
		`waiting=${ticket.waitingOn ?? "-"}`,
		`owners=${ticket.exclusiveOwnerCount}`,
		`reviewers=${ticket.reviewerCount}`,
		`agents=${ticket.activeAgentCount}`,
		`interactions=${ticket.openAttentionCount}`,
		`p${ticket.priority}`,
		`updated=${formatStandupAge(ticket.updatedAt)}`,
	].join(" · ");
	return `- ${ticket.taskId} · ${truncateText(ticket.title, 64)} · ${flags}\n  healthReason: ${truncateText(ticket.health.reason, 140)}\n  next: ${standupNextAction(ticket, linkedAgents)}${ticket.blockedReason ? `\n  blocked: ${truncateText(ticket.blockedReason, 120)}` : ""}`;
}

interface StandupDependencyChain {
	source: TaskReadinessRecord;
	path: TaskLinkWithTasksRecord[];
	terminalTask: TaskRecord | null;
	terminalStatus: TaskState;
	terminalTitle: string;
	blockedTaskCount: number;
}

function standupTaskStatusRank(status: TaskState): number {
	switch (status) {
		case "blocked":
			return 0;
		case "in_review":
			return 1;
		case "in_progress":
			return 2;
		case "todo":
			return 3;
		case "done":
			return 4;
		default:
			return 5;
	}
}

function compareStandupTickets(left: BoardTicket, right: BoardTicket): number {
	return (
		right.openAttentionCount - left.openAttentionCount ||
		(left.waitingOn === "user" ? -1 : 0) - (right.waitingOn === "user" ? -1 : 0) ||
		left.priority - right.priority ||
		right.updatedAt - left.updatedAt ||
		left.taskId.localeCompare(right.taskId)
	);
}

function compareDependencyLinks(left: TaskLinkWithTasksRecord, right: TaskLinkWithTasksRecord): number {
	return standupTaskStatusRank(left.targetStatus) - standupTaskStatusRank(right.targetStatus) || left.targetTaskId.localeCompare(right.targetTaskId);
}

function isStandupHealthConcern(ticket: BoardTicket): boolean {
	return ticket.laneId !== "done" && ticket.health.signals.some((signal) => signal !== "healthy" && signal !== "owner_active");
}

function formatStandupHealthLine(ticket: BoardTicket, linkedAgents: AgentSummary[] = []): string {
	const flags = [
		`health=${ticket.health.state}`,
		`lastUseful=${formatStandupAge(ticket.health.lastUsefulUpdateAt ?? 0)}`,
		`owners=${ticket.exclusiveOwnerCount}`,
		`agents=${ticket.activeAgentCount}`,
		`interactions=${ticket.openAttentionCount}`,
		`updated=${formatStandupAge(ticket.updatedAt)}`,
	].join(" · ");
	return `- ${ticket.taskId} · ${truncateText(ticket.title, 64)} · ${flags}\n  reason: ${truncateText(ticket.health.reason, 120)}\n  next: ${truncateText(standupNextAction(ticket, linkedAgents), 120)}`;
}

function appendStandupHealthSection(lines: string[], tickets: BoardTicket[], scopeData: AgentsBoardData["scopes"]["all"], limit = 6): void {
	lines.push("", "## Health / liveness");
	if (tickets.length === 0) {
		lines.push("- no tasks in scope");
		return;
	}
	const ownerActive = tickets.filter((ticket) => ticket.health.signals.includes("owner_active"));
	const stale = tickets.filter((ticket) => ticket.health.signals.includes("stale"));
	const noProgress = tickets.filter((ticket) => ticket.health.signals.includes("empty_or_no_progress"));
	const approval = tickets.filter((ticket) => ticket.health.signals.includes("approval_required") || ticket.health.signals.includes("needs_review"));
	const external = tickets.filter((ticket) => ticket.health.signals.includes("blocked_external"));
	lines.push(`- summary: owner-active ${ownerActive.length} · stale ${stale.length} · no-progress ${noProgress.length} · approval/review ${approval.length} · external/user-wait ${external.length}`);
	const concerns = tickets.filter(isStandupHealthConcern).sort(compareStandupTickets);
	if (concerns.length === 0) {
		lines.push("- no stale/no-progress/approval/external liveness concerns detected");
		return;
	}
	for (const ticket of concerns.slice(0, limit)) lines.push(formatStandupHealthLine(ticket, scopeData.agentsByTaskId.get(ticket.taskId) ?? []));
	if (concerns.length > limit) lines.push(`- +${concerns.length - limit} more`);
}

function buildDependencyPath(sourceTaskId: string, firstLink: TaskLinkWithTasksRecord, linksBySource: Map<string, TaskLinkWithTasksRecord[]>): TaskLinkWithTasksRecord[] {
	const path = [firstLink];
	const seen = new Set([sourceTaskId, firstLink.targetTaskId]);
	let currentTaskId = firstLink.targetTaskId;
	while (path.length < 8) {
		const next = (linksBySource.get(currentTaskId) ?? [])
			.filter((link) => link.unresolved && !seen.has(link.targetTaskId))
			.sort(compareDependencyLinks)[0];
		if (!next) break;
		path.push(next);
		currentTaskId = next.targetTaskId;
		seen.add(currentTaskId);
	}
	return path;
}

function buildStandupDependencyChains(readiness: TaskReadinessRecord[]): StandupDependencyChain[] {
	const readinessByTaskId = new Map(readiness.map((item) => [item.task.id, item] as const));
	const linksBySource = new Map<string, TaskLinkWithTasksRecord[]>();
	for (const item of readiness) {
		for (const link of item.unresolvedDependencies) {
			const links = linksBySource.get(link.sourceTaskId) ?? [];
			links.push(link);
			linksBySource.set(link.sourceTaskId, links);
		}
	}
	for (const [taskId, links] of linksBySource.entries()) linksBySource.set(taskId, links.sort(compareDependencyLinks));
	const chains: StandupDependencyChain[] = [];
	for (const item of readiness) {
		for (const link of item.unresolvedDependencies.sort(compareDependencyLinks)) {
			const path = buildDependencyPath(item.task.id, link, linksBySource);
			const terminalLink = path[path.length - 1] ?? link;
			const terminalTask = readinessByTaskId.get(terminalLink.targetTaskId)?.task ?? null;
			chains.push({
				source: item,
				path,
				terminalTask,
				terminalStatus: terminalTask?.status ?? terminalLink.targetStatus,
				terminalTitle: terminalTask?.title ?? terminalLink.targetTitle,
				blockedTaskCount: 1,
			});
		}
	}
	const terminalSources = new Map<string, Set<string>>();
	for (const chain of chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		if (!terminalTaskId) continue;
		const sources = terminalSources.get(terminalTaskId) ?? new Set<string>();
		sources.add(chain.source.task.id);
		terminalSources.set(terminalTaskId, sources);
	}
	for (const chain of chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		chain.blockedTaskCount = terminalTaskId ? terminalSources.get(terminalTaskId)?.size ?? 1 : 1;
	}
	return chains.sort(
		(left, right) =>
			right.blockedTaskCount - left.blockedTaskCount ||
			left.source.task.priority - right.source.task.priority ||
			standupTaskStatusRank(left.terminalStatus) - standupTaskStatusRank(right.terminalStatus) ||
			right.source.task.updatedAt - left.source.task.updatedAt ||
			left.source.task.id.localeCompare(right.source.task.id),
	);
}

function formatStandupDependencyChain(chain: StandupDependencyChain, scopeData: AgentsBoardData["scopes"]["all"], ticketsById: Map<string, BoardTicket>): string {
	const source = chain.source.task;
	const pathIds = [source.id, ...chain.path.map((link) => link.targetTaskId)];
	const terminalTaskId = pathIds[pathIds.length - 1] ?? source.id;
	const terminalTicket = ticketsById.get(terminalTaskId);
	const terminalNext = terminalTicket
		? standupNextAction(terminalTicket, scopeData.agentsByTaskId.get(terminalTicket.taskId) ?? [])
		: chain.terminalStatus === "done"
			? "refresh dependency state"
			: `finish or replan dependency in ${chain.terminalStatus}`;
	const rootHealth = terminalTicket ? ` · rootHealth=${terminalTicket.health.state}` : "";
	const parent = source.parentTaskId ? ` · parent=${source.parentTaskId}` : "";
	const multipleDeps = chain.source.unresolvedDependencies.length > 1 ? ` · directDeps=${chain.source.unresolvedDependencies.length}` : "";
	return `- ${pathIds.join(" → ")} · blocks ${chain.blockedTaskCount} task${chain.blockedTaskCount === 1 ? "" : "s"} · depth=${chain.path.length}${parent}${multipleDeps}\n  source: ${truncateText(source.title, 72)} · status=${source.status} · waiting=${source.waitingOn ?? "-"}\n  root blocker: ${terminalTaskId} · ${truncateText(chain.terminalTitle, 72)} · status=${chain.terminalStatus}${rootHealth} · next: ${truncateText(terminalNext, 120)}`;
}

function appendStandupDependencyChainsSection(lines: string[], chains: StandupDependencyChain[], scopeData: AgentsBoardData["scopes"]["all"], ticketsById: Map<string, BoardTicket>, limit = 6): void {
	lines.push("", "## Dependency / blocker chains");
	if (chains.length === 0) {
		lines.push("- none");
		return;
	}
	for (const chain of chains.slice(0, limit)) lines.push(formatStandupDependencyChain(chain, scopeData, ticketsById));
	if (chains.length > limit) lines.push(`- +${chains.length - limit} more`);
}

function appendStandupSection(lines: string[], title: string, tickets: BoardTicket[], scopeData: AgentsBoardData["scopes"]["all"], limit = 6): void {
	lines.push("", `## ${title}`);
	if (tickets.length === 0) {
		lines.push("- none");
		return;
	}
	for (const ticket of tickets.slice(0, limit)) {
		lines.push(formatStandupTicketLine(ticket, scopeData.agentsByTaskId.get(ticket.taskId) ?? []));
	}
	if (tickets.length > limit) lines.push(`- +${tickets.length - limit} more`);
}

function formatStandupInteractionCard(interaction: TaskInteractionRecord, ticket: BoardTicket | undefined): string {
	const taskTitle = ticket ? truncateText(ticket.title, 56) : interaction.taskId;
	return [
		`- ${taskInteractionIcon(interaction.kind)} ${taskInteractionLabel(interaction.kind)} · ${interaction.taskId} · ${taskTitle}`,
		`  from: ${interaction.actorLabel} · owner: ${ownerLabelForInteraction(interaction)} · state: ${interaction.state}`,
		`  asks: ${truncateText(interaction.answerNeeded ?? interaction.summary, 140)}`,
		`  next: ${interaction.nextAction}`,
		...interaction.actions.slice(0, 2).map((action) => `  action: ${action}`),
	].join("\n");
}

function appendStandupInteractionsSection(lines: string[], scopeData: AgentsBoardData["scopes"]["all"], tickets: BoardTicket[], limit = 8): void {
	lines.push("", "## Open task interactions");
	const ticketsById = new Map(tickets.map((ticket) => [ticket.taskId, ticket]));
	const interactions = [...scopeData.interactionsByTaskId.values()].flat().sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
	if (interactions.length === 0) {
		lines.push("- none");
		return;
	}
	for (const interaction of interactions.slice(0, limit)) lines.push(formatStandupInteractionCard(interaction, ticketsById.get(interaction.taskId)));
	if (interactions.length > limit) lines.push(`- +${interactions.length - limit} more`);
}

function formatStandupCleanupLine(candidate: CleanupCandidate): string {
	const taskText = candidate.agent.taskId ? ` · task=${candidate.agent.taskId}` : "";
	const attentionText = candidate.attentionItems.length > 0 ? ` · ${candidate.attentionItems.length} attention` : "";
	return `- ${candidate.agent.id} · ${candidate.agent.profile} · ${candidate.agent.state}${taskText}${attentionText}\n  next: ${candidate.cleanupAllowed ? "cleanup terminal tmux target" : "resolve attention before cleanup"} · ${candidate.reason}`;
}

function appendStandupCleanupSection(lines: string[], candidates: CleanupCandidate[], limit = 6): void {
	lines.push("", "## Cleanup candidates");
	if (candidates.length === 0) {
		lines.push("- none");
		return;
	}
	for (const candidate of candidates.slice(0, limit)) lines.push(formatStandupCleanupLine(candidate));
	if (candidates.length > limit) lines.push(`- +${candidates.length - limit} more`);
}

function appendStandupReadinessSection(lines: string[], title: string, items: TaskReadinessRecord[], limit = 6): void {
	lines.push("", `## ${title}`);
	if (items.length === 0) {
		lines.push("- none");
		return;
	}
	for (const item of items.slice(0, limit)) lines.push(formatTaskReadinessLine(item));
	if (items.length > limit) lines.push(`- +${items.length - limit} more`);
}

function appendStandupUnblockOrderSection(
	lines: string[],
	input: {
		scopeData: AgentsBoardData["scopes"]["all"];
		chains: StandupDependencyChain[];
		blockedUser: BoardTicket[];
		blockedCoordinator: BoardTicket[];
		review: BoardTicket[];
		staleOrNoProgress: BoardTicket[];
		ready: BoardTicket[];
		ticketsById: Map<string, BoardTicket>;
	},
	limit = 7,
): void {
	lines.push("", "## Recommended unblock order");
	const items: string[] = [];
	const interactions = [...input.scopeData.interactionsByTaskId.values()].flat().sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
	if (interactions.length > 0) {
		const first = interactions[0]!;
		items.push(`triage ${interactions.length} open interaction${interactions.length === 1 ? "" : "s"}; start with ${first.taskId} (${taskInteractionLabel(first.kind)})`);
	}
	const seenTerminalTaskIds = new Set<string>();
	for (const chain of input.chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		if (!terminalTaskId || seenTerminalTaskIds.has(terminalTaskId)) continue;
		seenTerminalTaskIds.add(terminalTaskId);
		const terminalTicket = input.ticketsById.get(terminalTaskId);
		const terminalNext = terminalTicket
			? standupNextAction(terminalTicket, input.scopeData.agentsByTaskId.get(terminalTicket.taskId) ?? [])
			: chain.terminalStatus === "done"
				? "refresh dependency state"
				: `finish or replan dependency in ${chain.terminalStatus}`;
		items.push(`resolve blocker ${terminalTaskId} to unblock ${chain.blockedTaskCount} task${chain.blockedTaskCount === 1 ? "" : "s"}; next: ${truncateText(terminalNext, 110)}`);
	}
	for (const ticket of input.blockedUser.slice().sort(compareStandupTickets)) {
		items.push(`answer user-wait ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.blockedCoordinator.slice().sort(compareStandupTickets)) {
		items.push(`clear blocker ${ticket.taskId} (${ticket.waitingOn ?? "coordinator"}); next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.review.slice().sort(compareStandupTickets)) {
		items.push(`synthesize review ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.staleOrNoProgress.slice().sort(compareStandupTickets)) {
		items.push(`refresh liveness ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	if (input.ready.length > 0) items.push(`then pull Ready to start (${input.ready.length}); first ${input.ready[0]!.taskId} if blockers/review/WIP are under control`);
	if (items.length === 0) {
		lines.push("- no unblock work detected; ready-to-start work can be considered if WIP is under control");
		return;
	}
	for (const [index, item] of items.slice(0, limit).entries()) lines.push(`${index + 1}. ${item}`);
	if (items.length > limit) lines.push(`- +${items.length - limit} more`);
}

function buildStandupText(ctx: ExtensionContext, scope: "all" | "current_project" | "current_session" | "descendants" = "current_project"): string {
	const board = buildBoardData(ctx);
	const scopeData = board.scopes[scope];
	const lanes = scopeData.lanes;
	const allTickets = Object.values(lanes).flat();
	const ticketsById = new Map(allTickets.map((ticket) => [ticket.taskId, ticket] as const));
	const review = lanes.in_review;
	const activeWip = lanes.in_progress;
	const ready = lanes.todo;
	const cleanupCandidates = listCleanupCandidates(ctx, { scope, limit: 200 });
	const readiness = listTaskReadiness(getTmuxAgentsDb(), { ids: allTickets.map((ticket) => ticket.taskId), includeDone: false, limit: Math.max(allTickets.length, 1) });
	const dependencyBlocked = readiness.filter((item) => item.unresolvedDependencies.length > 0);
	const dependencyReady = readiness.filter((item) => item.ready && item.resolvedDependencies.length > 0);
	const dependencyChains = buildStandupDependencyChains(dependencyBlocked);
	const dependencyBlockedTaskIds = new Set(dependencyBlocked.map((item) => item.task.id));
	const blockedUser = lanes.blocked.filter((ticket) => ticket.waitingOn === "user");
	const blockedCoordinator = lanes.blocked.filter((ticket) => ticket.waitingOn !== "user" && !dependencyBlockedTaskIds.has(ticket.taskId));
	const stale = allTickets.filter((ticket) => ticket.health.signals.includes("stale"));
	const noProgress = allTickets.filter((ticket) => ticket.health.signals.includes("empty_or_no_progress"));
	const approvalRequired = allTickets.filter((ticket) => ticket.health.signals.includes("approval_required"));
	const externalBlocked = allTickets.filter((ticket) => ticket.health.signals.includes("blocked_external"));
	const ownerActive = allTickets.filter((ticket) => ticket.health.signals.includes("owner_active"));
	const staleOrNoProgress = allTickets.filter((ticket) => ticket.health.signals.includes("stale") || ticket.health.signals.includes("empty_or_no_progress"));
	const openAttention = allTickets.reduce((count, ticket) => count + ticket.openAttentionCount, 0);
	const activeAgents = allTickets.reduce((count, ticket) => count + ticket.activeAgentCount, 0);
	const counts = [`todo ${ready.length}`, `blocked ${lanes.blocked.length}`, `in-progress ${activeWip.length}`, `review ${review.length}`, `done ${lanes.done.length}`].join(" · ");
	const lines = [
		`# Standup · ${scope}`,
		`Generated: ${new Date().toISOString()}`,
		`Board: ${counts}`,
		`Signals: ${blockedUser.length} user-wait · ${blockedCoordinator.length} free-text blocker · ${externalBlocked.length} external-blocked · ${dependencyChains.length} dependency-chain · ${dependencyReady.length} dependency-ready · ${review.length} review · ${approvalRequired.length} approval-required · ${openAttention} interactions · ${activeAgents} active agents · ${ownerActive.length} owner-active · ${stale.length} stale · ${noProgress.length} no-progress · ${cleanupCandidates.length} cleanup`,
	];
	appendStandupHealthSection(lines, allTickets, scopeData, 6);
	appendStandupInteractionsSection(lines, scopeData, allTickets, 8);
	appendStandupSection(lines, "Needs user", blockedUser, scopeData, 5);
	appendStandupDependencyChainsSection(lines, dependencyChains, scopeData, ticketsById, 6);
	appendStandupReadinessSection(lines, "Newly dependency-ready", dependencyReady, 6);
	appendStandupSection(lines, "Needs coordinator / free-text blockers", blockedCoordinator, scopeData, 6);
	appendStandupSection(lines, "Ready for review / acceptance", review, scopeData, 6);
	appendStandupSection(lines, "Active WIP", activeWip, scopeData, 8);
	appendStandupSection(lines, "Stale / no progress", staleOrNoProgress, scopeData, 6);
	appendStandupCleanupSection(lines, cleanupCandidates, 6);
	appendStandupUnblockOrderSection(lines, { scopeData, chains: dependencyChains, blockedUser, blockedCoordinator, review, staleOrNoProgress, ready, ticketsById }, 7);
	appendStandupSection(lines, "Ready to start", ready, scopeData, 6);
	lines.push("", "## Operating notes", "- Prefer the `Recommended unblock order` before spawning from `Ready to start`; use `task_dispatch_ready` for dependency-ready tickets and cleanup terminal agents after accepted completion.");
	return lines.join("\n");
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
	const lease = getTaskLease(db, taskId);
	if (params.status === "in_progress" && lease.exclusiveOwners.length > 0) {
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_owner_active",
			summary: `Task in_progress with active owner ${lease.exclusiveOwners.map((owner) => owner.agentId).join(", ")}`,
			payload: { ownerAgentIds: lease.exclusiveOwners.map((owner) => owner.agentId) },
			createdAt: now,
		});
	}
	if (params.status === "done" && lease.activeOwners.length > 0) {
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_cleanup_recommended",
			summary: `Task done while ${lease.activeOwners.length} active lease(s) remain; cleanup/reconcile should release them after synthesis.`,
			payload: { agentIds: lease.activeOwners.map((owner) => owner.agentId) },
			createdAt: now,
		});
	}
	if (params.status === "done") {
		resolveDependenciesForCompletedTask(db, taskId, now);
	}
	if (params.status !== "done") {
		refreshTaskDependencyBlockState(db, taskId, now);
	}
	return getTask(db, taskId)!;
}

async function runTaskCreateWizard(ctx: ExtensionContext): Promise<TaskRecord | null> {
	if (!ctx.hasUI) return null;
	const title = await ctx.ui.input("Task title:", "new task");
	if (!title?.trim()) return null;
	const summary = await ctx.ui.input("Task summary (optional):", "");
	const description = await ctx.ui.editor("Task description (optional):", "");
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return null;
	const status = (await ctx.ui.select("Initial task status:", ["todo", "blocked", "in_progress", "in_review", "done"])) as TaskState | null;
	if (!status) return null;
	const created = createTaskFromParams(ctx, {
		title: title.trim(),
		summary: summary?.trim() || undefined,
		description: description?.trim() || undefined,
		cwd: cwd.trim(),
		status,
	});
	ctx.ui.notify(`Created task ${created.id}.`, "info");
	return created;
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

async function runTaskSubtreeControlFlow(ctx: ExtensionContext, taskId: string): Promise<void> {
	if (!ctx.hasUI) return;
	const selection = await ctx.ui.select("Subtree control:", ["Preview only", "Pause subtree", "Resume paused subtree", "Cancel subtree", "Back"]);
	if (!selection || selection === "Back") return;
	const actionMap: Record<string, TaskSubtreeControlAction> = {
		"Preview only": "preview",
		"Pause subtree": "pause",
		"Resume paused subtree": "resume",
		"Cancel subtree": "cancel",
	};
	const action = actionMap[selection] ?? "preview";
	const reason = action === "preview" ? undefined : (await ctx.ui.input(`${selection} reason:`, ""))?.trim() || undefined;
	const preview = buildTaskSubtreeControlPreview(ctx, taskId, action, { reason });
	await ctx.ui.editor(`Subtree ${action} preview`, formatTaskSubtreeControlPreview(preview));
	if (action === "preview") return;
	const ok = await ctx.ui.confirm(`Confirm subtree ${action}`, formatTaskSubtreeControlConfirmation(preview));
	if (!ok) return;
	const result = await applyTaskSubtreeControl(ctx, taskId, action, { reason, previewToken: preview.previewToken });
	ctx.ui.notify(`Applied subtree ${action}: ${result.updatedTasks.length} task(s), ${result.stopResults.length} graceful stop request(s).`, result.stopErrors.length > 0 ? "warning" : "info");
	await ctx.ui.editor(`Subtree ${action} result`, formatTaskSubtreeControlApplyResult(result));
}

async function confirmTaskLeaseOverride(ctx: ExtensionContext, taskId: string | undefined, profileName: string): Promise<boolean> {
	if (!taskId) return false;
	const conflict = getTaskLeaseConflict(getTmuxAgentsDb(), { taskId, profile: profileName });
	if (!conflict) return false;
	if (!ctx.hasUI) throw new Error(formatTaskLeaseConflict(conflict));
	const ok = await ctx.ui.confirm(
		"Active task owner",
		`${formatTaskLeaseConflict(conflict)}\n\nSpawn/link another exclusive owner anyway?`,
	);
	if (ok) {
		createTaskEvent(getTmuxAgentsDb(), {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_override_confirmed",
			summary: `Coordinator allowed duplicate exclusive owner for ${profileName}`,
			payload: { profile: profileName, conflictingOwners: conflict.conflictingOwners.map((owner) => owner.agentId) },
		});
	}
	return ok;
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
		const allowDuplicateOwner = await confirmTaskLeaseOverride(ctx, selectedTaskId, profile.name);
		const result = spawnChildFromParams(pi, ctx, {
			title: title.trim(),
			task: task.trim(),
			profile: profile.name,
			taskId: selectedTaskId,
			cwd: cwd.trim(),
			allowDuplicateOwner,
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
					const agentResult = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					const taskResult = reconcileTasks(getTmuxAgentsDb(), resolveTaskFilters(ctx, state.scope, { includeDone: true, limit: 200 }));
					ctx.ui.notify(`${formatReconcileResult(agentResult)}\nTasks: ${taskResult.backfilled} backfilled, ${taskResult.deactivatedLinks} links deactivated.`, "info");
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
				case "inspect": {
					const task = getTask(getTmuxAgentsDb(), selectedId!);
					if (task) await ctx.ui.editor(`Task ${task.id}`, formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [task.id], limit: 20 }), {}, getTaskInteractions(task.id)));
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
				case "subtree":
					await runTaskSubtreeControlFlow(ctx, selectedId!);
					break;
				case "create":
					await runTaskCreateWizard(ctx);
					break;
				case "sync": {
					const agentResult = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					const taskResult = reconcileTasks(getTmuxAgentsDb(), resolveTaskFilters(ctx, state.scope, { includeDone: true, limit: 200 }));
					ctx.ui.notify(`${formatReconcileResult(agentResult)}\nTasks: ${taskResult.backfilled} backfilled, ${taskResult.deactivatedLinks} links deactivated.`, "info");
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
	} else {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: appendNoWaitPolicyToSystemPrompt(event.systemPrompt),
		}));
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") return;
			const command = getBashCommandFromToolInput(event.input);
			if (!command) return;
			const violation = classifyNoWaitBashCommand(command);
			if (!violation) return;
			return { block: true, reason: formatNoWaitPolicyViolation(violation) };
		});
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
			"If the task already has an active exclusive owner, use a reviewer profile or set allowDuplicateOwner=true only after explicit confirmation that duplicate implementation is intentional.",
			"Pick the most appropriate profile and keep the delegated task narrowly scoped.",
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
			const db = getTmuxAgentsDb();
			const actor = resolveToolActorContext(ctx);
			const agent = getAgent(db, params.id);
			if (!agent) throw new Error(`Unknown agent id \"${params.id}\".`);
			const kind = params.kind as "answer" | "note" | "redirect" | "cancel" | "priority";
			const actionPolicy = params.actionPolicy ?? defaultDownwardActionPolicy(kind);
			const recipient: AgentRecipientRef = { kind: "agent", agentId: agent.id };
			const preflight = canSendMessage(db, { actor, recipient, messageKind: kind });
			if (!preflight.allowed) {
				try {
					createMessageWithRecipients(db, {
						actor,
						recipients: [{ ...recipient, deliveryMode: params.deliveryMode ?? "immediate" }],
						projectKey: agent.projectKey,
						taskId: agent.taskId,
						subjectAgentId: agent.id,
						kind,
						summary: params.summary,
						bodyMarkdown: params.details ?? null,
						payload: {
							summary: params.summary,
							details: params.details,
							files: params.files,
							actionPolicy,
							inReplyToMessageId: params.inReplyToMessageId,
						},
						actionPolicy,
						thread: { kind: "command", title: params.summary },
					});
				} catch (error) {
					if (error instanceof AgentMessagePermissionError) {
						const decision = error.decisions[0] ?? preflight;
						throw new Error(
							`Denied hierarchy message from ${decision.fromKind}:${decision.fromAgentId ?? "root"} to ${decision.toKind}:${decision.toAgentId ?? "-"} via ${decision.routeKind}: ${decision.decisionReason}`,
						);
					}
					throw error;
				}
				throw new Error(
					`Denied hierarchy message from ${preflight.fromKind}:${preflight.fromAgentId ?? "root"} to ${preflight.toKind}:${preflight.toAgentId ?? "-"} via ${preflight.routeKind}: ${preflight.decisionReason}`,
				);
			}
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
			const messageResult = createMessageWithRecipients(db, {
				actor,
				recipients: [{ ...recipient, deliveryMode: params.deliveryMode ?? "immediate", transportKind: "inbox" }],
				projectKey: agent.projectKey,
				orgId: agent.orgId,
				taskId: agent.taskId,
				subjectAgentId: agent.id,
				kind,
				summary: params.summary,
				bodyMarkdown: params.details ?? null,
				payload: {
					summary: params.summary,
					details: params.details,
					files: params.files,
					actionPolicy,
					inReplyToMessageId: params.inReplyToMessageId,
				},
				actionPolicy,
				thread: { kind: "command", title: params.summary },
			});
			const route = messageResult.routes[0] ?? preflight;
			queueDownwardMessage(
				agent,
				kind,
				{
					summary: params.summary,
					details: params.details,
					files: params.files,
					actionPolicy,
					inReplyToMessageId: params.inReplyToMessageId,
					v2MessageId: messageResult.message.id,
					v2RecipientRowId: messageResult.recipients[0]?.id,
					routeKind: route.routeKind,
				},
				params.deliveryMode ?? "immediate",
				actor,
			);
			const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
			updateFleetUi(ctx);
			const senderText = actor.kind === "agent" ? `agent:${actor.agentId}` : "root";
			const text = liveDelivery.delivered > 0
				? `Queued ${kind} message from ${senderText} to agent:${agent.id} via ${route.routeKind} (${actionPolicy}) and delivered ${liveDelivery.delivered} via RPC bridge.`
				: `Queued ${kind} message from ${senderText} to agent:${agent.id} via ${route.routeKind} (${actionPolicy}).`;
			return {
				content: [{ type: "text", text }],
				details: {
					agentId: agent.id,
					sender: actor,
					recipient,
					kind,
					actionPolicy,
					message: messageResult.message,
					recipients: messageResult.recipients,
					routes: messageResult.routes,
					inReplyToMessageId: params.inReplyToMessageId ?? null,
					deliveryMode: params.deliveryMode ?? "immediate",
					liveDelivery,
					readReceipt: { status: liveDelivery.delivered > 0 ? "acked" : "queued", recipientRowIds: messageResult.recipients.map((item) => item.id) },
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
			const taskFilters = resolveTaskFilters(ctx, params.scope ?? "current_project", { includeDone: true, limit: params.limit });
			const taskResult = reconcileTasks(getTmuxAgentsDb(), { ids: taskFilters.ids, projectKey: taskFilters.projectKey, spawnSessionId: taskFilters.spawnSessionId, spawnSessionFile: taskFilters.spawnSessionFile, limit: params.limit });
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${formatReconcileResult(result)}\nTasks: ${taskResult.backfilled} backfilled · ${taskResult.deactivatedLinks} stale links released.` }],
				details: { ...result, taskResult },
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
			const filters = applyHierarchyVisibilityToAgentFilters(ctx, resolveAgentFilters(ctx, scope, params));
			const agents = listAgents(getTmuxAgentsDb(), filters);
			const header = `scope=${summarizeFilters(scope, filters)}${childRuntimeEnvironment ? " · hierarchy-visible" : ""} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`;
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
			const visibleIds = getVisibleAgentIdsForTool(ctx, params.ids);
			const visibleSet = visibleIds ? new Set(visibleIds) : null;
			const allowedIds = visibleSet ? params.ids.filter((id) => visibleSet.has(id)) : params.ids;
			const deniedIds = visibleSet ? params.ids.filter((id) => !visibleSet.has(id)) : [];
			const agents = allowedIds
				.map((id) => getAgent(getTmuxAgentsDb(), id))
				.filter((agent): agent is AgentSummary => agent !== null);
			const text =
				agents.length === 0
					? deniedIds.length > 0
						? `No matching visible agents found. Hidden by hierarchy scope: ${deniedIds.join(", ")}`
						: "No matching agents found."
					: `${agents.map((agent) => formatAgentDetails(agent)).join("\n\n---\n\n")}${deniedIds.length > 0 ? `\n\nHidden by hierarchy scope: ${deniedIds.join(", ")}` : ""}`;
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text }],
				details: { ids: params.ids, visibleIds: allowedIds, deniedIds, agents },
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
			"Treat this as a one-shot snapshot: if nothing actionable is returned, continue other ready work or end the turn instead of waiting.",
		],
		parameters: SubagentInboxParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const agentFilters = applyHierarchyVisibilityToAgentFilters(ctx, resolveAgentFilters(ctx, scope, {}));
			const db = getTmuxAgentsDb();
			const actor = resolveToolActorContext(ctx);
			const v2Messages = fetchAgentInboxV2(db, {
				actor,
				includeRead: params.includeDelivered ?? false,
				markRead: !(params.includeDelivered ?? false),
				projectKey: agentFilters.projectKey ?? (actor.kind === "agent" ? actor.projectKey : undefined),
				limit: params.limit,
			});
			const v2ReadReceiptCount = params.includeDelivered ? 0 : v2Messages.length;
			if (actor.kind === "agent" || v2Messages.length > 0) {
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildInboxV2Text(v2Messages, v2ReadReceiptCount) }],
					details: {
						scope,
						actor,
						messages: v2Messages,
						readReceipt: { status: "read", ids: v2Messages.map((entry) => entry.recipient.id), count: v2ReadReceiptCount },
						version: "v2",
					},
				};
			}
			const messages = listInboxMessages(db, {
				projectKey: agentFilters.projectKey,
				spawnSessionId: agentFilters.spawnSessionId,
				spawnSessionFile: agentFilters.spawnSessionFile,
				agentIds: agentFilters.ids ?? agentFilters.descendantOf,
				includeDelivered: params.includeDelivered,
				limit: params.limit,
			});
			const deliveredIds = params.includeDelivered ? [] : messages.filter((message) => message.status === "queued").map((message) => message.id);
			const readReceiptCount = markAgentMessages(db, deliveredIds, "delivered");
			const deliveredIdSet = new Set(deliveredIds);
			const returnedMessages = messages.map((message) =>
				deliveredIdSet.has(message.id) ? { ...message, status: "delivered" as const, deliveredAt: Date.now() } : message,
			);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildInboxText(returnedMessages, readReceiptCount) }],
				details: { scope, actor, messages: returnedMessages, readReceipt: { status: "delivered", ids: deliveredIds, count: readReceiptCount }, version: "legacy" },
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
			"Treat this as a one-shot snapshot, not a long-poll or monitor loop.",
		],
		parameters: SubagentAttentionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const db = getTmuxAgentsDb();
			const actor = resolveToolActorContext(ctx);
			if (actor.kind === "agent") {
				const visibleSubjectAgentIds = params.audience === "user" ? listHierarchyVisibleAgentIds(db, actor, { projectKey: getProjectKey(ctx.cwd) }) : undefined;
				const v2Filters = {
					projectKey: getProjectKey(ctx.cwd),
					ownerKind: params.audience === "user" ? ("user" as const) : ("agent" as const),
					ownerAgentId: params.audience === "user" ? null : actor.agentId,
					subjectAgentIds: visibleSubjectAgentIds,
					states: params.includeResolved ? undefined : (["open", "acknowledged", "waiting_on_owner"] as AgentAttentionV2Record["state"][]),
					limit: params.limit,
				};
				const items = listAgentAttentionItemsV2(db, v2Filters);
				const agentIds = [...new Set(items.flatMap((item) => [item.subjectAgentId, item.ownerAgentId]).filter((value): value is string => Boolean(value)))];
				const agentsById = new Map(listAgents(db, { ids: agentIds, limit: 200 }).map((agent) => [agent.id, agent]));
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildAttentionV2Text(items, agentsById, params.includeResolved ?? false) }],
					details: { scope, actor, filters: v2Filters, items, version: "v2" },
				};
			}
			const filters = resolveAttentionFilters(ctx, scope, params);
			const rawLegacyItems = listAttentionItems(db, filters);
			const v2Filters = resolveAdminAttentionV2Filters(ctx, scope, params, actor);
			const v2Items = listAgentAttentionItemsV2(db, v2Filters);
			const items = suppressDuplicateLegacyAttentionItems(rawLegacyItems, v2Items);
			const suppressedLegacyDuplicateCount = rawLegacyItems.length - items.length;
			const agentIds = [
				...items.map((item) => item.agentId),
				...v2Items.flatMap((item) => [item.subjectAgentId, item.ownerAgentId]).filter((value): value is string => Boolean(value)),
			];
			const agentsById = new Map(listAgents(db, { ids: [...new Set(agentIds)], limit: 200 }).map((agent) => [agent.id, agent]));
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildAdminAttentionText(items, v2Items, agentsById, params.includeResolved ?? false) }],
				details: {
					scope,
					actor,
					filters: { legacy: filters, v2: v2Filters },
					items,
					v2Items,
					suppressedLegacyDuplicateCount,
					version: "legacy+v2",
				},
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
			"Set recommendedProfile on executable tickets so dependency-ready dispatch can launch the right agent.",
			"Use task_link for ticket dependencies instead of free-text blocked reasons.",
			"Use blocked + waitingOn instead of creating separate waiting swim lanes.",
		],
		parameters: TaskCreateParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = createTaskFromParams(ctx, params);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatTaskDetails(task, [], [], {}, getTaskInteractions(task.id)) }],
				details: { task },
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
				recommendedProfile: params.recommendedProfile,
				includeDone: params.includeDone,
				limit: params.limit,
				linkedAgentId: params.linkedAgentId,
			});
			if (params.ids && params.ids.length > 0) filters.ids = params.ids;
			const tasks = sortTasksForList(listTasks(getTmuxAgentsDb(), filters), (params.sort ?? "priority") as "priority" | "updated" | "created" | "title" | "status");
			const links = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds: tasks.map((task) => task.id), limit: 500 });
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
			const readinessByTask = new Map(listTaskReadiness(getTmuxAgentsDb(), { ids: tasks.map((task) => task.id), includeDone: true, limit: Math.max(tasks.length, 1) }).map((item) => [item.task.id, item]));
			const healthByTask = listTaskHealth(getTmuxAgentsDb(), tasks);
			const header = `scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
			const body = tasks.length === 0 ? "No tasks matched." : tasks.map((task) => formatTaskLine(task, agentsByTask.get(task.id) ?? [], readinessByTask.get(task.id), healthByTask.get(task.id))).join("\n");
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
		promptSnippet: "Get full task details including acceptance criteria, plan steps, dependency links, linked agents, and recent events.",
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
			const links = listTaskAgentLinks(getTmuxAgentsDb(), { taskIds: tasks.map((task) => task.id), limit: 500 });
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
			const dependencyLinks = listTaskLinks(getTmuxAgentsDb(), { taskIds: tasks.map((task) => task.id), includeResolved: true, limit: 1000 });
			const interactionsByTask = listTaskInteractionsForTaskIds(tasks.map((task) => task.id));
			const healthByTask = listTaskHealth(getTmuxAgentsDb(), tasks);
			const text = tasks.length === 0
				? "No matching tasks found."
				: tasks
					.map((task) =>
						formatTaskDetails(task, agentsByTask.get(task.id) ?? [], eventsByTask.get(task.id) ?? [], {
							dependencies: dependencyLinks.filter((link) => link.sourceTaskId === task.id),
							dependents: dependencyLinks.filter((link) => link.targetTaskId === task.id),
						}, interactionsByTask.get(task.id) ?? [], healthByTask.get(task.id)),
					)
					.join("\n\n---\n\n");
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text }],
				details: { tasks, taskLinks: dependencyLinks, interactionsByTask, healthByTask },
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
				recommendedProfile: params.recommendedProfile,
				acceptanceCriteria: params.acceptanceCriteria,
				planSteps: params.planSteps,
				validationSteps: params.validationSteps,
				labels: params.labels,
				files: params.files,
				blockedReason: params.blockedReason,
				waitingOn: params.waitingOn as TaskWaitingOn | undefined,
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
				content: [{ type: "text", text: formatTaskDetails(updated, getTaskLinkedAgents(updated.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [updated.id], limit: 10 }), {}, getTaskInteractions(updated.id)) }],
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
			"When moving a prerequisite to done, newly unblocked dependency-ready tickets can auto-dispatch if recommendedProfile is set.",
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
			const dependentSourceIds = params.status === "done"
				? [...new Set(listTaskLinks(getTmuxAgentsDb(), { targetTaskIds: [moved.id], linkTypes: ["depends_on"], includeResolved: true, limit: 500 }).map((link) => link.sourceTaskId))]
				: [];
			const readyDependents = dependentSourceIds.length > 0
				? listTaskReadiness(getTmuxAgentsDb(), { ids: dependentSourceIds, includeDone: false, limit: dependentSourceIds.length }).filter((item) => item.ready)
				: [];
			const dispatchResult = params.status === "done" && (params.autoDispatchReadyDependents ?? true) && readyDependents.length > 0
				? dispatchReadyTasks(pi, ctx, readyDependents, { fallbackProfile: params.fallbackProfile, maxDispatch: params.maxDispatch, dryRun: false })
				: null;
			const dependencyText = readyDependents.length > 0 ? `\n\nnewlyReadyDependents:\n${readyDependents.map(formatTaskReadinessLine).join("\n")}` : "";
			const dispatchText = dispatchResult ? `\n\n${buildTaskDispatchText(dispatchResult, false)}` : "";
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${formatTaskDetails(moved, getTaskLinkedAgents(moved.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [moved.id], limit: 10 }), {}, getTaskInteractions(moved.id))}${dependencyText}${dispatchText}` }],
				details: { task: moved, readyDependents, dispatchResult },
			};
		},
	});

	pi.registerTool({
		name: "task_note",
		label: "Task Note",
		description: "Append a structured task-level note or handoff event, optionally resolving one task interaction card.",
		promptSnippet: "Add a note to the task history without changing board state; pass resolveInteractionId to disposition a visible task interaction.",
		parameters: TaskNoteParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = getTask(getTmuxAgentsDb(), params.id);
			if (!task) throw new Error(`Unknown task id \"${params.id}\".`);
			const resolution = params.resolveInteractionId
				? resolveTaskInteractionWithNote(params.id, params.resolveInteractionId, params.resolutionKind ?? "resolved", params.resolutionSummary ?? params.summary)
				: null;
			if (params.resolveInteractionId && resolution?.changes === 0) {
				throw new Error(`No open task interaction ${params.resolveInteractionId} matched task ${params.id}.`);
			}
			createTaskEvent(getTmuxAgentsDb(), {
				id: randomUUID(),
				taskId: params.id,
				eventType: "note",
				summary: params.summary,
				payload: {
					details: params.details ?? null,
					files: params.files ?? [],
					resolvedInteractionId: params.resolveInteractionId ?? null,
					resolutionKind: params.resolveInteractionId ? params.resolutionKind ?? "resolved" : null,
					resolutionSummary: params.resolveInteractionId ? params.resolutionSummary ?? params.summary : null,
					resolutionChanges: resolution?.changes ?? 0,
				},
			});
			updateTask(getTmuxAgentsDb(), params.id, { updatedAt: Date.now(), files: params.files ? [...new Set([...task.files, ...params.files])] : task.files });
			updateFleetUi(ctx);
			const resolutionText = resolution ? ` and resolved ${resolution.changes} ${resolution.source} interaction(s)` : "";
			return {
				content: [{ type: "text", text: `Added note to ${task.id}: ${params.summary}${resolutionText}` }],
				details: { taskId: task.id, resolution },
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
			if (params.active ?? true) {
				const unresolved = listUnresolvedTaskDependencies(getTmuxAgentsDb(), [params.taskId]).get(params.taskId) ?? [];
				if (unresolved.length > 0) {
					throw new Error(`Task ${params.taskId} has unresolved dependencies: ${unresolved.map((item) => item.targetTaskId).join(", ")}. Do not link an active agent until dependencies resolve.`);
				}
			}
			const link = linkTaskAgent(getTmuxAgentsDb(), {
				taskId: params.taskId,
				agentId: params.agentId,
				role: params.role,
				isActive: params.active,
				allowDuplicateOwner: params.allowDuplicateOwner,
			});
			if (params.active ?? true) {
				const linkedTask = getTask(getTmuxAgentsDb(), params.taskId);
				const status: TaskState = taskLeaseKindForProfile(link.role) === "review" && linkedTask?.status === "in_review" ? "in_review" : "in_progress";
				updateTask(getTmuxAgentsDb(), params.taskId, { status, waitingOn: null, blockedReason: null, updatedAt: Date.now() });
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
		name: "task_link",
		label: "Task Link",
		description: "Create a first-class relationship between two task tickets, especially source depends_on target dependencies.",
		promptSnippet: "Record ticket dependencies such as task A depends_on task B before dispatching agents.",
		promptGuidelines: [
			"Use task_link when planning reveals that one ticket depends on another ticket.",
			"For depends_on, sourceTaskId is the dependent/blocked ticket and targetTaskId is the prerequisite ticket.",
			"Do not spawn an agent for a task with unresolved depends_on links.",
		],
		parameters: TaskLinkParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const link = createTaskLink(getTmuxAgentsDb(), {
				sourceTaskId: params.sourceTaskId,
				targetTaskId: params.targetTaskId,
				linkType: (params.linkType as TaskLinkType | undefined) ?? "depends_on",
				summary: params.summary,
				blockSource: params.blockSource,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: formatTaskLinkLine(link) }],
				details: { link },
			};
		},
	});

	pi.registerTool({
		name: "task_unlink",
		label: "Task Unlink",
		description: "Cancel a first-class task relationship or dependency link.",
		promptSnippet: "Cancel a task dependency/relationship link when it no longer applies.",
		parameters: TaskUnlinkParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const links = cancelTaskLink(getTmuxAgentsDb(), {
				id: params.id,
				sourceTaskId: params.sourceTaskId,
				targetTaskId: params.targetTaskId,
				linkType: params.linkType as TaskLinkType | undefined,
				reason: params.reason,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: links.length === 0 ? "No matching active task link found." : links.map((link) => formatTaskLinkLine(link)).join("\n") }],
				details: { links },
			};
		},
	});

	pi.registerTool({
		name: "task_links",
		label: "Task Links",
		description: "List first-class task dependency and relationship links.",
		promptSnippet: "Inspect task dependencies and dependents/blocking relationships.",
		promptGuidelines: [
			"Use task_links to decide which tickets are blocked by unresolved dependencies and which tickets become ready after a prerequisite completes.",
		],
		parameters: TaskLinksParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
			const links = listTaskLinks(getTmuxAgentsDb(), {
				taskIds: params.taskId ? [params.taskId] : filters.ids,
				sourceTaskIds: params.sourceTaskId ? [params.sourceTaskId] : undefined,
				targetTaskIds: params.targetTaskId ? [params.targetTaskId] : undefined,
				projectKey: params.taskId || params.sourceTaskId || params.targetTaskId ? undefined : filters.projectKey,
				spawnSessionId: filters.spawnSessionId,
				spawnSessionFile: filters.spawnSessionFile,
				linkTypes: params.linkTypes as TaskLinkType[] | undefined,
				states: params.states as TaskLinkState[] | undefined,
				includeResolved: params.includeResolved,
				limit: params.limit,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildTaskLinksText(links) }],
				details: { scope, links },
			};
		},
	});

	pi.registerTool({
		name: "task_ready",
		label: "Task Ready",
		description: "List tasks that are dependency-ready for agent dispatch, with reasons for blocked tasks when requested.",
		promptSnippet: "Find dependency-free ready tickets before spawning agents.",
		promptGuidelines: [
			"Use task_ready after planning and after moving dependencies to done.",
			"Spawn agents for ready tickets; do not spawn agents for tasks with unresolved dependencies.",
		],
		parameters: TaskReadyParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, {
				statuses: params.includeBlocked ? undefined : ["todo"],
				recommendedProfile: params.recommendedProfile,
				includeDone: false,
				limit: params.limit,
			});
			if (params.ids && params.ids.length > 0) filters.ids = params.ids;
			const items = listTaskReadiness(getTmuxAgentsDb(), filters);
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildTaskReadyText(items, params.includeBlocked ?? false) }],
				details: { scope, items },
			};
		},
	});

	pi.registerTool({
		name: "task_dispatch_ready",
		label: "Task Dispatch Ready",
		description: "Spawn agents for dependency-ready tasks using each task's recommendedProfile or a fallback profile.",
		promptSnippet: "Launch one agent for each dependency-free ready ticket, subject to limits.",
		promptGuidelines: [
			"Use task_dispatch_ready after planning decomposes work or after a prerequisite task reaches done.",
			"Tasks without recommendedProfile are skipped unless fallbackProfile is provided.",
			"This is dependency-aware and will not spawn agents for tickets with unresolved depends_on links.",
		],
		parameters: TaskDispatchReadyParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const ready = getReadyTasksForDispatch(ctx, { scope: params.scope, ids: params.ids, limit: params.ids?.length ?? 100 });
			const result = dispatchReadyTasks(pi, ctx, ready, {
				fallbackProfile: params.fallbackProfile,
				maxDispatch: params.maxDispatch,
				dryRun: params.dryRun ?? false,
			});
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildTaskDispatchText(result, params.dryRun ?? false) }],
				details: { ready, result },
			};
		},
	});

	pi.registerTool({
		name: "task_attention",
		label: "Task Attention",
		description: "List blocked and in-review tasks that need coordinator or user attention.",
		promptSnippet: "List task-level unresolved work such as blocked tasks and tasks waiting for review.",
		promptGuidelines: [
			"Use task_attention as the task-first unresolved queue.",
		],
		parameters: TaskAttentionParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const scope = params.scope ?? "current_project";
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
			const items = listTaskAttention(getTmuxAgentsDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: params.limit });
			const interactionsByTask = listTaskInteractionsForTaskIds(items.map((item) => item.taskId));
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: buildTaskAttentionText(items, interactionsByTask) }],
				details: { scope, items, interactionsByTask },
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
				content: [{ type: "text", text: `Reconciled tasks · ${result.backfilled} backfilled · ${result.deactivatedLinks} links deactivated.` }],
				details: { scope, result },
			};
		},
	});

	pi.registerTool({
		name: "task_subtree_control",
		label: "Task Subtree Control",
		description: "Preview and optionally apply safe pause/resume/cancel-like controls across a parent/child task subtree.",
		promptSnippet: "Preview a task family before pausing, resuming, or cancelling its tasks and linked agents.",
		promptGuidelines: [
			"Use a dry-run first (target action with confirm=false, or action=preview for read-only inspection) to inspect the recursive parentTaskId subtree, linked agents, blockers, attention, and cleanup candidates.",
			"Pause/resume/cancel require confirm=true plus the previewToken returned by the prior dry-run preview for that same action/selection.",
			"If previewComplete is no, the tool refuses to apply so large task families are not partially controlled from truncated data.",
			"Pause/cancel use graceful subagent stop requests for active linked agents and write durable task events; they never force-kill or cleanup tmux targets.",
			"Resume only unblocks tasks previously marked with [subtree paused] and does not spawn agents automatically.",
		],
		parameters: TaskSubtreeControlParams,
		prepareArguments(args) {
			if (!args || typeof args !== "object") return args;
			const input = args as { taskId?: string; id?: string };
			if (typeof input.taskId === "string" && typeof input.id !== "string") return { ...args, id: input.taskId };
			return args;
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const action = (params.action ?? "preview") as TaskSubtreeControlAction;
			const preview = buildTaskSubtreeControlPreview(ctx, params.id, action, { includeRoot: params.includeRoot, reason: params.reason });
			if (action === "preview" || !(params.confirm ?? false)) {
				const confirmationText = action === "preview" ? "" : `\n\nConfirmation required: rerun with confirm=true previewToken=${preview.previewToken} to apply this bulk action.`;
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${formatTaskSubtreeControlPreview(preview)}${confirmationText}` }],
					details: {
						dryRun: true,
						action,
						previewToken: preview.previewToken,
						isComplete: preview.isComplete,
						truncationWarnings: preview.truncationWarnings,
						rootTask: preview.rootTask,
						tasks: preview.tasks,
						taskIdsToUpdate: preview.taskIdsToUpdate,
						linkedAgents: preview.linkedAgents,
						activeAgents: preview.activeAgents,
						agentIdsToStop: preview.agentIdsToStop,
						attentionItems: preview.attentionItems,
						agentAttentionItems: preview.agentAttentionItems,
						cleanupCandidates: preview.cleanupCandidates,
					},
				};
			}
			const result = await applyTaskSubtreeControl(ctx, params.id, action as Exclude<TaskSubtreeControlAction, "preview">, { includeRoot: params.includeRoot, reason: params.reason, previewToken: params.previewToken });
			updateFleetUi(ctx);
			return {
				content: [{ type: "text", text: `${formatTaskSubtreeControlPreview(preview)}\n\n---\n\n${formatTaskSubtreeControlApplyResult(result)}` }],
				details: {
					dryRun: false,
					action,
					previewToken: result.preview.previewToken,
					rootTask: result.preview.rootTask,
					updatedTasks: result.updatedTasks,
					stopResults: result.stopResults,
					stopErrors: result.stopErrors,
					taskEventsCreated: result.taskEventsCreated,
				},
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

	pi.registerCommand("standup", {
		description: "Show a Kanban standup digest for long-running task sessions",
		handler: async (args, ctx) => {
			const scopeArg = args?.trim() || "current_project";
			const scope = scopeArg as "all" | "current_project" | "current_session" | "descendants";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /standup [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const text = buildStandupText(ctx, scope);
			if (ctx.hasUI) await ctx.ui.editor("standup", text);
			else ctx.ui.notify(text, "info");
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
			const healthByTask = listTaskHealth(getTmuxAgentsDb(), tasks);
			const text = `${`scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}${tasks.length === 0 ? "\n\nNo tasks matched." : `\n\n${tasks.map((task) => formatTaskLine(task, getTaskLinkedAgents(task.id), undefined, healthByTask.get(task.id))).join("\n")}`}`;
			if (ctx.hasUI) await ctx.ui.editor("tasks", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-new", {
		description: "Create a tracked task",
		handler: async (_args, ctx) => {
			const created = await runTaskCreateWizard(ctx);
			if (created && ctx.hasUI) await ctx.ui.editor(`Task ${created.id}`, formatTaskDetails(created, [], [], {}, getTaskInteractions(created.id)));
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
			const text = formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getTmuxAgentsDb(), { taskIds: [task.id], limit: 20 }), {}, getTaskInteractions(task.id));
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
			const agent = getAgent(getTmuxAgentsDb(), agentId);
			if (!agent) {
				ctx.ui.notify(`Unknown agent id \"${agentId}\".`, "error");
				return;
			}
			const allowDuplicateOwner = await confirmTaskLeaseOverride(ctx, taskId, role || agent.profile);
			const existingTask = getTask(getTmuxAgentsDb(), taskId);
			const link = linkTaskAgent(getTmuxAgentsDb(), { taskId, agentId, role, isActive: true, allowDuplicateOwner });
			const status: TaskState = taskLeaseKindForProfile(link.role) === "review" && existingTask?.status === "in_review" ? "in_review" : "in_progress";
			updateTask(getTmuxAgentsDb(), taskId, { status, waitingOn: null, blockedReason: null, updatedAt: Date.now() });
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
		description: "List blocked and in-review tasks",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /task-attention [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const items = listTaskAttention(getTmuxAgentsDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: 200 });
			const interactionsByTask = listTaskInteractionsForTaskIds(items.map((item) => item.taskId));
			const text = buildTaskAttentionText(items, interactionsByTask);
			if (ctx.hasUI) await ctx.ui.editor("task attention", text);
			else ctx.ui.notify(text, "info");
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
			ctx.ui.notify(`Reconciled tasks · ${result.backfilled} backfilled · ${result.deactivatedLinks} links deactivated.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-subtree", {
		description: "Preview or confirm safe task-family subtree controls",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const id = parts[0];
			const validActions = new Set<TaskSubtreeControlAction>(["preview", "pause", "resume", "cancel"]);
			const rawAction = parts[1] as TaskSubtreeControlAction | undefined;
			if (!id || (rawAction && !validActions.has(rawAction) && !rawAction.startsWith("--"))) {
				ctx.ui.notify("Usage: /task-subtree <task-id> [preview|pause|resume|cancel] [--confirm] [--preview-token=<token>] [reason...]", "warning");
				return;
			}
			const action = rawAction && validActions.has(rawAction) ? rawAction : "preview";
			const remaining = parts.slice(rawAction && validActions.has(rawAction) ? 2 : 1);
			const confirm = remaining.includes("--confirm") || remaining.includes("confirm");
			const previewToken = remaining.find((part) => part.startsWith("--preview-token="))?.slice("--preview-token=".length);
			const reason = remaining.filter((part) => part !== "--confirm" && part !== "confirm" && !part.startsWith("--preview-token=")).join(" ").trim() || undefined;
			try {
				const preview = buildTaskSubtreeControlPreview(ctx, id, action, { reason });
				const previewText = formatTaskSubtreeControlPreview(preview);
				if (ctx.hasUI) await ctx.ui.editor(`Subtree ${action} preview`, previewText);
				else ctx.ui.notify(previewText, "info");
				if (action === "preview") {
					updateFleetUi(ctx);
					return;
				}
				let ok = confirm;
				if (!ok && ctx.hasUI) ok = await ctx.ui.confirm(`Confirm subtree ${action}`, formatTaskSubtreeControlConfirmation(preview));
				if (!ok) {
					ctx.ui.notify("Subtree control not applied; explicit confirmation is required.", "warning");
					updateFleetUi(ctx);
					return;
				}
				const result = await applyTaskSubtreeControl(ctx, id, action, { reason, previewToken: previewToken ?? (ctx.hasUI ? preview.previewToken : undefined) });
				const resultText = formatTaskSubtreeControlApplyResult(result);
				if (ctx.hasUI) await ctx.ui.editor(`Subtree ${action} result`, resultText);
				else ctx.ui.notify(resultText, result.stopErrors.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
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
		await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 }).catch(() => {});
		reconcileTasks(db, { projectKey: getProjectKey(ctx.cwd), limit: 500 });
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
