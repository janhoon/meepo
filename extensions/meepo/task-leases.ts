/**
 * Task exclusive/review lease helpers.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { ACTIVE_AGENT_STATES } from "./registry-shared.js";
import { makePlaceholders } from "./sql-util.js";
import { createTaskEvent, updateTask } from "./task-store.js";
import {
	taskLeaseKindForProfile,
	toTaskAgentLinkRecord,
	toTaskLeaseOwnerRecord,
	type TaskLeaseConflictRecord,
	type TaskLeaseKind,
	type TaskLeaseOwnerRecord,
	type TaskLeaseStateRecord,
} from "./task-shared.js";
import type { ListTaskAgentLinksFilters, TaskAgentLinkRecord } from "./task-types.js";

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

export function deactivateActiveLinksForAgent(db: DatabaseSync, agentId: string, exceptTaskId: string | null, reason: string, now: number): string[] {
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


