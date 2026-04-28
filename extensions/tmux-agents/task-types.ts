export const TASK_STATES = ["todo", "blocked", "in_progress", "in_review", "done"] as const;
export const TASK_WAITING_ON_VALUES = ["user", "coordinator", "service", "external"] as const;
export const TASK_LAUNCH_POLICIES = ["manual", "autonomous"] as const;
export const TASK_WORKSPACE_STRATEGIES = ["inherit", "spawn_cwd", "existing_worktree", "dedicated_worktree"] as const;
export const TASK_NEEDS_HUMAN_KINDS = ["question", "question_for_user", "blocked", "complete", "review_gate", "service_wait", "external_wait"] as const;
export const TASK_NEEDS_HUMAN_CATEGORIES = ["question", "blocker", "completion", "review_gate", "service", "external"] as const;
export const TASK_NEEDS_HUMAN_STATES = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external", "resolved", "cancelled", "superseded"] as const;

export type TaskState = (typeof TASK_STATES)[number];
export type TaskWaitingOn = (typeof TASK_WAITING_ON_VALUES)[number];
export type TaskLaunchPolicy = (typeof TASK_LAUNCH_POLICIES)[number];
export type TaskWorkspaceStrategy = (typeof TASK_WORKSPACE_STRATEGIES)[number];
export type TaskNeedsHumanKind = (typeof TASK_NEEDS_HUMAN_KINDS)[number];
export type TaskNeedsHumanCategory = (typeof TASK_NEEDS_HUMAN_CATEGORIES)[number];
export type TaskNeedsHumanState = (typeof TASK_NEEDS_HUMAN_STATES)[number];

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
	waitingOn: TaskWaitingOn | null;
	blockedReason: string | null;
	requestedProfile: string | null;
	assignedProfile: string | null;
	launchPolicy: TaskLaunchPolicy;
	promptTemplate: string | null;
	roleHint: string | null;
	workspaceStrategy: TaskWorkspaceStrategy | null;
	worktreeId: string | null;
	worktreeCwd: string | null;
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
	waitingOn?: TaskWaitingOn | null;
	blockedReason?: string | null;
	requestedProfile?: string | null;
	assignedProfile?: string | null;
	launchPolicy?: TaskLaunchPolicy | null;
	promptTemplate?: string | null;
	roleHint?: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
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
	waitingOn?: TaskWaitingOn | null;
	blockedReason?: string | null;
	requestedProfile?: string | null;
	assignedProfile?: string | null;
	launchPolicy?: TaskLaunchPolicy | null;
	promptTemplate?: string | null;
	roleHint?: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
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

export interface LinkTaskAgentInput {
	id?: string;
	taskId: string;
	agentId: string;
	role?: string | null;
	isActive?: boolean;
	linkedAt?: number;
	summary?: string | null;
	syncTaskWorkspace?: boolean;
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
	syncTaskWorkspace: boolean;
}

export interface ListTasksFilters {
	ids?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	parentTaskId?: string | null;
	statuses?: TaskState[];
	waitingOn?: TaskWaitingOn[];
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

export interface CreateTaskNeedsHumanInput {
	id: string;
	taskId: string;
	agentId: string;
	taskAgentLinkId?: string | null;
	sourceMessageId?: string | null;
	legacyAttentionItemId?: string | null;
	projectKey: string;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	kind: TaskNeedsHumanKind;
	category: TaskNeedsHumanCategory;
	waitingOn?: TaskWaitingOn | null;
	priority: number;
	state: TaskNeedsHumanState;
	summary: string;
	payload?: unknown;
	responseRequired?: boolean;
	responsePrompt?: string | null;
	responseSchema?: unknown;
	createdAt?: number;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolvedBy?: string | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface UpdateTaskNeedsHumanInput {
	taskAgentLinkId?: string | null;
	state?: TaskNeedsHumanState;
	waitingOn?: TaskWaitingOn | null;
	priority?: number;
	summary?: string;
	payload?: unknown;
	responseRequired?: boolean;
	responsePrompt?: string | null;
	responseSchema?: unknown;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolvedBy?: string | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface TaskNeedsHumanRecord {
	id: string;
	taskId: string;
	agentId: string;
	taskAgentLinkId: string | null;
	sourceMessageId: string | null;
	legacyAttentionItemId: string | null;
	projectKey: string;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	kind: TaskNeedsHumanKind;
	category: TaskNeedsHumanCategory;
	waitingOn: TaskWaitingOn | null;
	priority: number;
	state: TaskNeedsHumanState;
	summary: string;
	payload: unknown;
	responseRequired: boolean;
	responsePrompt: string | null;
	responseSchema: unknown;
	createdAt: number;
	updatedAt: number;
	resolvedAt: number | null;
	resolvedBy: string | null;
	resolutionKind: string | null;
	resolutionSummary: string | null;
}

export interface ListTaskNeedsHumanFilters {
	ids?: string[];
	taskIds?: string[];
	agentIds?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	states?: TaskNeedsHumanState[];
	waitingOn?: TaskWaitingOn[];
	kinds?: TaskNeedsHumanKind[];
	categories?: TaskNeedsHumanCategory[];
	limit?: number;
}

export interface TaskAttentionRecord extends TaskNeedsHumanRecord {
	title: string;
	status: TaskState;
	blockedReason: string | null;
	reviewSummary: string | null;
	activeAgentCount: number;
	openAttentionCount: number;
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
