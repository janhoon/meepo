/**
 * Task registry barrel — stable public import path.
 */
export { TASK_HEALTH_DEFAULT_STALE_AFTER_MS, taskLeaseKindForProfile } from "./task-shared.js";
export type { TaskLeaseKind, TaskLeaseOwnerRecord, TaskLeaseStateRecord, TaskLeaseConflictRecord } from "./task-shared.js";

export {
	createTask,
	updateTask,
	listTasks,
	getTask,
	listTaskSubtreeWithMeta,
	listTaskSubtree,
	createTaskEvent,
	listTaskEvents,
} from "./task-store.js";

export { deriveTaskHealth, listTaskHealth } from "./task-health.js";

export {
	listTaskLinks,
	listUnresolvedTaskDependencies,
	refreshTaskDependencyBlockState,
	createTaskLink,
	cancelTaskLink,
	resolveDependenciesForCompletedTask,
	listTaskReadiness,
} from "./task-graph.js";

export {
	listTaskLeaseOwners,
	getTaskLease,
	getTaskLeaseConflict,
	formatTaskLeaseConflict,
	assertTaskLeaseAvailable,
} from "./task-leases.js";

export { listTaskAgentLinks } from "./task-leases.js";

export {
	linkTaskAgent,
	unlinkTaskAgent,
	getTaskSummary,
} from "./task-links-agents.js";

export {
	listTaskAttention,
	applyChildPublishToLinkedTask,
	backfillLegacyTasksFromAgents,
	reconcileTasks,
} from "./task-ops.js";
