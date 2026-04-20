import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentState, AttentionItemKind, AttentionItemState } from "./types.js";
import type {
	CreateTaskEventInput,
	CreateTaskInput,
	LinkTaskAgentInput,
	ListTaskAgentLinksFilters,
	ListTaskEventsFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskEventRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
	UpdateTaskInput,
} from "./task-types.js";

const ACTIVE_AGENT_STATES: AgentState[] = ["launching", "running", "idle", "waiting", "blocked"];
const OPEN_ATTENTION_STATES: AttentionItemState[] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];

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
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
	}
	return rows.map((row) => row.task_id);
}

export function linkTaskAgent(db: DatabaseSync, input: LinkTaskAgentInput): TaskAgentLinkRecord {
	const now = input.linkedAt ?? Date.now();
	const task = getTask(db, input.taskId);
	if (!task) throw new Error(`Unknown task id \"${input.taskId}\".`);
	const agentRow = db.prepare("SELECT profile FROM agents WHERE id = ?").get(input.agentId) as { profile?: string } | undefined;
	if (!agentRow) throw new Error(`Unknown agent id \"${input.agentId}\".`);
	deactivateActiveLinksForAgent(db, input.agentId, input.taskId, "linked_to_new_task", now);
	const existing = db
		.prepare("SELECT * FROM task_agent_links WHERE task_id = ? AND agent_id = ? AND is_active = 1 LIMIT 1")
		.get(input.taskId, input.agentId) as Record<string, unknown> | undefined;
	if (existing) {
		db.prepare("UPDATE task_agent_links SET role = ?, summary = ? WHERE id = ?").run(
			input.role?.trim() || (existing.role as string | null) || agentRow.profile || "contributor",
			input.summary?.trim() || (existing.summary as string | null) || null,
			existing.id,
		);
		updateTask(db, input.taskId, { updatedAt: now });
		db.prepare("UPDATE agents SET task_id = ? WHERE id = ?").run(input.taskId, input.agentId);
		return toTaskAgentLinkRecord({ ...existing, role: input.role ?? existing.role, summary: input.summary ?? existing.summary });
	}
	const record: TaskAgentLinkRecord = {
		id: input.id ?? randomUUID(),
		taskId: input.taskId,
		agentId: input.agentId,
		role: input.role?.trim() || agentRow.profile || "contributor",
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
	return record;
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
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			agentId,
			eventType: "agent_unlinked",
			summary: `Unlinked ${agentId}`,
			payload: { reason: reason?.trim() || null },
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
	const where: string[] = ["t.status IN ('blocked', 'in_review')"];
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
				COALESCE((
					SELECT COUNT(*)
					FROM task_agent_links tal
					JOIN attention_items ai ON ai.agent_id = tal.agent_id
					WHERE tal.task_id = t.id
						AND ai.state IN (${makePlaceholders(OPEN_ATTENTION_STATES.length)})
				), 0) AS open_attention_count
			FROM tasks t
			WHERE ${where.join(" AND ")}
			ORDER BY
				CASE WHEN t.status = 'blocked' AND t.waiting_on = 'user' THEN 0
					WHEN t.status = 'blocked' THEN 1
					WHEN t.status = 'in_review' THEN 2
					ELSE 3 END,
				t.priority ASC,
				t.updated_at DESC
			LIMIT ?`,
		)
		.all(...ACTIVE_AGENT_STATES, ...OPEN_ATTENTION_STATES, ...params) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
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
	}));
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
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: row.task_id,
			agentId: row.agent_id,
			eventType: "agent_unlinked",
			summary: `Unlinked terminal agent ${row.agent_id}`,
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
