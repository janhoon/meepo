export const TASK_STATES = ["todo", "blocked", "in_progress", "in_review", "done"] as const;
export const TASK_HEALTH_STATES = ["healthy", "stale", "blocked_external", "approval_required", "empty_or_no_progress", "owner_active", "needs_review"] as const;
export const TASK_WAITING_ON_VALUES = ["user", "coordinator", "service", "external"] as const;
export const TASK_LINK_TYPES = ["depends_on", "relates_to", "duplicates", "spawned_from"] as const;
export const TASK_LINK_STATES = ["active", "resolved", "cancelled"] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskHealthState = (typeof TASK_HEALTH_STATES)[number];
export type TaskHealthSignal = TaskHealthState;
export type TaskWaitingOn = (typeof TASK_WAITING_ON_VALUES)[number];
export type TaskLinkType = (typeof TASK_LINK_TYPES)[number];
export type TaskLinkState = (typeof TASK_LINK_STATES)[number];

export interface TaskRecord {
	id: string;
	parentTaskId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	spawnCwd: string;
	projectKey: string;
	title: string;
	summary: string | null;
	description: string | null;
	status: TaskState;
	priority: number;
	priorityLabel: string | null;
	recommendedProfile: string | null;
	waitingOn: TaskWaitingOn | null;
	blockedReason: string | null;
	acceptanceCriteria: string[];
	planSteps: string[];
	validationSteps: string[];
	labels: string[];
	files: string[];
	reviewSummary: string | null;
	finalSummary: string | null;
	createdAt: number;
	updatedAt: number;
	startedAt: number | null;
	reviewRequestedAt: number | null;
	finishedAt: number | null;
}

export interface TaskHealthSnapshot {
	state: TaskHealthState;
	signals: TaskHealthSignal[];
	lastUsefulUpdateAt: number | null;
	lastUsefulUpdateSummary: string;
	nextAction: string;
	reason: string;
	staleAfterMs: number;
}

export interface CreateTaskInput {
	id: string;
	parentTaskId?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd: string;
	projectKey: string;
	title: string;
	summary?: string | null;
	description?: string | null;
	status: TaskState;
	priority?: number;
	priorityLabel?: string | null;
	recommendedProfile?: string | null;
	waitingOn?: TaskWaitingOn | null;
	blockedReason?: string | null;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	labels?: string[];
	files?: string[];
	reviewSummary?: string | null;
	finalSummary?: string | null;
	createdAt?: number;
	updatedAt?: number;
	startedAt?: number | null;
	reviewRequestedAt?: number | null;
	finishedAt?: number | null;
}

export interface UpdateTaskInput {
	parentTaskId?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd?: string;
	projectKey?: string;
	title?: string;
	summary?: string | null;
	description?: string | null;
	status?: TaskState;
	priority?: number;
	priorityLabel?: string | null;
	recommendedProfile?: string | null;
	waitingOn?: TaskWaitingOn | null;
	blockedReason?: string | null;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	labels?: string[];
	files?: string[];
	reviewSummary?: string | null;
	finalSummary?: string | null;
	updatedAt?: number;
	startedAt?: number | null;
	reviewRequestedAt?: number | null;
	finishedAt?: number | null;
}

export interface CreateTaskEventInput {
	id: string;
	taskId: string;
	agentId?: string | null;
	eventType: string;
	summary: string;
	payload?: unknown;
	createdAt?: number;
}

export interface TaskEventRecord {
	id: string;
	taskId: string;
	agentId: string | null;
	eventType: string;
	summary: string;
	payload: unknown;
	createdAt: number;
}

export interface TaskLinkRecord {
	id: string;
	sourceTaskId: string;
	targetTaskId: string;
	linkType: TaskLinkType;
	state: TaskLinkState;
	summary: string | null;
	metadata: unknown;
	createdAt: number;
	updatedAt: number;
	resolvedAt: number | null;
}

export interface TaskLinkWithTasksRecord extends TaskLinkRecord {
	sourceTitle: string;
	sourceStatus: TaskState;
	targetTitle: string;
	targetStatus: TaskState;
	unresolved: boolean;
}

export interface CreateTaskLinkInput {
	id?: string;
	sourceTaskId: string;
	targetTaskId: string;
	linkType?: TaskLinkType;
	state?: TaskLinkState;
	summary?: string | null;
	metadata?: unknown;
	createdAt?: number;
	updatedAt?: number;
	resolvedAt?: number | null;
	blockSource?: boolean;
}

export interface ListTaskLinksFilters {
	ids?: string[];
	sourceTaskIds?: string[];
	targetTaskIds?: string[];
	taskIds?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	linkTypes?: TaskLinkType[];
	states?: TaskLinkState[];
	includeResolved?: boolean;
	limit?: number;
}

export interface TaskReadinessRecord {
	task: TaskRecord;
	activeAgentCount: number;
	unresolvedDependencies: TaskLinkWithTasksRecord[];
	resolvedDependencies: TaskLinkWithTasksRecord[];
	dependents: TaskLinkWithTasksRecord[];
	ready: boolean;
	reason: string;
}

export interface LinkTaskAgentInput {
	id?: string;
	taskId: string;
	agentId: string;
	role?: string | null;
	isActive?: boolean;
	linkedAt?: number;
	summary?: string | null;
	allowDuplicateOwner?: boolean;
}

export interface TaskAgentLinkRecord {
	id: string;
	taskId: string;
	agentId: string;
	role: string;
	isActive: boolean;
	linkedAt: number;
	unlinkedAt: number | null;
	summary: string | null;
}

export interface ListTasksFilters {
	ids?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	parentTaskId?: string | null;
	statuses?: TaskState[];
	waitingOn?: TaskWaitingOn[];
	recommendedProfile?: string;
	linkedAgentId?: string;
	includeDone?: boolean;
	limit?: number;
}

export interface ListTaskEventsFilters {
	taskIds?: string[];
	limit?: number;
}

export interface ListTaskAgentLinksFilters {
	taskIds?: string[];
	agentIds?: string[];
	activeOnly?: boolean;
	limit?: number;
}

export interface TaskSummaryCounts {
	todo: number;
	blocked: number;
	inProgress: number;
	inReview: number;
	done: number;
	waitingOnUser: number;
}

export interface TaskAttentionRecord {
	taskId: string;
	title: string;
	status: TaskState;
	waitingOn: TaskWaitingOn | null;
	summary: string;
	blockedReason: string | null;
	reviewSummary: string | null;
	updatedAt: number;
	activeAgentCount: number;
	openAttentionCount: number;
	unresolvedDependencyCount: number;
	readyUnblocked: boolean;
	health: TaskHealthState;
	healthSignals: TaskHealthSignal[];
	lastUsefulUpdateAt: number | null;
	nextAction: string;
}

export function normalizeTaskState(value: string | null | undefined): TaskState {
	switch (value) {
		case "blocked":
		case "in_progress":
		case "in_review":
		case "done":
			return value;
		case "todo":
		default:
			return "todo";
	}
}

export function taskStateLabel(state: TaskState): string {
	switch (state) {
		case "todo":
			return "To Do";
		case "blocked":
			return "Blocked";
		case "in_progress":
			return "In Progress";
		case "in_review":
			return "In Review";
		case "done":
			return "Done";
		default:
			return state;
	}
}
