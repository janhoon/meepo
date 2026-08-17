/**
 * TypeBox parameter schemas for Meepo coordinator tools.
 */
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { getAllowedBuiltinToolNames } from "./profiles.js";

export const LIST_SCOPE = StringEnum(["all", "current_project", "current_session", "descendants"] as const, {
	description: "Which slice of the global registry to inspect.",
	default: "current_project",
});

export const SubagentSpawnParams = Type.Object({
	title: Type.String({ description: "Short title for the child agent." }),
	task: Type.String({ description: "Task to delegate to the child agent." }),
	profile: Type.String({ description: "Consumer agent profile name (markdown under ~/.pi/agent/agents or profiles.dirs). Meepo does not ship profiles." }),
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

export const DOWNWARD_MESSAGE_KIND = StringEnum(["answer", "note", "redirect", "cancel", "priority"] as const, {
	description: "Structured downward message kind for a child agent.",
});

export const DELIVERY_MODE = StringEnum(["immediate", "steer", "follow_up", "idle_only"] as const, {
	description: "Delivery preference for downward messages.",
	default: "immediate",
});

export const DOWNWARD_ACTION_POLICY = StringEnum(["fyi", "resume_if_blocked", "replan", "interrupt_and_replan", "stop"] as const, {
	description: "How the child should react to this coordinator message.",
});

export const SubagentFocusParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to focus on the frozen ProcessHost (tmux or herdr)." }),
});

export const SubagentStopParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to stop." }),
	force: Type.Optional(Type.Boolean({ description: "Kill the host pane/window immediately instead of queueing a graceful cancel.", default: false })),
	reason: Type.Optional(Type.String({ description: "Optional reason shown to the child or event log." })),
});

export const SubagentMessageParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to message." }),
	kind: DOWNWARD_MESSAGE_KIND,
	summary: Type.String({ description: "Short message summary for the child." }),
	details: Type.Optional(Type.String({ description: "Additional context for the child." })),
	files: Type.Optional(Type.Array(Type.String({ description: "Relevant file path" }), { maxItems: 100 })),
	actionPolicy: Type.Optional(DOWNWARD_ACTION_POLICY),
	inReplyToMessageId: Type.Optional(Type.String({ description: "Optional child-originated message id this responds to." })),
	deliveryMode: Type.Optional(DELIVERY_MODE),
});

export const SubagentCaptureParams = Type.Object({
	id: Type.String({ description: "Tracked child agent id to capture from tmux." }),
	lines: Type.Optional(Type.Integer({ description: "Number of trailing lines to capture from the tmux pane.", minimum: 1, maximum: 5000, default: 200 })),
});

export const SubagentReconcileParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only reconcile active agents.", default: true })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to reconcile.", minimum: 1, maximum: 500, default: 100 })),
});

export const SubagentListParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only include active agents.", default: false })),
	blockedOnly: Type.Optional(Type.Boolean({ description: "Only include blocked agents.", default: false })),
	unreadOnly: Type.Optional(Type.Boolean({ description: "Only include agents with unread child-originated mail.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to return.", minimum: 1, maximum: 200, default: 50 })),
});

export const SubagentGetParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Agent id" }), {
		description: "One or more agent ids to inspect.",
		minItems: 1,
		maxItems: 50,
	}),
});

export const SubagentInboxParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of messages to return.", minimum: 1, maximum: 500, default: 100 })),
	includeDelivered: Type.Optional(
		Type.Boolean({ description: "Include messages already marked delivered/acked.", default: false }),
	),
});

export const ATTENTION_AUDIENCE_SCOPE = StringEnum(["all", "coordinator", "user"] as const, {
	description: "Which audience slice of attention items to inspect.",
	default: "all",
});

export const SubagentAttentionParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	audience: Type.Optional(ATTENTION_AUDIENCE_SCOPE),
	includeResolved: Type.Optional(Type.Boolean({ description: "Include resolved/cancelled/superseded attention items.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of attention items to return.", minimum: 1, maximum: 500, default: 100 })),
});

export const SubagentCleanupParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String({ description: "Agent id" }), { minItems: 1, maxItems: 100 })),
	force: Type.Optional(Type.Boolean({ description: "Clean terminal agents even if unresolved non-completion attention items still exist.", default: false })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview cleanup candidates without killing host targets.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of agents to inspect for cleanup.", minimum: 1, maximum: 500, default: 100 })),
});

export const TASK_STATE = StringEnum(["todo", "blocked", "in_progress", "in_review", "done"] as const, {
	description: "Task board status.",
	default: "todo",
});

export const TASK_WAITING_ON = StringEnum(["user", "coordinator", "service", "external"] as const, {
	description: "Who or what this blocked task is waiting on.",
});

export const TASK_SORT = StringEnum(["priority", "updated", "created", "title", "status"] as const, {
	description: "Task list sort order.",
	default: "priority",
});

export const TASK_LINK_TYPE = StringEnum(["depends_on", "relates_to", "duplicates", "spawned_from"] as const, {
	description: "Task relationship type. For depends_on, sourceTaskId is blocked by targetTaskId.",
	default: "depends_on",
});

export const TASK_LINK_STATE = StringEnum(["active", "resolved", "cancelled"] as const, {
	description: "Task relationship state.",
});

export const TASK_SUBTREE_CONTROL_ACTION = StringEnum(["preview", "pause", "resume", "cancel"] as const, {
	description: "Safe subtree control action. Non-preview actions require explicit confirmation.",
	default: "preview",
});

export const TaskCreateParams = Type.Object({
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

export const TaskListParams = Type.Object({
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

export const TaskGetParams = Type.Object({
	ids: Type.Array(Type.String(), { minItems: 1, maxItems: 100 }),
	includeEvents: Type.Optional(Type.Boolean({ description: "Include recent task events.", default: true })),
	eventLimit: Type.Optional(Type.Integer({ description: "Maximum task events per task.", minimum: 1, maximum: 200, default: 20 })),
});

export const TaskUpdateParams = Type.Object({
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

export const TaskMoveParams = Type.Object({
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

export const TASK_INTERACTION_RESOLUTION_KIND = StringEnum(["resolved", "approved", "rejected", "changes_requested", "superseded", "cancelled"] as const, {
	description: "How an attached task interaction should be dispositioned by this note.",
	default: "resolved",
});

export const TaskNoteParams = Type.Object({
	id: Type.String({ description: "Task id." }),
	summary: Type.String({ description: "Short task note summary." }),
	details: Type.Optional(Type.String({ description: "Longer task note details." })),
	files: Type.Optional(Type.Array(Type.String(), { maxItems: 200 })),
	resolveInteractionId: Type.Optional(Type.String({ description: "Optional Attention id to resolve with this note." })),
	resolutionKind: Type.Optional(TASK_INTERACTION_RESOLUTION_KIND),
	resolutionSummary: Type.Optional(Type.String({ description: "Optional resolution summary for the task interaction; defaults to the note summary." })),
});

export const TaskLinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	role: Type.Optional(Type.String({ description: "Role of this agent on the task." })),
	active: Type.Optional(Type.Boolean({ description: "Whether the link should be active.", default: true })),
	allowDuplicateOwner: Type.Optional(Type.Boolean({ description: "Allow an additional exclusive owner when this task already has an active exclusive owner. Reviewer roles are allowed without this override.", default: false })),
});

export const TaskUnlinkAgentParams = Type.Object({
	taskId: Type.String({ description: "Task id." }),
	agentId: Type.String({ description: "Agent id." }),
	reason: Type.Optional(Type.String({ description: "Why the agent is being unlinked." })),
});

export const TaskLinkParams = Type.Object({
	sourceTaskId: Type.String({ description: "Source task id. For depends_on, this is the blocked/dependent task." }),
	targetTaskId: Type.String({ description: "Target task id. For depends_on, this is the prerequisite task." }),
	linkType: Type.Optional(TASK_LINK_TYPE),
	summary: Type.Optional(Type.String({ description: "Optional relationship summary." })),
	blockSource: Type.Optional(Type.Boolean({ description: "For depends_on links, automatically mark the source blocked while prerequisites are unresolved.", default: true })),
});

export const TaskUnlinkParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Task link id to cancel." })),
	sourceTaskId: Type.Optional(Type.String({ description: "Source task id if cancelling by pair." })),
	targetTaskId: Type.Optional(Type.String({ description: "Target task id if cancelling by pair." })),
	linkType: Type.Optional(TASK_LINK_TYPE),
	reason: Type.Optional(Type.String({ description: "Why the task relationship is being cancelled." })),
});

export const TaskLinksParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	taskId: Type.Optional(Type.String({ description: "Show links where this task is source or target." })),
	sourceTaskId: Type.Optional(Type.String({ description: "Show links from this source task." })),
	targetTaskId: Type.Optional(Type.String({ description: "Show links to this target task." })),
	linkTypes: Type.Optional(Type.Array(TASK_LINK_TYPE, { maxItems: 10 })),
	states: Type.Optional(Type.Array(TASK_LINK_STATE, { maxItems: 10 })),
	includeResolved: Type.Optional(Type.Boolean({ description: "Include resolved/cancelled links when states are not provided.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of task links to return.", minimum: 1, maximum: 500, default: 100 })),
});

export const TaskReadyParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 200 })),
	recommendedProfile: Type.Optional(Type.String({ description: "Only include ready tasks with this recommended profile." })),
	includeBlocked: Type.Optional(Type.Boolean({ description: "Include non-ready tasks with dependency/readiness reasons.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of tasks to inspect.", minimum: 1, maximum: 500, default: 100 })),
});

export const TaskDispatchReadyParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	ids: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: 100 })),
	fallbackProfile: Type.Optional(Type.String({ description: "Profile to use for ready tasks missing recommendedProfile." })),
	maxDispatch: Type.Optional(Type.Integer({ description: "Maximum number of ready tasks to dispatch.", minimum: 1, maximum: 20, default: 5 })),
	dryRun: Type.Optional(Type.Boolean({ description: "Preview dispatchable ready tasks without spawning agents.", default: false })),
});

export const TaskAttentionParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of task attention items.", minimum: 1, maximum: 500, default: 100 })),
});

export const TaskReconcileParams = Type.Object({
	scope: Type.Optional(LIST_SCOPE),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of items to reconcile.", minimum: 1, maximum: 500, default: 200 })),
});

export const TaskSubtreeControlParams = Type.Object({
	id: Type.String({ description: "Root task id for the task family subtree." }),
	action: Type.Optional(TASK_SUBTREE_CONTROL_ACTION),
	includeRoot: Type.Optional(Type.Boolean({ description: "Include the root task itself in the selected subtree. Defaults true.", default: true })),
	confirm: Type.Optional(Type.Boolean({ description: "Required true to apply pause/resume/cancel. False returns the preview only.", default: false })),
	previewToken: Type.Optional(Type.String({ description: "Preview token returned by the prior dry-run preview. Required with confirm=true for pause/resume/cancel." })),
	reason: Type.Optional(Type.String({ description: "Reason written to task events and graceful stop messages." })),
});

export const SERVICE_SCOPE = StringEnum(["all", "current_project", "current_session"] as const, {
	description: "Which slice of tracked tmux services to inspect.",
	default: "current_project",
});

export const TmuxServiceStartParams = Type.Object({
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

export const TmuxServiceListParams = Type.Object({
	scope: Type.Optional(SERVICE_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only include active services.", default: false })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of services to return.", minimum: 1, maximum: 200, default: 50 })),
});

export const TmuxServiceGetParams = Type.Object({
	ids: Type.Array(Type.String({ description: "Tracked service id" }), {
		description: "One or more tracked tmux service ids to inspect.",
		minItems: 1,
		maxItems: 50,
	}),
});

export const TmuxServiceFocusParams = Type.Object({
	id: Type.String({ description: "Tracked service id to focus on the frozen ProcessHost." }),
});

export const TmuxServiceStopParams = Type.Object({
	id: Type.String({ description: "Tracked service id to stop." }),
	force: Type.Optional(Type.Boolean({ description: "Kill the host pane/window immediately instead of sending an interrupt.", default: false })),
	reason: Type.Optional(Type.String({ description: "Optional reason shown in the result text." })),
});

export const TmuxServiceCaptureParams = Type.Object({
	id: Type.String({ description: "Tracked service id to capture logs from." }),
	lines: Type.Optional(Type.Integer({ description: "Number of trailing lines to capture.", minimum: 1, maximum: 5000, default: 200 })),
});

export const TmuxServiceReconcileParams = Type.Object({
	scope: Type.Optional(SERVICE_SCOPE),
	activeOnly: Type.Optional(Type.Boolean({ description: "Only reconcile active services.", default: true })),
	limit: Type.Optional(Type.Integer({ description: "Maximum number of services to reconcile.", minimum: 1, maximum: 500, default: 100 })),
});


