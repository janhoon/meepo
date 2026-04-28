import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AgentState, AttentionItemKind, AttentionItemState } from "./types.js";
import type {
	CreateTaskEventInput,
	CreateTaskInput,
	CreateTaskNeedsHumanInput,
	LinkTaskAgentInput,
	ListTaskAgentLinksFilters,
	ListTaskEventsFilters,
	ListTaskNeedsHumanFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskEventRecord,
	TaskNeedsHumanCategory,
	TaskNeedsHumanKind,
	TaskNeedsHumanRecord,
	TaskNeedsHumanState,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
	UpdateTaskInput,
	UpdateTaskNeedsHumanInput,
} from "./task-types.js";

const ACTIVE_AGENT_STATES: AgentState[] = ["launching", "running", "idle", "waiting", "blocked"];
const OPEN_ATTENTION_STATES: AttentionItemState[] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];
export const OPEN_TASK_NEEDS_HUMAN_STATES: TaskNeedsHumanState[] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user", "waiting_on_service", "waiting_on_external"];
const OPEN_NEEDS_HUMAN_STATES = OPEN_TASK_NEEDS_HUMAN_STATES;

export const TASK_LIFECYCLE_TRANSITION_MATRIX = [
	{ transition: "start", taskStatus: "in_progress", agentState: "running", needsHuman: "none", link: "active" },
	{ transition: "milestone/note", taskStatus: "in_progress", agentState: "running", needsHuman: "unchanged", link: "active" },
	{ transition: "blocker/question", taskStatus: "blocked", agentState: "blocked|waiting", needsHuman: "open/waiting", link: "active" },
	{ transition: "answer/task_patch", taskStatus: "patch-defined; blocker defaults to in_progress", agentState: "unchanged until child resumes", needsHuman: "acknowledged or resolved", link: "active" },
	{ transition: "answer/child_message", taskStatus: "patch-defined; blocker defaults to in_progress", agentState: "queued child message", needsHuman: "terminal-claimed before delivery", link: "active" },
	{ transition: "complete/review_gate", taskStatus: "in_review by worker, done by reviewer/default override", agentState: "done", needsHuman: "review_gate open when in_review", link: "inactive" },
	{ transition: "review approval", taskStatus: "done", agentState: "terminal", needsHuman: "resolved", link: "inactive" },
	{ transition: "cancel/error/lost", taskStatus: "not regressed by reconcile", agentState: "terminal", needsHuman: "preserved unless force cleanup", link: "inactive" },
	{ transition: "cleanup", taskStatus: "unchanged", agentState: "terminal record retained", needsHuman: "completion resolved; blockers/questions require force", link: "inactive" },
] as const;

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
	requestedProfile: "requested_profile",
	assignedProfile: "assigned_profile",
	launchPolicy: "launch_policy",
	promptTemplate: "prompt_template",
	roleHint: "role_hint",
	workspaceStrategy: "workspace_strategy",
	worktreeId: "worktree_id",
	worktreeCwd: "worktree_cwd",
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

function normalizeNullableString(value: string | null | undefined): string | null | undefined {
	if (value === undefined || value === null) return value;
	return value.trim() || null;
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
		requestedProfile: (row.requested_profile as string | null) ?? null,
		assignedProfile: (row.assigned_profile as string | null) ?? null,
		launchPolicy: row.launch_policy === "autonomous" ? "autonomous" : "manual",
		promptTemplate: (row.prompt_template as string | null) ?? null,
		roleHint: (row.role_hint as string | null) ?? null,
		workspaceStrategy: (row.workspace_strategy as TaskRecord["workspaceStrategy"] | null) ?? null,
		worktreeId: (row.worktree_id as string | null) ?? null,
		worktreeCwd: (row.worktree_cwd as string | null) ?? null,
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
		syncTaskWorkspace: Number(row.sync_task_workspace ?? 1) === 1,
	};
}

function taskStatusOrderSql(column = "t.status"): string {
	return `CASE ${column} WHEN 'blocked' THEN 0 WHEN 'in_review' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 ELSE 5 END`;
}

function toTaskNeedsHumanRecord(row: Record<string, unknown>): TaskNeedsHumanRecord {
	return {
		id: row.id as string,
		taskId: row.task_id as string,
		agentId: row.agent_id as string,
		taskAgentLinkId: (row.task_agent_link_id as string | null) ?? null,
		sourceMessageId: (row.source_message_id as string | null) ?? null,
		legacyAttentionItemId: (row.legacy_attention_item_id as string | null) ?? null,
		projectKey: row.project_key as string,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		kind: row.kind as TaskNeedsHumanKind,
		category: row.category as TaskNeedsHumanCategory,
		waitingOn: (row.waiting_on as TaskWaitingOn | null) ?? null,
		priority: Number(row.priority ?? 0),
		state: row.state as TaskNeedsHumanState,
		summary: row.summary as string,
		payload: safeJsonParse(row.payload_json as string | null, null),
		responseRequired: Number(row.response_required ?? 0) === 1,
		responsePrompt: (row.response_prompt as string | null) ?? null,
		responseSchema: safeJsonParse(row.response_schema_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		resolvedAt: (row.resolved_at as number | null) ?? null,
		resolvedBy: (row.resolved_by as string | null) ?? null,
		resolutionKind: (row.resolution_kind as string | null) ?? null,
		resolutionSummary: (row.resolution_summary as string | null) ?? null,
	};
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

function needsHumanCategoryForPublish(kind: "blocked" | "question" | "question_for_user" | "complete"): TaskNeedsHumanCategory {
	if (kind === "blocked") return "blocker";
	if (kind === "complete") return "completion";
	return "question";
}

function needsHumanStateForWaitingOn(waitingOn: TaskWaitingOn | null): TaskNeedsHumanState {
	if (waitingOn === "user") return "waiting_on_user";
	if (waitingOn === "service") return "waiting_on_service";
	if (waitingOn === "external") return "waiting_on_external";
	return "waiting_on_coordinator";
}

function defaultWaitingOnForNeedsHuman(kind: "blocked" | "question" | "question_for_user" | "complete", explicit: TaskWaitingOn | null | undefined): TaskWaitingOn | null {
	if (explicit) return explicit;
	if (kind === "question_for_user") return "user";
	if (kind === "question" || kind === "blocked" || kind === "complete") return "coordinator";
	return null;
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
			requested_profile,
			assigned_profile,
			launch_policy,
			prompt_template,
			role_hint,
			workspace_strategy,
			worktree_id,
			worktree_cwd,
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
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
		input.requestedProfile?.trim() || null,
		input.assignedProfile?.trim() || null,
		input.launchPolicy ?? "manual",
		input.promptTemplate?.trim() || null,
		input.roleHint?.trim() || null,
		input.workspaceStrategy ?? null,
		normalizeNullableString(input.worktreeId) ?? null,
		normalizeNullableString(input.worktreeCwd) ?? null,
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
		} else if (["worktreeId", "worktreeCwd"].includes(field)) {
			params.push(normalizeNullableString(value as string | null | undefined));
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

function syncAgentTaskWorktreeForActiveLink(db: DatabaseSync, task: TaskRecord, agentId: string): number {
	const result = db.prepare(`UPDATE agents
		SET task_id = ?,
			workspace_strategy = CASE WHEN workspace_strategy IS NULL THEN ? ELSE workspace_strategy END,
			worktree_id = CASE WHEN workspace_strategy IS NULL THEN ? ELSE worktree_id END,
			worktree_cwd = CASE WHEN workspace_strategy IS NULL THEN ? ELSE worktree_cwd END
		WHERE id = ?
			AND state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
			AND EXISTS (
				SELECT 1
				FROM task_agent_links tal
				WHERE tal.task_id = ?
					AND tal.agent_id = agents.id
					AND tal.is_active = 1
					AND tal.sync_task_workspace = 1
			)
	`).run(
		task.id,
		task.workspaceStrategy,
		task.worktreeId,
		task.worktreeCwd,
		agentId,
		...ACTIVE_AGENT_STATES,
		task.id,
	) as { changes?: number };
	return Number(result.changes ?? 0);
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
	const agentRow = db.prepare("SELECT profile, state FROM agents WHERE id = ?").get(input.agentId) as { profile?: string; state?: AgentState } | undefined;
	if (!agentRow) throw new Error(`Unknown agent id \"${input.agentId}\".`);
	deactivateActiveLinksForAgent(db, input.agentId, input.taskId, "linked_to_new_task", now);
	const existing = db
		.prepare("SELECT * FROM task_agent_links WHERE task_id = ? AND agent_id = ? AND is_active = 1 LIMIT 1")
		.get(input.taskId, input.agentId) as Record<string, unknown> | undefined;
	if (existing) {
		const syncTaskWorkspace = input.syncTaskWorkspace ?? (Number(existing.sync_task_workspace ?? 1) === 1);
		db.prepare("UPDATE task_agent_links SET role = ?, summary = ?, sync_task_workspace = ? WHERE id = ?").run(
			input.role?.trim() || (existing.role as string | null) || agentRow.profile || "contributor",
			input.summary?.trim() || (existing.summary as string | null) || null,
			syncTaskWorkspace ? 1 : 0,
			existing.id,
		);
		updateTask(db, input.taskId, { updatedAt: now });
		if (syncTaskWorkspace) {
			syncAgentTaskWorktreeForActiveLink(db, task, input.agentId);
		}
		return toTaskAgentLinkRecord({ ...existing, role: input.role ?? existing.role, summary: input.summary ?? existing.summary, sync_task_workspace: syncTaskWorkspace ? 1 : 0 });
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
		syncTaskWorkspace: input.syncTaskWorkspace !== false,
	};
	db.prepare(
		`INSERT INTO task_agent_links (id, task_id, agent_id, role, is_active, linked_at, unlinked_at, summary, sync_task_workspace)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(record.id, record.taskId, record.agentId, record.role, record.isActive ? 1 : 0, record.linkedAt, record.unlinkedAt, record.summary, record.syncTaskWorkspace ? 1 : 0);
	if (input.syncTaskWorkspace !== false) {
		syncAgentTaskWorktreeForActiveLink(db, task, record.agentId);
	}
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
	return deactivateTaskAgentLink(db, taskId, agentId, reason, now);
}

function deactivateTaskAgentLink(db: DatabaseSync, taskId: string, agentId: string, reason: string | undefined, now: number): number {
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
		db.prepare("UPDATE agents SET task_id = NULL, workspace_strategy = NULL, worktree_id = NULL, worktree_cwd = NULL WHERE id = ? AND task_id = ?").run(agentId, taskId);
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

export function createTaskNeedsHuman(db: DatabaseSync, input: CreateTaskNeedsHumanInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT OR REPLACE INTO task_needs_human (
			id, task_id, agent_id, task_agent_link_id, source_message_id, legacy_attention_item_id,
			project_key, spawn_session_id, spawn_session_file, kind, category, waiting_on, priority,
			state, summary, payload_json, response_required, response_prompt, response_schema_json,
			created_at, updated_at, resolved_at, resolved_by, resolution_kind, resolution_summary
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.taskId,
		input.agentId,
		input.taskAgentLinkId ?? null,
		input.sourceMessageId ?? null,
		input.legacyAttentionItemId ?? null,
		input.projectKey,
		input.spawnSessionId ?? null,
		input.spawnSessionFile ?? null,
		input.kind,
		input.category,
		input.waitingOn ?? null,
		Math.max(0, Math.min(input.priority, 9)),
		input.state,
		input.summary,
		input.payload === undefined ? null : JSON.stringify(input.payload),
		input.responseRequired ? 1 : 0,
		input.responsePrompt ?? null,
		input.responseSchema === undefined ? null : JSON.stringify(input.responseSchema),
		createdAt,
		updatedAt,
		input.resolvedAt ?? null,
		input.resolvedBy ?? null,
		input.resolutionKind ?? null,
		input.resolutionSummary ?? null,
	);
}

function taskNeedsHumanAssignments(patch: UpdateTaskNeedsHumanInput): { assignments: string[]; params: unknown[] } {
	const assignments: string[] = [];
	const params: unknown[] = [];
	const add = (column: string, value: unknown): void => {
		assignments.push(`${column} = ?`);
		params.push(value);
	};
	if (patch.taskAgentLinkId !== undefined) add("task_agent_link_id", patch.taskAgentLinkId);
	if (patch.state !== undefined) add("state", patch.state);
	if (patch.waitingOn !== undefined) add("waiting_on", patch.waitingOn);
	if (patch.priority !== undefined) add("priority", Math.max(0, Math.min(patch.priority, 9)));
	if (patch.summary !== undefined) add("summary", patch.summary);
	if (patch.payload !== undefined) add("payload_json", JSON.stringify(patch.payload));
	if (patch.responseRequired !== undefined) add("response_required", patch.responseRequired ? 1 : 0);
	if (patch.responsePrompt !== undefined) add("response_prompt", patch.responsePrompt);
	if (patch.responseSchema !== undefined) add("response_schema_json", JSON.stringify(patch.responseSchema));
	add("updated_at", patch.updatedAt ?? Date.now());
	if (patch.resolvedAt !== undefined) add("resolved_at", patch.resolvedAt);
	if (patch.resolvedBy !== undefined) add("resolved_by", patch.resolvedBy);
	if (patch.resolutionKind !== undefined) add("resolution_kind", patch.resolutionKind);
	if (patch.resolutionSummary !== undefined) add("resolution_summary", patch.resolutionSummary);
	return { assignments, params };
}

export function updateTaskNeedsHuman(db: DatabaseSync, id: string, patch: UpdateTaskNeedsHumanInput): void {
	const { assignments, params } = taskNeedsHumanAssignments(patch);
	params.push(id);
	db.prepare(`UPDATE task_needs_human SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

export function claimTaskNeedsHumanResponse(db: DatabaseSync, id: string, patch: UpdateTaskNeedsHumanInput): TaskNeedsHumanRecord | null {
	const { assignments, params } = taskNeedsHumanAssignments(patch);
	params.push(id, ...OPEN_NEEDS_HUMAN_STATES);
	const result = db.prepare(`UPDATE task_needs_human SET ${assignments.join(", ")} WHERE id = ? AND state IN (${makePlaceholders(OPEN_NEEDS_HUMAN_STATES.length)})`).run(...params) as { changes?: number };
	if (Number(result.changes ?? 0) === 0) return null;
	return listTaskNeedsHuman(db, { ids: [id], limit: 1 })[0] ?? null;
}

export function updateTaskNeedsHumanForAgent(
	db: DatabaseSync,
	agentId: string,
	patch: UpdateTaskNeedsHumanInput,
	filters: {
		ids?: string[];
		states?: TaskNeedsHumanState[];
		kinds?: TaskNeedsHumanKind[];
		sourceMessageId?: string | null;
	} = {},
): number {
	const { assignments, params } = taskNeedsHumanAssignments(patch);
	const where: string[] = ["agent_id = ?"];
	params.push(agentId);
	if (filters.ids && filters.ids.length > 0) {
		where.push(`id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.states && filters.states.length > 0) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		where.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.sourceMessageId !== undefined) {
		if (filters.sourceMessageId === null) {
			where.push("source_message_id IS NULL");
		} else {
			where.push("source_message_id = ?");
			params.push(filters.sourceMessageId);
		}
	}
	const result = db.prepare(`UPDATE task_needs_human SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`).run(...params) as { changes?: number };
	return Number(result.changes ?? 0);
}

export function listTaskNeedsHuman(db: DatabaseSync, filters: ListTaskNeedsHumanFilters = {}): TaskNeedsHumanRecord[] {
	if (filters.ids && filters.ids.length === 0) return [];
	if (filters.taskIds && filters.taskIds.length === 0) return [];
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.ids?.length) {
		where.push(`id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.taskIds?.length) {
		where.push(`task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
	}
	if (filters.agentIds?.length) {
		where.push(`agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.projectKey) {
		where.push("project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "task_needs_human");
	if (filters.states?.length) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.waitingOn?.length) {
		where.push(`waiting_on IN (${makePlaceholders(filters.waitingOn.length)})`);
		params.push(...filters.waitingOn);
	}
	if (filters.kinds?.length) {
		where.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.categories?.length) {
		where.push(`category IN (${makePlaceholders(filters.categories.length)})`);
		params.push(...filters.categories);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const rows = db.prepare(`SELECT * FROM task_needs_human ${whereClause} ORDER BY priority ASC, updated_at DESC, created_at ASC LIMIT ?`).all(...params) as Array<Record<string, unknown>>;
	return rows.map(toTaskNeedsHumanRecord);
}

export function listTaskAttention(
	db: DatabaseSync,
	filters: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number },
): TaskAttentionRecord[] {
	if (filters.ids && filters.ids.length === 0) return [];
	const where: string[] = [`nh.state IN (${makePlaceholders(OPEN_NEEDS_HUMAN_STATES.length)})`];
	const params: unknown[] = [...OPEN_NEEDS_HUMAN_STATES];
	if (filters.ids && filters.ids.length > 0) {
		where.push(`nh.task_id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.projectKey) {
		where.push("nh.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "nh");
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const rows = db.prepare(
		`SELECT nh.*, t.title, t.status, t.blocked_reason, t.review_summary,
			COALESCE((
				SELECT COUNT(*) FROM task_agent_links tal
				JOIN agents a ON a.id = tal.agent_id
				WHERE tal.task_id = nh.task_id AND tal.is_active = 1 AND a.state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
			), 0) AS active_agent_count,
			COALESCE((
				SELECT COUNT(*) FROM task_needs_human sibling
				WHERE sibling.task_id = nh.task_id AND sibling.state IN (${makePlaceholders(OPEN_NEEDS_HUMAN_STATES.length)})
			), 0) AS open_attention_count
		 FROM task_needs_human nh
		 JOIN tasks t ON t.id = nh.task_id
		 WHERE ${where.join(" AND ")}
		 ORDER BY nh.priority ASC, nh.updated_at DESC, nh.created_at ASC
		 LIMIT ?`,
	).all(...ACTIVE_AGENT_STATES, ...OPEN_NEEDS_HUMAN_STATES, ...params) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		...toTaskNeedsHumanRecord(row),
		title: row.title as string,
		status: row.status as TaskState,
		blockedReason: (row.blocked_reason as string | null) ?? null,
		reviewSummary: (row.review_summary as string | null) ?? null,
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
		sourceMessageId?: string | null;
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
	if (options.kind === "blocked" || options.kind === "question" || options.kind === "question_for_user" || options.kind === "complete") {
		const link = db.prepare("SELECT id FROM task_agent_links WHERE task_id = ? AND agent_id = ? AND is_active = 1 LIMIT 1").get(taskId, options.agentId) as { id?: string } | undefined;
		const needsWaitingOn = defaultWaitingOnForNeedsHuman(options.kind, patch.waitingOn ?? options.waitingOn ?? null);
		createTaskNeedsHuman(db, {
			id: options.sourceMessageId ?? randomUUID(),
			taskId,
			agentId: options.agentId,
			taskAgentLinkId: link?.id ?? null,
			sourceMessageId: options.sourceMessageId ?? null,
			projectKey: current.projectKey,
			spawnSessionId: current.spawnSessionId,
			spawnSessionFile: current.spawnSessionFile,
			kind: options.kind,
			category: derivedStatus === "in_review" && options.kind === "complete" ? "review_gate" : needsHumanCategoryForPublish(options.kind),
			waitingOn: needsWaitingOn,
			priority: options.kind === "question_for_user" ? 0 : options.kind === "question" ? 1 : options.kind === "blocked" ? 2 : 3,
			state: needsHumanStateForWaitingOn(needsWaitingOn),
			summary: options.summary,
			payload: {
				kind: options.kind,
				details: options.details ?? null,
				files: options.files ?? [],
				status: patch.status,
				waitingOn: patch.waitingOn,
				blockedReason: patch.blockedReason,
				reviewSummary: patch.reviewSummary ?? null,
				finalSummary: patch.finalSummary ?? null,
			},
			responseRequired: options.kind === "question" || options.kind === "question_for_user" || options.kind === "blocked" || derivedStatus === "in_review",
			responsePrompt: options.kind === "question" || options.kind === "question_for_user" ? options.blockedReason ?? options.summary : null,
			createdAt: now,
			updatedAt: now,
		});
	}
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
	if (options.kind === "complete") {
		deactivateTaskAgentLink(db, taskId, options.agentId, "child_publish_complete", now);
	}
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

export function backfillNeedsHumanFromAttentionItems(
	db: DatabaseSync,
	options: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number } = {},
): number {
	if (options.ids && options.ids.length === 0) return 0;
	const where: string[] = ["ai.state IN ('open', 'acknowledged', 'waiting_on_coordinator', 'waiting_on_user')"];
	const params: unknown[] = [];
	if (options.ids?.length) {
		where.push(`t.id IN (${makePlaceholders(options.ids.length)})`);
		params.push(...options.ids);
	}
	if (options.projectKey) {
		where.push("t.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile, "t");
	const rows = db.prepare(
		`SELECT ai.*, t.id AS task_id, t.project_key AS task_project_key, t.spawn_session_id AS task_spawn_session_id,
			t.spawn_session_file AS task_spawn_session_file, tal.id AS task_agent_link_id
		 FROM attention_items ai
		 JOIN agents a ON a.id = ai.agent_id
		 LEFT JOIN task_agent_links tal_current ON tal_current.agent_id = ai.agent_id AND tal_current.is_active = 1
		 JOIN tasks t ON t.id = COALESCE(a.task_id, tal_current.task_id)
		 LEFT JOIN task_agent_links tal ON tal.task_id = t.id AND tal.agent_id = ai.agent_id AND tal.is_active = 1
		 LEFT JOIN task_needs_human nh ON nh.legacy_attention_item_id = ai.id
		 WHERE ${where.join(" AND ")} AND nh.id IS NULL
		 ORDER BY ai.priority ASC, ai.updated_at DESC
		 LIMIT ?`,
	).all(...params, Math.max(1, Math.min(options.limit ?? 500, 1000))) as Array<Record<string, unknown>>;
	let created = 0;
	for (const row of rows) {
		const kind = row.kind as "question" | "question_for_user" | "blocked" | "complete";
		const waitingOn: TaskWaitingOn | null = row.audience === "user" ? "user" : "coordinator";
		createTaskNeedsHuman(db, {
			id: `nh_${row.id as string}`,
			taskId: row.task_id as string,
			agentId: row.agent_id as string,
			taskAgentLinkId: (row.task_agent_link_id as string | null) ?? null,
			sourceMessageId: (row.message_id as string | null) ?? null,
			legacyAttentionItemId: row.id as string,
			projectKey: (row.task_project_key as string | null) ?? (row.project_key as string),
			spawnSessionId: (row.task_spawn_session_id as string | null) ?? (row.spawn_session_id as string | null) ?? null,
			spawnSessionFile: (row.task_spawn_session_file as string | null) ?? (row.spawn_session_file as string | null) ?? null,
			kind,
			category: needsHumanCategoryForPublish(kind),
			waitingOn,
			priority: Number(row.priority ?? 3),
			state: needsHumanStateForWaitingOn(waitingOn),
			summary: row.summary as string,
			payload: safeJsonParse(row.payload_json as string | null, null),
			responseRequired: kind !== "complete",
			createdAt: Number(row.created_at ?? Date.now()),
			updatedAt: Number(row.updated_at ?? Date.now()),
		});
		created += 1;
	}
	return created;
}

export function reconcileResolvedNeedsHumanFromAttentionItems(
	db: DatabaseSync,
	options: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number } = {},
): number {
	if (options.ids && options.ids.length === 0) return 0;
	const where: string[] = [
		"(nh.legacy_attention_item_id IS NOT NULL OR nh.source_message_id IS NOT NULL)",
		`nh.state IN (${makePlaceholders(OPEN_NEEDS_HUMAN_STATES.length)})`,
		"ai.state NOT IN ('open', 'acknowledged', 'waiting_on_coordinator', 'waiting_on_user')",
	];
	const params: unknown[] = [...OPEN_NEEDS_HUMAN_STATES];
	if (options.ids?.length) {
		where.push(`t.id IN (${makePlaceholders(options.ids.length)})`);
		params.push(...options.ids);
	}
	if (options.projectKey) {
		where.push("t.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile, "t");
	const rows = db.prepare(
		`SELECT nh.id, ai.state, ai.updated_at, ai.resolved_at, ai.resolution_kind, ai.resolution_summary
		 FROM task_needs_human nh
		 JOIN attention_items ai ON ai.id = COALESCE(nh.legacy_attention_item_id, nh.source_message_id)
		 JOIN tasks t ON t.id = nh.task_id
		 WHERE ${where.join(" AND ")}
		 ORDER BY ai.updated_at DESC
		 LIMIT ?`,
	).all(...params, Math.max(1, Math.min(options.limit ?? 500, 1000))) as Array<Record<string, unknown>>;
	for (const row of rows) {
		const state = row.state === "cancelled" ? "cancelled" : row.state === "superseded" ? "superseded" : "resolved";
		updateTaskNeedsHuman(db, row.id as string, {
			state,
			waitingOn: null,
			responseRequired: false,
			updatedAt: Number(row.updated_at ?? Date.now()),
			resolvedAt: (row.resolved_at as number | null) ?? Number(row.updated_at ?? Date.now()),
			resolvedBy: "legacy_attention",
			resolutionKind: (row.resolution_kind as string | null) ?? "legacy_attention",
			resolutionSummary: (row.resolution_summary as string | null) ?? "Mirrored from resolved legacy attention item.",
		});
	}
	return rows.length;
}

function repairTaskAgentLinkPointers(
	db: DatabaseSync,
	options: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number } = {},
): { linkPointersRepaired: number; agentTaskPointersRepaired: number; tasksTouched: string[] } {
	const where: string[] = [`nh.state IN (${makePlaceholders(OPEN_NEEDS_HUMAN_STATES.length)})`, "tal.id IS NOT NULL", "(nh.task_agent_link_id IS NULL OR nh.task_agent_link_id != tal.id)"];
	const params: unknown[] = [...OPEN_NEEDS_HUMAN_STATES];
	if (options.ids?.length) {
		where.push(`nh.task_id IN (${makePlaceholders(options.ids.length)})`);
		params.push(...options.ids);
	}
	if (options.projectKey) {
		where.push("nh.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile, "nh");
	const rows = db.prepare(
		`SELECT nh.id, nh.task_id, tal.id AS link_id
		 FROM task_needs_human nh
		 JOIN task_agent_links tal ON tal.task_id = nh.task_id AND tal.agent_id = nh.agent_id AND tal.is_active = 1
		 WHERE ${where.join(" AND ")}
		 LIMIT ?`,
	).all(...params, Math.max(1, Math.min(options.limit ?? 500, 1000))) as Array<{ id: string; task_id: string; link_id: string }>;
	const now = Date.now();
	const tasksTouched = new Set<string>();
	for (const row of rows) {
		updateTaskNeedsHuman(db, row.id, { taskAgentLinkId: row.link_id, updatedAt: now });
		tasksTouched.add(row.task_id);
	}

	const agentWhere: string[] = [
		"tal.is_active = 1",
		`a.state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})`,
		`(a.task_id IS NULL
			OR a.task_id != tal.task_id
			OR (tal.sync_task_workspace = 1 AND (
				a.workspace_strategy IS NOT t.workspace_strategy
				OR a.worktree_id IS NOT t.worktree_id
				OR a.worktree_cwd IS NOT t.worktree_cwd
			)))`,
	];
	const agentParams: unknown[] = [...ACTIVE_AGENT_STATES];
	if (options.ids?.length) {
		agentWhere.push(`tal.task_id IN (${makePlaceholders(options.ids.length)})`);
		agentParams.push(...options.ids);
	}
	if (options.projectKey) {
		agentWhere.push("t.project_key = ?");
		agentParams.push(options.projectKey);
	}
	addSessionScopeFilter(agentWhere, agentParams, options.spawnSessionId, options.spawnSessionFile, "t");
	const agentRows = db.prepare(
		`SELECT tal.task_id, tal.agent_id, tal.sync_task_workspace
		 FROM task_agent_links tal
		 JOIN tasks t ON t.id = tal.task_id
		 JOIN agents a ON a.id = tal.agent_id
		 WHERE ${agentWhere.join(" AND ")}
		 LIMIT ?`,
	).all(...agentParams, Math.max(1, Math.min(options.limit ?? 500, 1000))) as Array<{ task_id: string; agent_id: string; sync_task_workspace: number }>;
	for (const row of agentRows) {
		if (Number(row.sync_task_workspace ?? 1) === 1) {
			db.prepare(`UPDATE agents
				SET task_id = ?,
					workspace_strategy = (SELECT workspace_strategy FROM tasks WHERE id = ?),
					worktree_id = (SELECT worktree_id FROM tasks WHERE id = ?),
					worktree_cwd = (SELECT worktree_cwd FROM tasks WHERE id = ?),
					updated_at = ?
				WHERE id = ?
					AND state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
					AND EXISTS (
						SELECT 1
						FROM task_agent_links tal
						WHERE tal.task_id = ?
							AND tal.agent_id = agents.id
							AND tal.is_active = 1
							AND tal.sync_task_workspace = 1
					)`).run(row.task_id, row.task_id, row.task_id, row.task_id, now, row.agent_id, ...ACTIVE_AGENT_STATES, row.task_id);
		} else {
			db.prepare(`UPDATE agents
				SET task_id = ?,
					updated_at = ?
				WHERE id = ?
					AND state IN (${makePlaceholders(ACTIVE_AGENT_STATES.length)})
					AND EXISTS (
						SELECT 1
						FROM task_agent_links tal
						WHERE tal.task_id = ?
							AND tal.agent_id = agents.id
							AND tal.is_active = 1
							AND tal.sync_task_workspace = 0
					)`).run(row.task_id, now, row.agent_id, ...ACTIVE_AGENT_STATES, row.task_id);
		}
		updateTask(db, row.task_id, { updatedAt: now });
		tasksTouched.add(row.task_id);
	}
	return { linkPointersRepaired: rows.length, agentTaskPointersRepaired: agentRows.length, tasksTouched: [...tasksTouched] };
}

export function reconcileTasks(
	db: DatabaseSync,
	options: Pick<ListTasksFilters, "ids" | "projectKey" | "spawnSessionId" | "spawnSessionFile"> & { limit?: number } = {},
): { backfilled: number; needsHumanBackfilled: number; needsHumanResolved: number; linkPointersRepaired: number; agentTaskPointersRepaired: number; deactivatedLinks: number; tasksTouched: string[] } {
	if (options.ids && options.ids.length === 0) {
		return { backfilled: 0, needsHumanBackfilled: 0, needsHumanResolved: 0, linkPointersRepaired: 0, agentTaskPointersRepaired: 0, deactivatedLinks: 0, tasksTouched: [] };
	}
	const backfilled = options.ids ? [] : backfillLegacyTasksFromAgents(db, options.limit ?? 500);
	const repaired = repairTaskAgentLinkPointers(db, options);
	const needsHumanBackfilled = backfillNeedsHumanFromAttentionItems(db, options);
	const needsHumanResolved = reconcileResolvedNeedsHumanFromAttentionItems(db, options);
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
	const tasksTouched = new Set<string>([...backfilled.map((item) => item.taskId), ...repaired.tasksTouched]);
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
		needsHumanBackfilled,
		needsHumanResolved,
		linkPointersRepaired: repaired.linkPointersRepaired,
		agentTaskPointersRepaired: repaired.agentTaskPointersRepaired,
		deactivatedLinks,
		tasksTouched: [...tasksTouched],
	};
}
