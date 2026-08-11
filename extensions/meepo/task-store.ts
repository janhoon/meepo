/**
 * Task CRUD, subtree listing, and task events.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addSessionScopeFilter, makePlaceholders, safeJsonParse } from "./sql-util.js";
import {
	normalizeStringArray,
	nowOr,
	TASK_FIELD_TO_COLUMN,
	taskStatusOrderSql,
	toTaskEventRecord,
	toTaskRecord,
} from "./task-shared.js";
import type {
	CreateTaskEventInput,
	CreateTaskInput,
	ListTaskEventsFilters,
	ListTasksFilters,
	TaskEventRecord,
	TaskRecord,
	UpdateTaskInput,
} from "./task-types.js";

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

