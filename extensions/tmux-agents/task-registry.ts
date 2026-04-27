import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentAttentionV2State, AgentState, AttentionItemKind, AttentionItemState } from "./types.js";
import type {
	CreateTaskEventInput,
	CreateTaskInput,
	CreateTaskLinkInput,
	LinkTaskAgentInput,
	ListTaskAgentLinksFilters,
	ListTaskEventsFilters,
	ListTaskLinksFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskEventRecord,
	TaskHealthSignal,
	TaskHealthSnapshot,
	TaskHealthState,
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

const ACTIVE_AGENT_STATES: AgentState[] = ["launching", "running", "idle", "waiting", "blocked"];
const OPEN_ATTENTION_STATES: AttentionItemState[] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];
const OPEN_AGENT_ATTENTION_V2_STATES: AgentAttentionV2State[] = ["open", "acknowledged", "waiting_on_owner"];
export const TASK_HEALTH_DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const TASK_REVIEW_LEASE_PROFILES = new Set(["principal-engineer", "qa-lead", "reviewer"]);

export type TaskLeaseKind = "exclusive" | "review";

export interface TaskLeaseOwnerRecord {
	taskId: string;
	agentId: string;
	profile: string;
	role: string;
	state: AgentState;
	title: string;
	linkedAt: number;
	summary: string | null;
	leaseKind: TaskLeaseKind;
}

export interface TaskLeaseStateRecord {
	taskId: string;
	activeOwners: TaskLeaseOwnerRecord[];
	exclusiveOwners: TaskLeaseOwnerRecord[];
	reviewOwners: TaskLeaseOwnerRecord[];
}

export interface TaskLeaseConflictRecord {
	taskId: string;
	requestedProfile: string;
	requestedLeaseKind: TaskLeaseKind;
	conflictingOwners: TaskLeaseOwnerRecord[];
}

const TASK_FIELD_TO_COLUMN: Record<keyof UpdateTaskInput, string> = {
	parentTaskId: "parent_task_id",
	spawnSessionId: "spawn_session_id",
	spawnSessionFile: "spawn_session_file",
	spawnCwd: "spawn_cwd",
	projectKey: "project_key",
	title: "title",
	summary: "summary",
	description: "description",
	status: "status",
	priority: "priority",
	priorityLabel: "priority_label",
	recommendedProfile: "recommended_profile",
	waitingOn: "waiting_on",
	blockedReason: "blocked_reason",
	acceptanceCriteria: "acceptance_criteria_json",
	planSteps: "plan_steps_json",
	validationSteps: "validation_steps_json",
	labels: "labels_json",
	files: "files_json",
	reviewSummary: "review_summary",
	finalSummary: "final_summary",
	updatedAt: "updated_at",
	startedAt: "started_at",
	reviewRequestedAt: "review_requested_at",
	finishedAt: "finished_at",
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function normalizeStringArray(values: string[] | null | undefined): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values ?? []) {
		const trimmed = String(value ?? "").trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

function mergeStringArrays(...parts: Array<string[] | null | undefined>): string[] {
	return normalizeStringArray(parts.flatMap((part) => part ?? []));
}

function makePlaceholders(count: number): string {
	return new Array(count).fill("?").join(", ");
}

export function taskLeaseKindForProfile(profile: string | null | undefined): TaskLeaseKind {
	const normalized = (profile ?? "").trim().toLowerCase();
	return TASK_REVIEW_LEASE_PROFILES.has(normalized) ? "review" : "exclusive";
}

function toTaskLeaseOwnerRecord(row: Record<string, unknown>): TaskLeaseOwnerRecord {
	const profile = row.profile as string;
	const role = (row.role as string | null) ?? profile;
	return {
		taskId: row.task_id as string,
		agentId: row.agent_id as string,
		profile,
		role,
		state: row.state as AgentState,
		title: row.title as string,
		linkedAt: Number(row.linked_at ?? 0),
		summary: (row.summary as string | null) ?? null,
		leaseKind: taskLeaseKindForProfile(role || profile),
	};
}

function addSessionScopeFilter(
	where: string[],
	params: unknown[],
	spawnSessionId: string | undefined,
	spawnSessionFile: string | undefined,
	alias = "t",
): void {
	if (spawnSessionId && spawnSessionFile) {
		where.push(`(${alias}.spawn_session_id = ? OR ${alias}.spawn_session_file = ?)`);
		params.push(spawnSessionId, spawnSessionFile);
		return;
	}
	if (spawnSessionId) {
		where.push(`${alias}.spawn_session_id = ?`);
		params.push(spawnSessionId);
		return;
	}
	if (spawnSessionFile) {
		where.push(`${alias}.spawn_session_file = ?`);
		params.push(spawnSessionFile);
	}
}

function toTaskRecord(row: Record<string, unknown>): TaskRecord {
	return {
		id: row.id as string,
		parentTaskId: (row.parent_task_id as string | null) ?? null,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		spawnCwd: row.spawn_cwd as string,
		projectKey: row.project_key as string,
		title: row.title as string,
		summary: (row.summary as string | null) ?? null,
		description: (row.description as string | null) ?? null,
		status: row.status as TaskState,
		priority: Number(row.priority ?? 3),
		priorityLabel: (row.priority_label as string | null) ?? null,
		recommendedProfile: (row.recommended_profile as string | null) ?? null,
		waitingOn: (row.waiting_on as TaskWaitingOn | null) ?? null,
		blockedReason: (row.blocked_reason as string | null) ?? null,
		acceptanceCriteria: normalizeStringArray(safeJsonParse(row.acceptance_criteria_json as string | null, [])),
		planSteps: normalizeStringArray(safeJsonParse(row.plan_steps_json as string | null, [])),
		validationSteps: normalizeStringArray(safeJsonParse(row.validation_steps_json as string | null, [])),
		labels: normalizeStringArray(safeJsonParse(row.labels_json as string | null, [])),
		files: normalizeStringArray(safeJsonParse(row.files_json as string | null, [])),
		reviewSummary: (row.review_summary as string | null) ?? null,
		finalSummary: (row.final_summary as string | null) ?? null,
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		startedAt: (row.started_at as number | null) ?? null,
		reviewRequestedAt: (row.review_requested_at as number | null) ?? null,
		finishedAt: (row.finished_at as number | null) ?? null,
	};
}

function toTaskEventRecord(row: Record<string, unknown>): TaskEventRecord {
	return {
		id: row.id as string,
		taskId: row.task_id as string,
		agentId: (row.agent_id as string | null) ?? null,
		eventType: row.event_type as string,
		summary: row.summary as string,
		payload: safeJsonParse(row.payload_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
	};
}

function toTaskAgentLinkRecord(row: Record<string, unknown>): TaskAgentLinkRecord {
	return {
		id: row.id as string,
		taskId: row.task_id as string,
		agentId: row.agent_id as string,
		role: (row.role as string | null) ?? "contributor",
		isActive: Number(row.is_active ?? 0) === 1,
		linkedAt: Number(row.linked_at ?? 0),
		unlinkedAt: (row.unlinked_at as number | null) ?? null,
		summary: (row.summary as string | null) ?? null,
	};
}

function toTaskLinkRecord(row: Record<string, unknown>): TaskLinkWithTasksRecord {
	const linkType = row.link_type as TaskLinkType;
	const state = row.state as TaskLinkState;
	const targetStatus = row.target_status as TaskState;
	return {
		id: row.id as string,
		sourceTaskId: row.source_task_id as string,
		targetTaskId: row.target_task_id as string,
		linkType,
		state,
		summary: (row.summary as string | null) ?? null,
		metadata: safeJsonParse(row.metadata_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		resolvedAt: (row.resolved_at as number | null) ?? null,
		sourceTitle: (row.source_title as string | null) ?? (row.source_task_id as string),
		sourceStatus: (row.source_status as TaskState | null) ?? "todo",
		targetTitle: (row.target_title as string | null) ?? (row.target_task_id as string),
		targetStatus: targetStatus ?? "todo",
		unresolved: linkType === "depends_on" && state === "active" && targetStatus !== "done",
	};
}

function taskStatusOrderSql(column = "t.status"): string {
	return `CASE ${column} WHEN 'blocked' THEN 0 WHEN 'in_review' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 ELSE 5 END`;
}

function deriveDefaultTaskStatus(profile: string, kind: "milestone" | "blocked" | "question" | "question_for_user" | "note" | "complete"): TaskState | null {
	if (kind === "blocked" || kind === "question" || kind === "question_for_user") return "blocked";
	if (kind === "milestone" || kind === "note") return "in_progress";
	if (kind !== "complete") return null;
	switch (profile) {
		case "worker":
			return "in_review";
		case "reviewer":
			return "done";
		case "scout":
		case "planner":
			return "todo";
		default:
			return "in_review";
	}
}

function nowOr(value: number | null | undefined, fallback: number): number | null {
	return value ?? fallback;
}

export function createTask(db: DatabaseSync, input: CreateTaskInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT INTO tasks (
			id,
			parent_task_id,
			spawn_session_id,
			spawn_session_file,
			spawn_cwd,
			project_key,
			title,
			summary,
			description,
			status,
			priority,
			priority_label,
			recommended_profile,
			waiting_on,
			blocked_reason,
			acceptance_criteria_json,
			plan_steps_json,
			validation_steps_json,
			labels_json,
			files_json,
			review_summary,
			final_summary,
			created_at,
			updated_at,
			started_at,
			review_requested_at,
			finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.parentTaskId ?? null,
		input.spawnSessionId ?? null,
		input.spawnSessionFile ?? null,
		input.spawnCwd,
		input.projectKey,
		input.title,
		input.summary ?? null,
		input.description ?? null,
		input.status,
		Math.max(0, Math.min(input.priority ?? 3, 9)),
		input.priorityLabel ?? null,
		input.recommendedProfile?.trim() || null,
		input.waitingOn ?? null,
		input.blockedReason ?? null,
		JSON.stringify(normalizeStringArray(input.acceptanceCriteria)),
		JSON.stringify(normalizeStringArray(input.planSteps)),
		JSON.stringify(normalizeStringArray(input.validationSteps)),
		JSON.stringify(normalizeStringArray(input.labels)),
		JSON.stringify(normalizeStringArray(input.files)),
		input.reviewSummary ?? null,
		input.finalSummary ?? null,
		createdAt,
		updatedAt,
		input.startedAt ?? null,
		input.reviewRequestedAt ?? null,
		input.finishedAt ?? null,
	);
}

export function updateTask(db: DatabaseSync, id: string, patch: UpdateTaskInput): void {
	const assignments: string[] = [];
	const params: unknown[] = [];
	for (const [field, value] of Object.entries(patch) as Array<[keyof UpdateTaskInput, UpdateTaskInput[keyof UpdateTaskInput]]>) {
		if (value === undefined) continue;
		const column = TASK_FIELD_TO_COLUMN[field];
		if (!column) continue;
		assignments.push(`${column} = ?`);
		if (["acceptanceCriteria", "planSteps", "validationSteps", "labels", "files"].includes(field)) {
			params.push(JSON.stringify(normalizeStringArray(value as string[] | undefined)));
		} else {
			params.push(value);
		}
	}
	if (assignments.length === 0) return;
	params.push(id);
	db.prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

export function listTasks(db: DatabaseSync, filters: ListTasksFilters = {}): TaskRecord[] {
	if (filters.ids && filters.ids.length === 0) return [];
	const where: string[] = [];
	const joinParams: unknown[] = [];
	const params: unknown[] = [];
	const joins: string[] = [];
	if (filters.linkedAgentId) {
		joins.push("JOIN task_agent_links tal ON tal.task_id = t.id AND tal.agent_id = ?");
		joinParams.push(filters.linkedAgentId);
	}
	if (filters.ids && filters.ids.length > 0) {
		where.push(`t.id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.projectKey) {
		where.push("t.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	if (filters.parentTaskId !== undefined) {
		if (filters.parentTaskId === null) where.push("t.parent_task_id IS NULL");
		else {
			where.push("t.parent_task_id = ?");
			params.push(filters.parentTaskId);
		}
	}
	if (filters.statuses && filters.statuses.length > 0) {
		where.push(`t.status IN (${makePlaceholders(filters.statuses.length)})`);
		params.push(...filters.statuses);
	} else if (!filters.includeDone) {
		where.push("t.status != 'done'");
	}
	if (filters.waitingOn && filters.waitingOn.length > 0) {
		where.push(`t.waiting_on IN (${makePlaceholders(filters.waitingOn.length)})`);
		params.push(...filters.waitingOn);
	}
	if (filters.recommendedProfile) {
		where.push("t.recommended_profile = ?");
		params.push(filters.recommendedProfile);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	const rows = db
		.prepare(
			`SELECT DISTINCT t.*
			 FROM tasks t
			 ${joins.join(" ")}
			 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY ${taskStatusOrderSql()}, t.priority ASC, t.updated_at DESC
			 LIMIT ?`,
		)
		.all(...joinParams, ...params, limit) as Array<Record<string, unknown>>;
	return rows.map(toTaskRecord);
}

export function getTask(db: DatabaseSync, id: string): TaskRecord | null {
	return listTasks(db, { ids: [id], includeDone: true, limit: 1 })[0] ?? null;
}

export interface TaskSubtreeQueryResult {
	tasks: TaskRecord[];
	limit: number;
	maxDepth: number;
	returnedCount: number;
	maxReturnedDepth: number;
	hitLimit: boolean;
	hitDepthLimit: boolean;
}

export function listTaskSubtreeWithMeta(
	db: DatabaseSync,
	rootTaskId: string,
	options: { includeRoot?: boolean; includeDone?: boolean; limit?: number; maxDepth?: number } = {},
): TaskSubtreeQueryResult {
	const includeRoot = options.includeRoot ?? true;
	const includeDone = options.includeDone ?? true;
	const limit = Math.max(1, Math.min(options.limit ?? 500, 1000));
	const maxDepth = Math.max(0, Math.min(options.maxDepth ?? limit, 1000));
	const rows = db
		.prepare(
			`WITH RECURSIVE task_subtree(id, depth, path) AS (
				SELECT id, 0, '|' || id || '|'
				FROM tasks
				WHERE id = ?
				UNION ALL
				SELECT child.id, task_subtree.depth + 1, task_subtree.path || child.id || '|'
				FROM tasks child
				JOIN task_subtree ON child.parent_task_id = task_subtree.id
				WHERE task_subtree.depth < ?
					AND instr(task_subtree.path, '|' || child.id || '|') = 0
			)
			SELECT t.*, task_subtree.depth AS subtree_depth
			FROM task_subtree
			JOIN tasks t ON t.id = task_subtree.id
			WHERE (? = 1 OR t.id != ?)
				AND (? = 1 OR t.status != 'done')
			ORDER BY task_subtree.depth ASC, ${taskStatusOrderSql("t.status")}, t.priority ASC, t.updated_at DESC
			LIMIT ?`,
		)
		.all(rootTaskId, maxDepth, includeRoot ? 1 : 0, rootTaskId, includeDone ? 1 : 0, limit) as Array<Record<string, unknown>>;
	const depthProbe = db
		.prepare(
			`WITH RECURSIVE task_subtree(id, depth, path) AS (
				SELECT id, 0, '|' || id || '|'
				FROM tasks
				WHERE id = ?
				UNION ALL
				SELECT child.id, task_subtree.depth + 1, task_subtree.path || child.id || '|'
				FROM tasks child
				JOIN task_subtree ON child.parent_task_id = task_subtree.id
				WHERE task_subtree.depth < ?
					AND instr(task_subtree.path, '|' || child.id || '|') = 0
			)
			SELECT 1 AS hit
			FROM task_subtree
			JOIN tasks child ON child.parent_task_id = task_subtree.id
			WHERE task_subtree.depth = ?
				AND instr(task_subtree.path, '|' || child.id || '|') = 0
			LIMIT 1`,
		)
		.get(rootTaskId, maxDepth, maxDepth) as { hit?: number } | undefined;
	const maxReturnedDepth = rows.reduce((max, row) => Math.max(max, Number(row.subtree_depth ?? 0)), 0);
	return {
		tasks: rows.map(toTaskRecord),
		limit,
		maxDepth,
		returnedCount: rows.length,
		maxReturnedDepth,
		hitLimit: rows.length >= limit,
		hitDepthLimit: Boolean(depthProbe?.hit),
	};
}

export function listTaskSubtree(
	db: DatabaseSync,
	rootTaskId: string,
	options: { includeRoot?: boolean; includeDone?: boolean; limit?: number; maxDepth?: number } = {},
): TaskRecord[] {
	return listTaskSubtreeWithMeta(db, rootTaskId, options).tasks;
}

export function createTaskEvent(db: DatabaseSync, input: CreateTaskEventInput): void {
	db.prepare(
		"INSERT INTO task_events (id, task_id, agent_id, event_type, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
	).run(
		input.id,
		input.taskId,
		input.agentId ?? null,
		input.eventType,
		input.summary,
		input.payload === undefined ? null : JSON.stringify(input.payload),
		input.createdAt ?? Date.now(),
	);
}

export function listTaskEvents(db: DatabaseSync, filters: ListTaskEventsFilters = {}): TaskEventRecord[] {
	if (filters.taskIds && filters.taskIds.length === 0) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT *
			 FROM task_events
			 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toTaskEventRecord);
}

interface TaskHealthMetrics {
	activeAgentCount: number;
	linkedAgentCount: number;
	openAttentionCount: number;
	openCompletionAttentionCount: number;
	unresolvedDependencyCount: number;
	latestEvent: TaskEventRecord | null;
	latestAgentUpdateAt: number | null;
	latestActiveAgentUpdateAt: number | null;
}

function createTaskHealthMetrics(): TaskHealthMetrics {
	return {
		activeAgentCount: 0,
		linkedAgentCount: 0,
		openAttentionCount: 0,
		openCompletionAttentionCount: 0,
		unresolvedDependencyCount: 0,
		latestEvent: null,
		latestAgentUpdateAt: null,
		latestActiveAgentUpdateAt: null,
	};
}

function normalizeHealthSignals(signals: TaskHealthSignal[]): TaskHealthSignal[] {
	const seen = new Set<TaskHealthSignal>();
	const normalized: TaskHealthSignal[] = [];
	for (const signal of signals) {
		if (seen.has(signal)) continue;
		seen.add(signal);
		normalized.push(signal);
	}
	return normalized.length > 0 ? normalized : ["healthy"];
}

function taskHasUsefulBody(task: TaskRecord): boolean {
	return Boolean(
		task.summary?.trim() ||
			task.description?.trim() ||
			task.blockedReason?.trim() ||
			task.reviewSummary?.trim() ||
			task.finalSummary?.trim() ||
			task.acceptanceCriteria.length > 0 ||
			task.planSteps.length > 0 ||
			task.validationSteps.length > 0 ||
			task.files.length > 0,
	);
}

function healthDuration(valueMs: number): string {
	const minutes = Math.max(1, Math.round(valueMs / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return `${count} ${count === 1 ? singular : plural}`;
}

export function deriveTaskHealth(input: {
	task: TaskRecord;
	activeAgentCount?: number;
	linkedAgentCount?: number;
	openAttentionCount?: number;
	openCompletionAttentionCount?: number;
	unresolvedDependencyCount?: number;
	latestEvent?: TaskEventRecord | null;
	latestAgentUpdateAt?: number | null;
	latestActiveAgentUpdateAt?: number | null;
	now?: number;
	staleAfterMs?: number;
}): TaskHealthSnapshot {
	const task = input.task;
	const now = input.now ?? Date.now();
	const staleAfterMs = input.staleAfterMs ?? TASK_HEALTH_DEFAULT_STALE_AFTER_MS;
	const activeAgentCount = input.activeAgentCount ?? 0;
	const linkedAgentCount = input.linkedAgentCount ?? 0;
	const openAttentionCount = input.openAttentionCount ?? 0;
	const openCompletionAttentionCount = input.openCompletionAttentionCount ?? 0;
	const unresolvedDependencyCount = input.unresolvedDependencyCount ?? 0;
	const latestEvent = input.latestEvent ?? null;
	const latestAgentUpdateAt = input.latestAgentUpdateAt ?? null;
	const latestActiveAgentUpdateAt = input.latestActiveAgentUpdateAt ?? null;
	const candidates: Array<{ at: number; summary: string }> = [];
	if (latestEvent?.createdAt) {
		candidates.push({ at: latestEvent.createdAt, summary: `${latestEvent.eventType}: ${latestEvent.summary}` });
	}
	if (latestActiveAgentUpdateAt) {
		candidates.push({ at: latestActiveAgentUpdateAt, summary: `${pluralize(activeAgentCount, "active linked agent")} updated` });
	}
	if (latestAgentUpdateAt && latestAgentUpdateAt !== latestActiveAgentUpdateAt) {
		candidates.push({ at: latestAgentUpdateAt, summary: "linked agent updated" });
	}
	if (task.reviewRequestedAt && task.reviewSummary) {
		candidates.push({ at: task.reviewRequestedAt, summary: `review requested: ${task.reviewSummary}` });
	}
	if (task.finishedAt && task.finalSummary) {
		candidates.push({ at: task.finishedAt, summary: `finished: ${task.finalSummary}` });
	}
	if (task.updatedAt) {
		candidates.push({ at: task.updatedAt, summary: "task metadata updated" });
	}
	if (task.createdAt) {
		candidates.push({ at: task.createdAt, summary: "task created" });
	}
	candidates.sort((left, right) => right.at - left.at);
	const lastUseful = candidates[0] ?? null;
	const blockedExternal = task.status === "blocked" && (task.waitingOn === "user" || task.waitingOn === "service" || task.waitingOn === "external");
	const needsReview = task.status === "in_review";
	const approvalRequired = needsReview || openCompletionAttentionCount > 0;
	const ownerActive = activeAgentCount > 0;
	const emptyOrNoProgress =
		task.status !== "done" &&
		!blockedExternal &&
		!needsReview &&
		((task.status === "in_progress" && !ownerActive && !latestEvent) || (!taskHasUsefulBody(task) && linkedAgentCount === 0 && !latestEvent));
	const stale = task.status !== "done" && Boolean(lastUseful?.at && now - lastUseful.at > staleAfterMs);
	const signals = normalizeHealthSignals([
		blockedExternal ? "blocked_external" : null,
		approvalRequired ? "approval_required" : null,
		needsReview ? "needs_review" : null,
		emptyOrNoProgress ? "empty_or_no_progress" : null,
		stale ? "stale" : null,
		ownerActive ? "owner_active" : null,
	].filter((value): value is TaskHealthSignal => Boolean(value)));
	const priorityOrder: TaskHealthState[] = ["blocked_external", "needs_review", "approval_required", "empty_or_no_progress", "stale", "owner_active", "healthy"];
	const state = priorityOrder.find((candidate) => signals.includes(candidate)) ?? "healthy";
	const reason = (() => {
		if (blockedExternal) return `Kanban status is blocked and waiting on ${task.waitingOn ?? "external input"}.`;
		if (needsReview) return "Kanban status is in_review, so acceptance/review synthesis is required.";
		if (approvalRequired) return "A completion or approval-style attention item is open.";
		if (emptyOrNoProgress) return "No active owner or useful progress signal has been recorded yet.";
		if (stale) return `Last useful update is older than ${healthDuration(staleAfterMs)}.`;
		if (ownerActive) return `${pluralize(activeAgentCount, "active owner")} linked to this task.`;
		return "No liveness concerns detected from task, attention, dependency, or linked-agent metadata.";
	})();
	const nextAction = (() => {
		if (openAttentionCount > 0 && task.waitingOn === "user") return "answer the user-facing attention item, then resume the owner or keep the task blocked";
		if (blockedExternal) return `follow up with ${task.waitingOn ?? "the external owner"}, or keep the blocker current with waitingOn/blocker details`;
		if (unresolvedDependencyCount > 0) return `wait for ${pluralize(unresolvedDependencyCount, "unresolved dependency", "unresolved dependencies")} before dispatching work`;
		if (needsReview) return "run or synthesize the review gate, then move done or back to in_progress";
		if (approvalRequired) return "resolve the completion/approval attention before cleanup or acceptance";
		if (emptyOrNoProgress) return "add acceptance criteria or assign an owner before expecting progress";
		if (stale) return ownerActive ? "ask/focus the active owner for a concise update, then let it continue or replan" : "refresh the task, assign an owner, or move it to the correct lane";
		if (ownerActive) return "let the active owner continue; inspect only if attention opens or updates go stale";
		if (task.status === "todo") return task.recommendedProfile ? `dispatch ${task.recommendedProfile} when dependencies are clear` : "refine scope or spawn the next specialist";
		if (task.status === "done") return "cleanup linked terminal agents and archive context if useful";
		if (task.status === "blocked") return "add waitingOn/blocker details or move back when unblocked";
		return "inspect task metadata and choose the next lane/action";
	})();
	return {
		state,
		signals,
		lastUsefulUpdateAt: lastUseful?.at ?? null,
		lastUsefulUpdateSummary: lastUseful?.summary ?? "no useful update recorded",
		nextAction,
		reason,
		staleAfterMs,
	};
}

export function listTaskHealth(
	db: DatabaseSync,
	tasks: TaskRecord[],
	options: { now?: number; staleAfterMs?: number } = {},
): Map<string, TaskHealthSnapshot> {
	const result = new Map<string, TaskHealthSnapshot>();
	const taskIds = [...new Set(tasks.map((task) => task.id))];
	if (taskIds.length === 0) return result;
	const metrics = new Map<string, TaskHealthMetrics>();
	for (const taskId of taskIds) metrics.set(taskId, createTaskHealthMetrics());
	const taskIdPlaceholders = makePlaceholders(taskIds.length);
	const activeStatePlaceholders = makePlaceholders(ACTIVE_AGENT_STATES.length);
	const agentRows = db
		.prepare(
			`SELECT
				tal.task_id,
				COUNT(DISTINCT tal.agent_id) AS linked_agent_count,
				SUM(CASE WHEN tal.is_active = 1 AND a.state IN (${activeStatePlaceholders}) THEN 1 ELSE 0 END) AS active_agent_count,
				MAX(a.updated_at) AS latest_agent_update_at,
				MAX(CASE WHEN tal.is_active = 1 AND a.state IN (${activeStatePlaceholders}) THEN a.updated_at ELSE NULL END) AS latest_active_agent_update_at
			 FROM task_agent_links tal
			 JOIN agents a ON a.id = tal.agent_id
			 WHERE tal.task_id IN (${taskIdPlaceholders})
			 GROUP BY tal.task_id`,
		)
		.all(...ACTIVE_AGENT_STATES, ...ACTIVE_AGENT_STATES, ...taskIds) as Array<Record<string, unknown>>;
	for (const row of agentRows) {
		const metric = metrics.get(row.task_id as string);
		if (!metric) continue;
		metric.linkedAgentCount = Number(row.linked_agent_count ?? 0);
		metric.activeAgentCount = Number(row.active_agent_count ?? 0);
		metric.latestAgentUpdateAt = row.latest_agent_update_at == null ? null : Number(row.latest_agent_update_at);
		metric.latestActiveAgentUpdateAt = row.latest_active_agent_update_at == null ? null : Number(row.latest_active_agent_update_at);
	}
	const attentionStatePlaceholders = makePlaceholders(OPEN_ATTENTION_STATES.length);
	const attentionRows = db
		.prepare(
			`SELECT
				tal.task_id,
				COUNT(DISTINCT ai.id) AS open_attention_count,
				COUNT(DISTINCT CASE WHEN ai.kind = 'complete' THEN ai.id ELSE NULL END) AS open_completion_attention_count
			 FROM task_agent_links tal
			 JOIN attention_items ai ON ai.agent_id = tal.agent_id
			 WHERE tal.task_id IN (${taskIdPlaceholders})
				AND ai.state IN (${attentionStatePlaceholders})
			 GROUP BY tal.task_id`,
		)
		.all(...taskIds, ...OPEN_ATTENTION_STATES) as Array<Record<string, unknown>>;
	for (const row of attentionRows) {
		const metric = metrics.get(row.task_id as string);
		if (!metric) continue;
		metric.openAttentionCount = Number(row.open_attention_count ?? 0);
		metric.openCompletionAttentionCount = Number(row.open_completion_attention_count ?? 0);
	}
	const v2AttentionStatePlaceholders = makePlaceholders(OPEN_AGENT_ATTENTION_V2_STATES.length);
	const v2AttentionRows = db
		.prepare(
			`SELECT
				task_id,
				COUNT(DISTINCT id) AS open_attention_count,
				COUNT(DISTINCT CASE WHEN kind IN ('complete', 'approval') THEN id ELSE NULL END) AS open_completion_attention_count
			 FROM (
				SELECT
					aiv2.task_id AS task_id,
					aiv2.id AS id,
					aiv2.kind AS kind
				 FROM agent_attention_items_v2 aiv2
				 WHERE aiv2.task_id IN (${taskIdPlaceholders})
					AND aiv2.state IN (${v2AttentionStatePlaceholders})
				UNION
				SELECT
					tal.task_id AS task_id,
					aiv2.id AS id,
					aiv2.kind AS kind
				 FROM task_agent_links tal
				 JOIN agent_attention_items_v2 aiv2 ON aiv2.subject_agent_id = tal.agent_id
				 WHERE tal.task_id IN (${taskIdPlaceholders})
					AND aiv2.state IN (${v2AttentionStatePlaceholders})
			 ) v2_attention
			 GROUP BY task_id`,
		)
		.all(...taskIds, ...OPEN_AGENT_ATTENTION_V2_STATES, ...taskIds, ...OPEN_AGENT_ATTENTION_V2_STATES) as Array<Record<string, unknown>>;
	for (const row of v2AttentionRows) {
		const metric = metrics.get(row.task_id as string);
		if (!metric) continue;
		metric.openAttentionCount += Number(row.open_attention_count ?? 0);
		metric.openCompletionAttentionCount += Number(row.open_completion_attention_count ?? 0);
	}
	const dependencyRows = db
		.prepare(
			`SELECT
				tl.source_task_id AS task_id,
				COUNT(*) AS unresolved_dependency_count
			 FROM task_links tl
			 JOIN tasks target ON target.id = tl.target_task_id
			 WHERE tl.source_task_id IN (${taskIdPlaceholders})
				AND tl.link_type = 'depends_on'
				AND tl.state = 'active'
				AND target.status != 'done'
			 GROUP BY tl.source_task_id`,
		)
		.all(...taskIds) as Array<Record<string, unknown>>;
	for (const row of dependencyRows) {
		const metric = metrics.get(row.task_id as string);
		if (!metric) continue;
		metric.unresolvedDependencyCount = Number(row.unresolved_dependency_count ?? 0);
	}
	const latestEventRows = db
		.prepare(
			`SELECT te.*
			 FROM task_events te
			 WHERE te.task_id IN (${taskIdPlaceholders})
				AND te.id = (
					SELECT latest.id
					FROM task_events latest
					WHERE latest.task_id = te.task_id
					ORDER BY latest.created_at DESC, latest.id DESC
					LIMIT 1
				)
			 ORDER BY te.created_at DESC`,
		)
		.all(...taskIds) as Array<Record<string, unknown>>;
	for (const row of latestEventRows) {
		const metric = metrics.get(row.task_id as string);
		if (!metric) continue;
		metric.latestEvent = toTaskEventRecord(row);
	}
	for (const task of tasks) {
		const metric = metrics.get(task.id) ?? createTaskHealthMetrics();
		result.set(
			task.id,
			deriveTaskHealth({
				task,
				activeAgentCount: metric.activeAgentCount,
				linkedAgentCount: metric.linkedAgentCount,
				openAttentionCount: metric.openAttentionCount,
				openCompletionAttentionCount: metric.openCompletionAttentionCount,
				unresolvedDependencyCount: metric.unresolvedDependencyCount,
				latestEvent: metric.latestEvent,
				latestAgentUpdateAt: metric.latestAgentUpdateAt,
				latestActiveAgentUpdateAt: metric.latestActiveAgentUpdateAt,
				now: options.now,
				staleAfterMs: options.staleAfterMs,
			}),
		);
	}
	return result;
}

function buildDependencyBlockedReason(links: TaskLinkWithTasksRecord[]): string {
	const targets = links.map((link) => `${link.targetTaskId} (${link.targetStatus})`).join(", ");
	return `[dependency] Waiting on ${targets}`;
}

function dependencyPathExists(db: DatabaseSync, startTaskId: string, targetTaskId: string): boolean {
	const row = db
		.prepare(
			`WITH RECURSIVE dependency_path(task_id, path) AS (
				SELECT target_task_id, '|' || source_task_id || '|' || target_task_id || '|'
				FROM task_links
				WHERE source_task_id = ?
					AND link_type = 'depends_on'
					AND state = 'active'
				UNION ALL
				SELECT tl.target_task_id, dependency_path.path || tl.target_task_id || '|'
				FROM task_links tl
				JOIN dependency_path ON dependency_path.task_id = tl.source_task_id
				WHERE tl.link_type = 'depends_on'
					AND tl.state = 'active'
					AND instr(dependency_path.path, '|' || tl.target_task_id || '|') = 0
			)
			SELECT 1 AS found
			FROM dependency_path
			WHERE task_id = ?
			LIMIT 1`,
		)
		.get(startTaskId, targetTaskId) as { found?: number } | undefined;
	return Boolean(row?.found);
}

export function listTaskLinks(db: DatabaseSync, filters: ListTaskLinksFilters = {}): TaskLinkWithTasksRecord[] {
	if (
		(filters.ids && filters.ids.length === 0) ||
		(filters.sourceTaskIds && filters.sourceTaskIds.length === 0) ||
		(filters.targetTaskIds && filters.targetTaskIds.length === 0) ||
		(filters.taskIds && filters.taskIds.length === 0)
	) {
		return [];
	}
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.ids && filters.ids.length > 0) {
		where.push(`tl.id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.sourceTaskIds && filters.sourceTaskIds.length > 0) {
		where.push(`tl.source_task_id IN (${makePlaceholders(filters.sourceTaskIds.length)})`);
		params.push(...filters.sourceTaskIds);
	}
	if (filters.targetTaskIds && filters.targetTaskIds.length > 0) {
		where.push(`tl.target_task_id IN (${makePlaceholders(filters.targetTaskIds.length)})`);
		params.push(...filters.targetTaskIds);
	}
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`(tl.source_task_id IN (${makePlaceholders(filters.taskIds.length)}) OR tl.target_task_id IN (${makePlaceholders(filters.taskIds.length)}))`);
		params.push(...filters.taskIds, ...filters.taskIds);
	}
	if (filters.projectKey) {
		where.push("(source.project_key = ? OR target.project_key = ?)");
		params.push(filters.projectKey, filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "source");
	if (filters.linkTypes && filters.linkTypes.length > 0) {
		where.push(`tl.link_type IN (${makePlaceholders(filters.linkTypes.length)})`);
		params.push(...filters.linkTypes);
	}
	if (filters.states && filters.states.length > 0) {
		where.push(`tl.state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	} else if (!filters.includeResolved) {
		where.push("tl.state = 'active'");
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				tl.*,
				source.title AS source_title,
				source.status AS source_status,
				target.title AS target_title,
				target.status AS target_status
			 FROM task_links tl
			 JOIN tasks source ON source.id = tl.source_task_id
			 JOIN tasks target ON target.id = tl.target_task_id
			 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY tl.updated_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toTaskLinkRecord);
}

export function listUnresolvedTaskDependencies(db: DatabaseSync, taskIds: string[]): Map<string, TaskLinkWithTasksRecord[]> {
	const result = new Map<string, TaskLinkWithTasksRecord[]>();
	if (taskIds.length === 0) return result;
	const links = listTaskLinks(db, {
		sourceTaskIds: taskIds,
		linkTypes: ["depends_on"],
		states: ["active"],
		limit: Math.max(1, Math.min(taskIds.length * 50, 1000)),
	}).filter((link) => link.unresolved);
	for (const link of links) {
		const existing = result.get(link.sourceTaskId) ?? [];
		existing.push(link);
		result.set(link.sourceTaskId, existing);
	}
	return result;
}

export function refreshTaskDependencyBlockState(db: DatabaseSync, taskId: string, now = Date.now()): TaskRecord | null {
	const task = getTask(db, taskId);
	if (!task) return null;
	const unresolved = listTaskLinks(db, { sourceTaskIds: [taskId], linkTypes: ["depends_on"], states: ["active"], limit: 200 }).filter((link) => link.unresolved);
	if (unresolved.length > 0) {
		if (task.status !== "done" && task.status !== "in_review") {
			const blockedReason = buildDependencyBlockedReason(unresolved);
			updateTask(db, taskId, {
				status: "blocked",
				waitingOn: "coordinator",
				blockedReason,
				updatedAt: now,
			});
			return getTask(db, taskId);
		}
		return task;
	}
	if (task.status === "blocked" && task.blockedReason?.startsWith("[dependency]")) {
		updateTask(db, taskId, {
			status: "todo",
			waitingOn: null,
			blockedReason: null,
			updatedAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "dependencies_unblocked",
			summary: "All task dependencies are resolved; task is ready to dispatch.",
			payload: {},
			createdAt: now,
		});
		return getTask(db, taskId);
	}
	return task;
}

export function createTaskLink(db: DatabaseSync, input: CreateTaskLinkInput): TaskLinkWithTasksRecord {
	const source = getTask(db, input.sourceTaskId);
	if (!source) throw new Error(`Unknown source task id "${input.sourceTaskId}".`);
	const target = getTask(db, input.targetTaskId);
	if (!target) throw new Error(`Unknown target task id "${input.targetTaskId}".`);
	if (source.id === target.id) throw new Error("A task cannot depend on itself.");
	const linkType = input.linkType ?? "depends_on";
	if (linkType === "depends_on" && dependencyPathExists(db, target.id, source.id)) {
		throw new Error(`Cannot create dependency ${source.id} depends_on ${target.id}: it would create a cycle.`);
	}
	const now = input.createdAt ?? Date.now();
	const initialState = input.state ?? (linkType === "depends_on" && target.status === "done" ? "resolved" : "active");
	const resolvedAt = initialState === "resolved" ? input.resolvedAt ?? now : input.resolvedAt ?? null;
	const id = input.id ?? randomUUID();
	db.prepare(
		`INSERT INTO task_links (id, source_task_id, target_task_id, link_type, state, summary, metadata_json, created_at, updated_at, resolved_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		source.id,
		target.id,
		linkType,
		initialState,
		input.summary?.trim() || null,
		input.metadata === undefined ? null : JSON.stringify(input.metadata),
		now,
		input.updatedAt ?? now,
		resolvedAt,
	);
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: source.id,
		eventType: "task_link_created",
		summary: linkType === "depends_on" ? `Depends on ${target.id}` : `Linked to ${target.id} as ${linkType}`,
		payload: { linkId: id, sourceTaskId: source.id, targetTaskId: target.id, linkType, state: initialState, summary: input.summary ?? null },
		createdAt: now,
	});
	createTaskEvent(db, {
		id: randomUUID(),
		taskId: target.id,
		eventType: "task_dependent_added",
		summary: linkType === "depends_on" ? `${source.id} depends on this task` : `${source.id} linked as ${linkType}`,
		payload: { linkId: id, sourceTaskId: source.id, targetTaskId: target.id, linkType, state: initialState, summary: input.summary ?? null },
		createdAt: now,
	});
	if (linkType === "depends_on" && (input.blockSource ?? true)) {
		refreshTaskDependencyBlockState(db, source.id, now);
	}
	return listTaskLinks(db, { ids: [id], includeResolved: true, limit: 1 })[0]!;
}

export function cancelTaskLink(db: DatabaseSync, options: { id?: string; sourceTaskId?: string; targetTaskId?: string; linkType?: TaskLinkType; reason?: string }): TaskLinkWithTasksRecord[] {
	if (!options.id && (!options.sourceTaskId || !options.targetTaskId)) {
		throw new Error("Provide either a task link id or both sourceTaskId and targetTaskId.");
	}
	const links = options.id
		? listTaskLinks(db, { ids: [options.id], includeResolved: true, limit: 1 })
		: listTaskLinks(db, {
				sourceTaskIds: [options.sourceTaskId!],
				targetTaskIds: [options.targetTaskId!],
				linkTypes: [options.linkType ?? "depends_on"],
				states: ["active"],
				limit: 10,
			});
	const now = Date.now();
	const cancelled: TaskLinkWithTasksRecord[] = [];
	for (const link of links) {
		if (link.state === "cancelled") continue;
		db.prepare("UPDATE task_links SET state = 'cancelled', updated_at = ?, resolved_at = COALESCE(resolved_at, ?) WHERE id = ?").run(now, now, link.id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: link.sourceTaskId,
			eventType: "task_link_cancelled",
			summary: `Cancelled ${link.linkType} link to ${link.targetTaskId}`,
			payload: { linkId: link.id, targetTaskId: link.targetTaskId, linkType: link.linkType, reason: options.reason?.trim() || null },
			createdAt: now,
		});
		if (link.linkType === "depends_on") refreshTaskDependencyBlockState(db, link.sourceTaskId, now);
		const updated = listTaskLinks(db, { ids: [link.id], includeResolved: true, limit: 1 })[0];
		if (updated) cancelled.push(updated);
	}
	return cancelled;
}

export function resolveDependenciesForCompletedTask(db: DatabaseSync, targetTaskId: string, now = Date.now()): TaskReadinessRecord[] {
	const links = listTaskLinks(db, { targetTaskIds: [targetTaskId], linkTypes: ["depends_on"], states: ["active"], limit: 500 });
	const sourceIds = [...new Set(links.map((link) => link.sourceTaskId))];
	for (const link of links) {
		db.prepare("UPDATE task_links SET state = 'resolved', updated_at = ?, resolved_at = ? WHERE id = ?").run(now, now, link.id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: link.sourceTaskId,
			eventType: "dependency_resolved",
			summary: `Dependency ${targetTaskId} resolved`,
			payload: { linkId: link.id, targetTaskId, targetStatus: "done" },
			createdAt: now,
		});
	}
	for (const sourceId of sourceIds) refreshTaskDependencyBlockState(db, sourceId, now);
	return listTaskReadiness(db, { ids: sourceIds, includeDone: false, limit: sourceIds.length || 1 }).filter((item) => item.ready);
}

export function listTaskReadiness(db: DatabaseSync, filters: ListTasksFilters = {}): TaskReadinessRecord[] {
	const tasks = listTasks(db, { ...filters, includeDone: filters.includeDone ?? false, limit: filters.limit ?? 100 });
	if (tasks.length === 0) return [];
	const taskIds = tasks.map((task) => task.id);
	const links = listTaskLinks(db, { taskIds, includeResolved: true, limit: Math.max(1, Math.min(taskIds.length * 50, 1000)) });
	const agents = db
		.prepare(
			`SELECT tal.task_id, COUNT(*) AS active_count
			 FROM task_agent_links tal
			 JOIN agents a ON a.id = tal.agent_id
			 WHERE tal.task_id IN (${makePlaceholders(taskIds.length)})
				AND tal.is_active = 1
				AND a.state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
			 GROUP BY tal.task_id`,
		)
		.all(...taskIds, ...ACTIVE_AGENT_STATES) as Array<{ task_id: string; active_count: number }>;
	const activeCounts = new Map(agents.map((row) => [row.task_id, Number(row.active_count ?? 0)]));
	return tasks.map((task) => {
		const dependencies = links.filter((link) => link.sourceTaskId === task.id && link.linkType === "depends_on" && link.state !== "cancelled");
		const unresolvedDependencies = dependencies.filter((link) => link.unresolved);
		const resolvedDependencies = dependencies.filter((link) => !link.unresolved);
		const dependents = links.filter((link) => link.targetTaskId === task.id && link.linkType === "depends_on" && link.state !== "cancelled");
		const activeAgentCount = activeCounts.get(task.id) ?? 0;
		const ready = task.status === "todo" && activeAgentCount === 0 && unresolvedDependencies.length === 0;
		const reason =
			unresolvedDependencies.length > 0
				? `blocked by ${unresolvedDependencies.map((link) => link.targetTaskId).join(", ")}`
				: activeAgentCount > 0
					? "already has active agent"
					: task.status !== "todo"
						? `status=${task.status}`
						: "ready";
		return { task, activeAgentCount, unresolvedDependencies, resolvedDependencies, dependents, ready, reason };
	});
}

export function listTaskLeaseOwners(
	db: DatabaseSync,
	filters: Pick<ListTaskAgentLinksFilters, "taskIds" | "agentIds" | "limit"> & { activeOnly?: boolean } = {},
): TaskLeaseOwnerRecord[] {
	if ((filters.taskIds && filters.taskIds.length === 0) || (filters.agentIds && filters.agentIds.length === 0)) return [];
	const where: string[] = ["tal.is_active = 1"];
	const params: unknown[] = [];
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`tal.task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
	}
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`tal.agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.activeOnly ?? true) {
		where.push(`a.state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})`);
		params.push(...ACTIVE_AGENT_STATES);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				tal.task_id,
				tal.agent_id,
				tal.role,
				tal.linked_at,
				tal.summary,
				a.profile,
				a.state,
				a.title
			 FROM task_agent_links tal
			 JOIN agents a ON a.id = tal.agent_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY tal.linked_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toTaskLeaseOwnerRecord);
}

export function getTaskLease(db: DatabaseSync, taskId: string): TaskLeaseStateRecord {
	const activeOwners = listTaskLeaseOwners(db, { taskIds: [taskId], activeOnly: true, limit: 500 });
	return {
		taskId,
		activeOwners,
		exclusiveOwners: activeOwners.filter((owner) => owner.leaseKind === "exclusive"),
		reviewOwners: activeOwners.filter((owner) => owner.leaseKind === "review"),
	};
}

export function getTaskLeaseConflict(
	db: DatabaseSync,
	options: { taskId: string; profile: string | null | undefined; requesterAgentId?: string | null },
): TaskLeaseConflictRecord | null {
	const requestedProfile = options.profile?.trim() || "contributor";
	const requestedLeaseKind = taskLeaseKindForProfile(requestedProfile);
	if (requestedLeaseKind === "review") return null;
	const lease = getTaskLease(db, options.taskId);
	const conflictingOwners = lease.exclusiveOwners.filter((owner) => owner.agentId !== options.requesterAgentId);
	if (conflictingOwners.length === 0) return null;
	return {
		taskId: options.taskId,
		requestedProfile,
		requestedLeaseKind,
		conflictingOwners,
	};
}

export function formatTaskLeaseConflict(conflict: TaskLeaseConflictRecord): string {
	const owners = conflict.conflictingOwners
		.map((owner) => `${owner.agentId} (${owner.profile}, ${owner.state})`)
		.join(", ");
	return `Task ${conflict.taskId} already has active exclusive owner${conflict.conflictingOwners.length === 1 ? "" : "s"}: ${owners}. Spawning or linking another exclusive profile (${conflict.requestedProfile}) may duplicate long-running work. Use a reviewer profile for intentional review siblings, or pass allowDuplicateOwner=true only when a second implementer is intentional.`;
}

export function assertTaskLeaseAvailable(
	db: DatabaseSync,
	options: { taskId: string; profile: string | null | undefined; requesterAgentId?: string | null; allowDuplicateOwner?: boolean },
): TaskLeaseConflictRecord | null {
	const conflict = getTaskLeaseConflict(db, options);
	if (conflict && !options.allowDuplicateOwner) {
		throw new Error(formatTaskLeaseConflict(conflict));
	}
	return conflict;
}

export function listTaskAgentLinks(db: DatabaseSync, filters: ListTaskAgentLinksFilters = {}): TaskAgentLinkRecord[] {
	if ((filters.taskIds && filters.taskIds.length === 0) || (filters.agentIds && filters.agentIds.length === 0)) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
	}
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.activeOnly) {
		where.push("is_active = 1");
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT *
			 FROM task_agent_links
			 ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
			 ORDER BY linked_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toTaskAgentLinkRecord);
}

function deactivateActiveLinksForAgent(db: DatabaseSync, agentId: string, exceptTaskId: string | null, reason: string, now: number): string[] {
	const rows = db
		.prepare(
			`SELECT id, task_id
			 FROM task_agent_links
			 WHERE agent_id = ?
			 	AND is_active = 1
			 	AND (? IS NULL OR task_id != ?)`,
		)
		.all(agentId, exceptTaskId, exceptTaskId) as Array<{ id: string; task_id: string }>;
	for (const row of rows) {
		db.prepare("UPDATE task_agent_links SET is_active = 0, unlinked_at = ? WHERE id = ?").run(now, row.id);
		updateTask(db, row.task_id, { updatedAt: now });
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: row.task_id,
			agentId,
			eventType: "agent_unlinked",
			summary: `Unlinked ${agentId}`,
			payload: { reason },
			createdAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: row.task_id,
			agentId,
			eventType: "task_lease_released",
			summary: `Released task lease for ${agentId}`,
			payload: { reason },
			createdAt: now,
		});
	}
	return rows.map((row) => row.task_id);
}

function runImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = callback();
		db.exec("COMMIT;");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Preserve the original error.
		}
		throw error;
	}
}

export function linkTaskAgent(db: DatabaseSync, input: LinkTaskAgentInput): TaskAgentLinkRecord {
	return runImmediateTransaction(db, () => {
		const now = input.linkedAt ?? Date.now();
		const task = getTask(db, input.taskId);
		if (!task) throw new Error(`Unknown task id \"${input.taskId}\".`);
		const agentRow = db.prepare("SELECT profile FROM agents WHERE id = ?").get(input.agentId) as { profile?: string } | undefined;
		if (!agentRow) throw new Error(`Unknown agent id \"${input.agentId}\".`);
		const requestedRole = input.role?.trim() || agentRow.profile || "contributor";
		const leaseConflict = (input.isActive ?? true)
			? assertTaskLeaseAvailable(db, {
					taskId: input.taskId,
					profile: requestedRole,
					requesterAgentId: input.agentId,
					allowDuplicateOwner: input.allowDuplicateOwner,
				})
			: null;
		deactivateActiveLinksForAgent(db, input.agentId, input.taskId, "linked_to_new_task", now);
		const existing = db
			.prepare("SELECT * FROM task_agent_links WHERE task_id = ? AND agent_id = ? AND is_active = 1 LIMIT 1")
			.get(input.taskId, input.agentId) as Record<string, unknown> | undefined;
		if (existing) {
			const role = input.role?.trim() || (existing.role as string | null) || agentRow.profile || "contributor";
			const summary = input.summary?.trim() || (existing.summary as string | null) || null;
			db.prepare("UPDATE task_agent_links SET role = ?, summary = ? WHERE id = ?").run(role, summary, existing.id);
			updateTask(db, input.taskId, { updatedAt: now });
			db.prepare("UPDATE agents SET task_id = ? WHERE id = ?").run(input.taskId, input.agentId);
			createTaskEvent(db, {
				id: randomUUID(),
				taskId: input.taskId,
				agentId: input.agentId,
				eventType: "task_lease_refreshed",
				summary: `Refreshed ${taskLeaseKindForProfile(role)} task lease for ${input.agentId}`,
				payload: {
					role,
					summary,
					leaseKind: taskLeaseKindForProfile(role),
					override: Boolean(leaseConflict),
					conflictingOwners: leaseConflict?.conflictingOwners.map((owner) => owner.agentId) ?? [],
				},
				createdAt: now,
			});
			return toTaskAgentLinkRecord({ ...existing, role, summary });
		}
		const record: TaskAgentLinkRecord = {
			id: input.id ?? randomUUID(),
			taskId: input.taskId,
			agentId: input.agentId,
			role: requestedRole,
			isActive: input.isActive ?? true,
			linkedAt: now,
			unlinkedAt: null,
			summary: input.summary?.trim() || null,
		};
		db.prepare(
			`INSERT INTO task_agent_links (id, task_id, agent_id, role, is_active, linked_at, unlinked_at, summary)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(record.id, record.taskId, record.agentId, record.role, record.isActive ? 1 : 0, record.linkedAt, record.unlinkedAt, record.summary);
		db.prepare("UPDATE agents SET task_id = ? WHERE id = ?").run(record.taskId, record.agentId);
		updateTask(db, record.taskId, { updatedAt: now });
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: record.taskId,
			agentId: record.agentId,
			eventType: "agent_linked",
			summary: `Linked ${record.agentId} as ${record.role}`,
			payload: { role: record.role, summary: record.summary },
			createdAt: now,
		});
		if (record.isActive) {
			createTaskEvent(db, {
				id: randomUUID(),
				taskId: record.taskId,
				agentId: record.agentId,
				eventType: "task_lease_claimed",
				summary: `Claimed ${taskLeaseKindForProfile(record.role)} task lease for ${record.agentId}`,
				payload: {
					role: record.role,
					leaseKind: taskLeaseKindForProfile(record.role),
					override: Boolean(leaseConflict),
					conflictingOwners: leaseConflict?.conflictingOwners.map((owner) => owner.agentId) ?? [],
				},
				createdAt: now,
			});
		}
		return record;
	});
}

export function unlinkTaskAgent(db: DatabaseSync, taskId: string, agentId: string, reason?: string): number {
	const now = Date.now();
	const result = db
		.prepare(
			`UPDATE task_agent_links
			 SET is_active = 0,
			 	unlinked_at = ?
			 WHERE task_id = ?
			 	AND agent_id = ?
			 	AND is_active = 1`,
		)
		.run(now, taskId, agentId) as { changes?: number };
	const changes = Number(result.changes ?? 0);
	if (changes > 0) {
		db.prepare("UPDATE agents SET task_id = NULL WHERE id = ? AND task_id = ?").run(agentId, taskId);
		updateTask(db, taskId, { updatedAt: now });
		const releaseReason = reason?.trim() || null;
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			agentId,
			eventType: "agent_unlinked",
			summary: `Unlinked ${agentId}`,
			payload: { reason: releaseReason },
			createdAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			agentId,
			eventType: "task_lease_released",
			summary: `Released task lease for ${agentId}`,
			payload: { reason: releaseReason },
			createdAt: now,
		});
	}
	return changes;
}

export function getTaskSummary(
	db: DatabaseSync,
	filters: Pick<ListTasksFilters, "projectKey" | "spawnSessionId" | "spawnSessionFile"> = {},
): TaskSummaryCounts {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.projectKey) {
		where.push("t.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const row = db
		.prepare(
			`SELECT
				SUM(CASE WHEN t.status = 'todo' THEN 1 ELSE 0 END) AS todo,
				SUM(CASE WHEN t.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
				SUM(CASE WHEN t.status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
				SUM(CASE WHEN t.status = 'in_review' THEN 1 ELSE 0 END) AS in_review,
				SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS done,
				SUM(CASE WHEN t.status = 'blocked' AND t.waiting_on = 'user' THEN 1 ELSE 0 END) AS waiting_on_user
			FROM tasks t
			${whereClause}`,
		)
		.get(...params) as
		| {
				todo?: number | null;
				blocked?: number | null;
				in_progress?: number | null;
				in_review?: number | null;
				done?: number | null;
				waiting_on_user?: number | null;
		  }
		| undefined;
	return {
		todo: Number(row?.todo ?? 0),
		blocked: Number(row?.blocked ?? 0),
		inProgress: Number(row?.in_progress ?? 0),
		inReview: Number(row?.in_review ?? 0),
		done: Number(row?.done ?? 0),
		waitingOnUser: Number(row?.waiting_on_user ?? 0),
	};
}

export function listTaskAttention(
	db: DatabaseSync,
	filters: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number },
): TaskAttentionRecord[] {
	if (filters.ids && filters.ids.length === 0) return [];
	const where: string[] = ["(t.status IN ('blocked', 'in_review') OR (t.status = 'todo' AND EXISTS (SELECT 1 FROM task_links rtl WHERE rtl.source_task_id = t.id AND rtl.link_type = 'depends_on' AND rtl.state = 'resolved')))"];
	const params: unknown[] = [];
	if (filters.ids && filters.ids.length > 0) {
		where.push(`t.id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.projectKey) {
		where.push("t.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	const v2AttentionStatePlaceholders = makePlaceholders(OPEN_AGENT_ATTENTION_V2_STATES.length);
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				t.id,
				t.title,
				t.status,
				t.waiting_on,
				t.summary,
				t.blocked_reason,
				t.review_summary,
				t.updated_at,
				COALESCE((
					SELECT COUNT(*)
					FROM task_agent_links tal
					JOIN agents a ON a.id = tal.agent_id
					WHERE tal.task_id = t.id
						AND tal.is_active = 1
						AND a.state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
				), 0) AS active_agent_count,
				(
					COALESCE((
						SELECT COUNT(DISTINCT ai.id)
						FROM task_agent_links tal
						JOIN attention_items ai ON ai.agent_id = tal.agent_id
						WHERE tal.task_id = t.id
							AND ai.state IN (${makePlaceholders(OPEN_ATTENTION_STATES.length)})
					), 0)
					+
					COALESCE((
						SELECT COUNT(DISTINCT aiv2.id)
						FROM agent_attention_items_v2 aiv2
						WHERE aiv2.state IN (${v2AttentionStatePlaceholders})
							AND (
								aiv2.task_id = t.id
								OR EXISTS (
									SELECT 1
									FROM task_agent_links v2_tal
									WHERE v2_tal.task_id = t.id
										AND v2_tal.agent_id = aiv2.subject_agent_id
								)
							)
					), 0)
				) AS open_attention_count,
				COALESCE((
					SELECT COUNT(*)
					FROM task_links tl
					JOIN tasks target ON target.id = tl.target_task_id
					WHERE tl.source_task_id = t.id
						AND tl.link_type = 'depends_on'
						AND tl.state = 'active'
						AND target.status != 'done'
				), 0) AS unresolved_dependency_count,
				CASE WHEN t.status = 'todo'
					AND EXISTS (
						SELECT 1 FROM task_links rtl
						WHERE rtl.source_task_id = t.id
							AND rtl.link_type = 'depends_on'
							AND rtl.state = 'resolved'
					)
					AND NOT EXISTS (
						SELECT 1 FROM task_links utl
						JOIN tasks target ON target.id = utl.target_task_id
						WHERE utl.source_task_id = t.id
							AND utl.link_type = 'depends_on'
							AND utl.state = 'active'
							AND target.status != 'done'
					)
				THEN 1 ELSE 0 END AS ready_unblocked
			FROM tasks t
			WHERE ${where.join(" AND ")}
			ORDER BY
				CASE WHEN t.status = 'blocked' AND t.waiting_on = 'user' THEN 0
					WHEN t.status = 'blocked' THEN 1
					WHEN t.status = 'in_review' THEN 2
					WHEN ready_unblocked = 1 THEN 3
					ELSE 4 END,
				t.priority ASC,
				t.updated_at DESC
			LIMIT ?`,
		)
		.all(...ACTIVE_AGENT_STATES, ...OPEN_ATTENTION_STATES, ...OPEN_AGENT_ATTENTION_V2_STATES, ...params) as Array<Record<string, unknown>>;
	const items = rows.map((row) => ({
		taskId: row.id as string,
		title: row.title as string,
		status: row.status as TaskState,
		waitingOn: (row.waiting_on as TaskWaitingOn | null) ?? null,
		summary: (row.summary as string | null) ?? (row.blocked_reason as string | null) ?? (row.review_summary as string | null) ?? "-",
		blockedReason: (row.blocked_reason as string | null) ?? null,
		reviewSummary: (row.review_summary as string | null) ?? null,
		updatedAt: Number(row.updated_at ?? 0),
		activeAgentCount: Number(row.active_agent_count ?? 0),
		openAttentionCount: Number(row.open_attention_count ?? 0),
		unresolvedDependencyCount: Number(row.unresolved_dependency_count ?? 0),
		readyUnblocked: Number(row.ready_unblocked ?? 0) === 1,
	}));
	const tasks = items.length > 0 ? listTasks(db, { ids: items.map((item) => item.taskId), includeDone: true, limit: items.length }) : [];
	const healthByTask = listTaskHealth(db, tasks);
	return items.map((item) => {
		const task = tasks.find((candidate) => candidate.id === item.taskId);
		const health = healthByTask.get(item.taskId) ?? (task ? deriveTaskHealth({ task }) : null);
		return {
			...item,
			health: (health?.state ?? "healthy") as TaskHealthState,
			healthSignals: (health?.signals ?? ["healthy"]) as TaskHealthSignal[],
			lastUsefulUpdateAt: health?.lastUsefulUpdateAt ?? item.updatedAt,
			nextAction: health?.nextAction ?? "inspect task",
		};
	});
}

export function applyChildPublishToLinkedTask(
	db: DatabaseSync,
	options: {
		agentId: string;
		profile: string;
		kind: "milestone" | "blocked" | "question" | "question_for_user" | "note" | "complete";
		summary: string;
		details?: string;
		files?: string[];
		taskStatus?: TaskState;
		waitingOn?: TaskWaitingOn;
		blockedReason?: string;
		taskSummary?: string;
		acceptanceCriteria?: string[];
		planSteps?: string[];
		validationSteps?: string[];
		reviewSummary?: string;
		finalSummary?: string;
	},
): TaskRecord | null {
	const row = db.prepare("SELECT task_id FROM agents WHERE id = ?").get(options.agentId) as { task_id?: string | null } | undefined;
	const taskId = row?.task_id ?? null;
	if (!taskId) return null;
	const current = getTask(db, taskId);
	if (!current) return null;
	const now = Date.now();
	const derivedStatus = options.taskStatus ?? deriveDefaultTaskStatus(options.profile, options.kind) ?? current.status;
	const waitingOn =
		options.waitingOn ??
		(options.kind === "question_for_user"
			? "user"
			: options.kind === "question"
				? "coordinator"
				: current.waitingOn);
	const blockedReason =
		options.blockedReason ??
		(options.kind === "blocked" || options.kind === "question" || options.kind === "question_for_user" ? options.summary : current.blockedReason);
	const patch: UpdateTaskInput = {
		status: derivedStatus,
		updatedAt: now,
		waitingOn: derivedStatus === "blocked" ? waitingOn ?? null : null,
		blockedReason: derivedStatus === "blocked" ? blockedReason ?? null : null,
		files: mergeStringArrays(current.files, options.files),
		acceptanceCriteria: options.acceptanceCriteria ? normalizeStringArray(options.acceptanceCriteria) : current.acceptanceCriteria,
		planSteps: options.planSteps ? normalizeStringArray(options.planSteps) : current.planSteps,
		validationSteps: options.validationSteps ? normalizeStringArray(options.validationSteps) : current.validationSteps,
	};
	if (options.taskSummary !== undefined) patch.summary = options.taskSummary?.trim() || null;
	else if (!current.summary && options.summary) patch.summary = options.summary;
	if (derivedStatus === "in_progress") {
		patch.startedAt = nowOr(current.startedAt, now);
	}
	if (derivedStatus === "in_review") {
		patch.reviewRequestedAt = nowOr(current.reviewRequestedAt, now);
		patch.reviewSummary = options.reviewSummary?.trim() || options.summary;
		patch.finishedAt = null;
	}
	if (derivedStatus === "done") {
		patch.finalSummary = options.finalSummary?.trim() || options.summary;
		patch.finishedAt = nowOr(current.finishedAt, now);
	}
	if (derivedStatus === "todo") {
		patch.reviewRequestedAt = null;
	}
	if (options.reviewSummary !== undefined && derivedStatus !== "in_review") {
		patch.reviewSummary = options.reviewSummary?.trim() || null;
	}
	if (options.finalSummary !== undefined && derivedStatus !== "done") {
		patch.finalSummary = options.finalSummary?.trim() || null;
	}
	updateTask(db, taskId, patch);
	createTaskEvent(db, {
		id: randomUUID(),
		taskId,
		agentId: options.agentId,
		eventType: `child_publish_${options.kind}`,
		summary: options.summary,
		payload: {
			kind: options.kind,
			status: patch.status,
			waitingOn: patch.waitingOn,
			blockedReason: patch.blockedReason,
			files: options.files ?? [],
			details: options.details ?? null,
		},
		createdAt: now,
	});
	return getTask(db, taskId);
}

function backfillStatusFromLegacy(row: {
	state: AgentState;
	profile: string;
	attention_kind: AttentionItemKind | null;
	attention_summary: string | null;
	last_error: string | null;
	final_summary: string | null;
}): { status: TaskState; waitingOn: TaskWaitingOn | null; blockedReason: string | null; reviewSummary: string | null; finalSummary: string | null } {
	if (row.attention_kind === "question_for_user") {
		return {
			status: "blocked",
			waitingOn: "user",
			blockedReason: row.attention_summary ?? row.last_error,
			reviewSummary: null,
			finalSummary: null,
		};
	}
	if (row.attention_kind === "question") {
		return {
			status: "blocked",
			waitingOn: "coordinator",
			blockedReason: row.attention_summary ?? row.last_error,
			reviewSummary: null,
			finalSummary: null,
		};
	}
	if (row.attention_kind === "blocked" || row.state === "blocked" || row.state === "waiting") {
		return {
			status: "blocked",
			waitingOn: row.state === "waiting" ? "coordinator" : null,
			blockedReason: row.attention_summary ?? row.last_error,
			reviewSummary: null,
			finalSummary: null,
		};
	}
	if (row.attention_kind === "complete") {
		return {
			status: "in_review",
			waitingOn: null,
			blockedReason: null,
			reviewSummary: row.attention_summary ?? row.final_summary,
			finalSummary: null,
		};
	}
	if (["launching", "running", "idle"].includes(row.state)) {
		return {
			status: "in_progress",
			waitingOn: null,
			blockedReason: null,
			reviewSummary: null,
			finalSummary: null,
		};
	}
	if (row.profile === "reviewer" && row.state === "done") {
		return {
			status: "done",
			waitingOn: null,
			blockedReason: null,
			reviewSummary: null,
			finalSummary: row.final_summary,
		};
	}
	if (["done", "error", "stopped", "lost"].includes(row.state)) {
		return {
			status: row.final_summary ? "in_review" : "done",
			waitingOn: null,
			blockedReason: null,
			reviewSummary: row.final_summary,
			finalSummary: row.final_summary ? null : row.final_summary,
		};
	}
	return {
		status: "todo",
		waitingOn: null,
		blockedReason: null,
		reviewSummary: null,
		finalSummary: null,
	};
}

export function backfillLegacyTasksFromAgents(db: DatabaseSync, limit = 500): Array<{ taskId: string; agentId: string; status: TaskState }> {
	const rows = db
		.prepare(
			`SELECT
				a.id,
				a.spawn_session_id,
				a.spawn_session_file,
				a.spawn_cwd,
				a.project_key,
				a.profile,
				a.title,
				a.task,
				a.state,
				a.last_assistant_preview,
				a.last_error,
				a.final_summary,
				a.created_at,
				a.updated_at,
				a.finished_at,
				(
					SELECT ai.kind
					FROM attention_items ai
					WHERE ai.agent_id = a.id
						AND ai.state IN ('open', 'acknowledged', 'waiting_on_coordinator', 'waiting_on_user')
					ORDER BY ai.priority ASC, ai.updated_at DESC
					LIMIT 1
				) AS attention_kind,
				(
					SELECT ai.summary
					FROM attention_items ai
					WHERE ai.agent_id = a.id
						AND ai.state IN ('open', 'acknowledged', 'waiting_on_coordinator', 'waiting_on_user')
					ORDER BY ai.priority ASC, ai.updated_at DESC
					LIMIT 1
				) AS attention_summary
			 FROM agents a
			 WHERE a.task_id IS NULL
			 ORDER BY a.created_at ASC
			 LIMIT ?`,
		)
		.all(limit) as Array<Record<string, unknown>>;
	const created: Array<{ taskId: string; agentId: string; status: TaskState }> = [];
	for (const row of rows) {
		const mapping = backfillStatusFromLegacy({
			state: row.state as AgentState,
			profile: row.profile as string,
			attention_kind: (row.attention_kind as AttentionItemKind | null) ?? null,
			attention_summary: (row.attention_summary as string | null) ?? null,
			last_error: (row.last_error as string | null) ?? null,
			final_summary: (row.final_summary as string | null) ?? null,
		});
		const taskId = `task_${Number(row.created_at ?? Date.now()).toString(36)}_${randomUUID().slice(0, 8)}`;
		createTask(db, {
			id: taskId,
			spawnSessionId: (row.spawn_session_id as string | null) ?? null,
			spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
			spawnCwd: row.spawn_cwd as string,
			projectKey: row.project_key as string,
			title: row.title as string,
			summary: (row.last_assistant_preview as string | null) ?? null,
			description: row.task as string,
			status: mapping.status,
			waitingOn: mapping.waitingOn,
			blockedReason: mapping.blockedReason,
			reviewSummary: mapping.reviewSummary,
			finalSummary: mapping.finalSummary,
			createdAt: Number(row.created_at ?? Date.now()),
			updatedAt: Number(row.updated_at ?? Date.now()),
			startedAt: ["in_progress", "in_review", "done"].includes(mapping.status) ? Number(row.created_at ?? Date.now()) : null,
			reviewRequestedAt: mapping.status === "in_review" ? Number(row.updated_at ?? Date.now()) : null,
			finishedAt: mapping.status === "done" ? ((row.finished_at as number | null) ?? Number(row.updated_at ?? Date.now())) : null,
		});
		linkTaskAgent(db, {
			taskId,
			agentId: row.id as string,
			role: row.profile as string,
			isActive: ACTIVE_AGENT_STATES.includes(row.state as AgentState),
			linkedAt: Number(row.created_at ?? Date.now()),
			summary: "Backfilled from legacy agent record.",
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			agentId: row.id as string,
			eventType: "backfilled_from_agent",
			summary: `Backfilled from legacy agent ${row.id as string}`,
			payload: {
				agentState: row.state,
				attentionKind: row.attention_kind ?? null,
			},
			createdAt: Number(row.updated_at ?? Date.now()),
		});
		created.push({ taskId, agentId: row.id as string, status: mapping.status });
	}
	return created;
}

export function reconcileTasks(
	db: DatabaseSync,
	options: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number } = {},
): { backfilled: number; deactivatedLinks: number; tasksTouched: string[] } {
	if (options.ids && options.ids.length === 0) {
		return { backfilled: 0, deactivatedLinks: 0, tasksTouched: [] };
	}
	const backfilled = options.ids ? [] : backfillLegacyTasksFromAgents(db, options.limit ?? 500);
	const where: string[] = ["tal.is_active = 1"];
	const params: unknown[] = [];
	if (options.ids && options.ids.length > 0) {
		where.push(`t.id IN (${makePlaceholders(options.ids.length)})`);
		params.push(...options.ids);
	}
	if (options.projectKey) {
		where.push("t.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile);
	const rows = db
		.prepare(
			`SELECT tal.id, tal.task_id, tal.agent_id, a.state
			 FROM task_agent_links tal
			 JOIN tasks t ON t.id = tal.task_id
			 JOIN agents a ON a.id = tal.agent_id
			 WHERE ${where.join(" AND ")}
			 LIMIT ?`,
		)
		.all(...params, Math.max(1, Math.min(options.limit ?? 500, 1000))) as Array<{ id: string; task_id: string; agent_id: string; state: AgentState }>;
	let deactivatedLinks = 0;
	const tasksTouched = new Set<string>(backfilled.map((item) => item.taskId));
	const now = Date.now();
	for (const row of rows) {
		if (ACTIVE_AGENT_STATES.includes(row.state)) continue;
		db.prepare("UPDATE task_agent_links SET is_active = 0, unlinked_at = ? WHERE id = ?").run(now, row.id);
		db.prepare("UPDATE agents SET task_id = NULL WHERE id = ? AND task_id = ?").run(row.agent_id, row.task_id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: row.task_id,
			agentId: row.agent_id,
			eventType: "agent_unlinked",
			summary: `Unlinked terminal agent ${row.agent_id}`,
			payload: { state: row.state, reason: "reconcile_terminal_agent" },
			createdAt: now,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: row.task_id,
			agentId: row.agent_id,
			eventType: "task_lease_released",
			summary: `Released stale task lease for terminal agent ${row.agent_id}`,
			payload: { state: row.state, reason: "reconcile_terminal_agent" },
			createdAt: now,
		});
		updateTask(db, row.task_id, { updatedAt: now });
		tasksTouched.add(row.task_id);
		deactivatedLinks += 1;
	}
	return {
		backfilled: backfilled.length,
		deactivatedLinks,
		tasksTouched: [...tasksTouched],
	};
}
