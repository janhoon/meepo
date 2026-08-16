/**
 * Task <-> agent ownership links.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { addSessionScopeFilter, runImmediateTransaction } from "./sql-util.js";
import { assertTaskLeaseAvailable, deactivateActiveLinksForAgent } from "./task-leases.js";
import { createTaskEvent, getTask, updateTask } from "./task-store.js";
import { taskLeaseKindForProfile, toTaskAgentLinkRecord } from "./task-shared.js";
import type {
	LinkTaskAgentInput,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskSummaryCounts,
} from "./task-types.js";

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

