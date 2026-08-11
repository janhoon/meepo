/**
 * Derived task health (read-time liveness, not Kanban lane).
 */
import type { DatabaseSync } from "node:sqlite";
import {
	ACTIVE_AGENT_STATES,
	OPEN_AGENT_ATTENTION_V2_STATES,
	OPEN_ATTENTION_STATES,
} from "./registry-shared.js";
import { addSessionScopeFilter, makePlaceholders } from "./sql-util.js";
import { listTaskEvents, listTasks } from "./task-store.js";
import { listTaskAgentLinks } from "./task-leases.js";
import { listUnresolvedTaskDependencies } from "./task-graph.js";
import {
	TASK_HEALTH_DEFAULT_STALE_AFTER_MS,
	taskHasUsefulBody,
	toTaskEventRecord,
	toTaskRecord,
} from "./task-shared.js";
import type {
	ListTasksFilters,
	TaskEventRecord,
	TaskHealthSnapshot,
	TaskHealthSignal,
	TaskRecord,
} from "./task-types.js";
import type { AgentAttentionV2State, AgentState, AttentionItemState } from "./types.js";

// Note: listTaskHealth may query attention via raw SQL; keep self-contained where possible.

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

