/**
 * Task dependency links and readiness.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { ACTIVE_AGENT_STATES } from "./registry-shared.js";
import { addSessionScopeFilter, makePlaceholders, runImmediateTransaction } from "./sql-util.js";
import { createTaskEvent, getTask, updateTask } from "./task-store.js";
import { toTaskLinkRecord } from "./task-shared.js";
import type {
	CreateTaskLinkInput,
	ListTaskLinksFilters,
	ListTasksFilters,
	TaskLinkType,
	TaskLinkWithTasksRecord,
	TaskReadinessRecord,
	TaskRecord,
	TaskState,
} from "./task-types.js";

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

