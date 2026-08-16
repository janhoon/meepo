/**
 * Task attention, child-publish projection, backfill, reconcile.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addSessionScopeFilter, makePlaceholders, safeJsonParse } from "./sql-util.js";
import { getTask, listTasks, updateTask, createTask, createTaskEvent, listTaskEvents } from "./task-store.js";
import { linkTaskAgent, unlinkTaskAgent } from "./task-links-agents.js";
import { listTaskAgentLinks } from "./task-leases.js";
import { listUnresolvedTaskDependencies, refreshTaskDependencyBlockState } from "./task-graph.js";
import { deriveTaskHealth, listTaskHealth } from "./task-health.js";
import {
	ACTIVE_AGENT_STATES,
	OPEN_AGENT_ATTENTION_V2_STATES,
	OPEN_ATTENTION_STATES,
} from "./registry-shared.js";
import {
	deriveDefaultTaskStatus,
	mergeStringArrays,
	normalizeStringArray,
	nowOr,
	taskLeaseKindForProfile,
	toTaskRecord,
} from "./task-shared.js";
import type {
	ListTasksFilters,
	TaskAttentionRecord,
	TaskRecord,
	TaskState,
} from "./task-types.js";
import type { AgentState } from "./types.js";

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
	if (taskLeaseKindForProfile(row.profile) === "review" && row.state === "done") {
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
