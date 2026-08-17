/**
 * Agent record store: create/update/list/get + fleet summary.
 */
import { randomUUID } from "node:crypto";
import { attachInboxUnread, summarizeInbox } from "./inbox.js";
import { persistHostFields } from "./process-host.js";
import type { DatabaseSync } from "./sqlite.js";
import { addSessionScopeFilter, makePlaceholders, safeJsonParse } from "./sql-util.js";
import {
	ACTIVE_STATES,
	AGENT_FIELD_TO_COLUMN,
	toAgentSummary,
} from "./registry-shared.js";
import type {
	AgentState,
	AgentSummary,
	CreateAgentEventInput,
	CreateAgentInput,
	CreateArtifactInput,
	FleetSummary,
	ListAgentsFilters,
	UpdateAgentInput,
} from "./types.js";

export function createAgent(db: DatabaseSync, input: CreateAgentInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	const host = input.host ? persistHostFields(input.host) : null;
	db.prepare(
		`INSERT INTO agents (
			id,
			parent_agent_id,
			org_id,
			role_key,
			spawned_by_agent_id,
			hierarchy_state,
			spawn_session_id,
			spawn_session_file,
			spawn_cwd,
			project_key,
			task_id,
			profile,
			title,
			task,
			state,
			transport_kind,
			transport_state,
			model,
			tools_json,
			bridge_socket_path,
			bridge_status_file,
			bridge_log_file,
			bridge_events_file,
			bridge_pid,
			bridge_connected_at,
			bridge_updated_at,
			bridge_last_error,
			host_kind,
			host_primary_id,
			host_display_name,
			host_target_json,
			run_dir,
			session_file,
			last_tool_name,
			last_assistant_preview,
			last_error,
			final_summary,
			created_at,
			updated_at,
			finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.parentAgentId ?? null,
		input.orgId ?? null,
		input.roleKey ?? null,
		input.spawnedByAgentId ?? null,
		input.hierarchyState ?? "attached",
		input.spawnSessionId ?? null,
		input.spawnSessionFile ?? null,
		input.spawnCwd,
		input.projectKey,
		input.taskId ?? null,
		input.profile,
		input.title,
		input.task,
		input.state,
		input.transportKind ?? "direct",
		input.transportState ?? ((input.transportKind ?? "direct") === "direct" ? "legacy" : "launching"),
		input.model ?? null,
		input.tools === undefined ? null : JSON.stringify(input.tools),
		input.bridgeSocketPath ?? null,
		input.bridgeStatusFile ?? null,
		input.bridgeLogFile ?? null,
		input.bridgeEventsFile ?? null,
		input.bridgePid ?? null,
		input.bridgeConnectedAt ?? null,
		input.bridgeUpdatedAt ?? null,
		input.bridgeLastError ?? null,
		host?.hostKind ?? "",
		host?.hostPrimaryId ?? null,
		host?.hostDisplayName ?? null,
		host?.hostTargetJson ?? null,
		input.runDir,
		input.sessionFile,
		input.lastToolName ?? null,
		input.lastAssistantPreview ?? null,
		input.lastError ?? null,
		input.finalSummary ?? null,
		createdAt,
		updatedAt,
		input.finishedAt ?? null,
	);
}

export function updateAgent(db: DatabaseSync, id: string, patch: UpdateAgentInput): void {
	const assignments: string[] = [];
	const params: unknown[] = [];
	if (patch.host !== undefined) {
		assignments.push("host_kind = ?", "host_primary_id = ?", "host_display_name = ?", "host_target_json = ?");
		if (patch.host) {
			const persisted = persistHostFields(patch.host);
			params.push(persisted.hostKind, persisted.hostPrimaryId, persisted.hostDisplayName, persisted.hostTargetJson);
		} else {
			params.push(null, null, null, null);
		}
	}
	for (const [field, value] of Object.entries(patch) as Array<[keyof UpdateAgentInput, UpdateAgentInput[keyof UpdateAgentInput]]>) {
		if (value === undefined || field === "host") continue;
		const column = AGENT_FIELD_TO_COLUMN[field];
		if (!column) continue;
		assignments.push(`${column} = ?`);
		if (field === "tools") params.push(JSON.stringify(value));
		else params.push(value);
	}
	if (assignments.length === 0) return;
	params.push(id);
	db.prepare(`UPDATE agents SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

export function listDescendantAgentIds(db: DatabaseSync, parentIds: string[]): string[] {
	if (parentIds.length === 0) return [];
	const placeholders = makePlaceholders(parentIds.length);
	const rows = db
		.prepare(
			`WITH RECURSIVE descendants(id) AS (
				SELECT id FROM agents WHERE parent_agent_id IN (${placeholders})
				UNION ALL
				SELECT a.id
				FROM agents a
				JOIN descendants d ON a.parent_agent_id = d.id
			)
			SELECT DISTINCT id FROM descendants ORDER BY id ASC`,
		)
		.all(...parentIds) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

export function listAgents(db: DatabaseSync, filters: ListAgentsFilters = {}): AgentSummary[] {
	let ids = filters.ids;
	if (filters.descendantOf) {
		if (filters.descendantOf.length === 0) return [];
		ids = listDescendantAgentIds(db, filters.descendantOf);
		if (ids.length === 0) return [];
	}
	if (ids && ids.length === 0) return [];
	if (filters.taskIds && filters.taskIds.length === 0) return [];

	const where: string[] = [];
	const params: unknown[] = [];
	if (ids && ids.length > 0) {
		where.push(`a.id IN (${makePlaceholders(ids.length)})`);
		params.push(...ids);
	}
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`a.task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
	}
	if (filters.projectKey) {
		where.push("a.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	if (filters.activeOnly) {
		where.push(`a.state IN (${makePlaceholders(ACTIVE_STATES.length)})`);
		params.push(...ACTIVE_STATES);
	}
	if (filters.blockedOnly) {
		where.push("a.state = ?");
		params.push("blocked");
	}
	const fetchLimit = filters.unreadOnly ? Math.max(1, Math.min((filters.limit ?? 50) * 4, 200)) : Math.max(1, Math.min(filters.limit ?? 50, 200));
	params.push(fetchLimit);
	const sql = `
SELECT a.*
FROM agents a
${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY
	CASE WHEN a.state = 'blocked' THEN 0 ELSE 1 END,
	a.updated_at DESC
LIMIT ?`;
	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	const attached = attachInboxUnread(db, rows.map(toAgentSummary), {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
	});
	const limited = filters.unreadOnly ? attached.filter((agent) => agent.unreadCount > 0) : attached;
	return limited.slice(0, Math.max(1, Math.min(filters.limit ?? 50, 200)));
}

export function getAgent(db: DatabaseSync, id: string): AgentSummary | null {
	return listAgents(db, { ids: [id], limit: 1 })[0] ?? null;
}

/** Delete a Child row and dependent registry rows. Used to roll back a failed spawn. */
export function deleteAgent(db: DatabaseSync, id: string): void {
	db.prepare("DELETE FROM artifacts WHERE agent_id = ?").run(id);
	db.prepare("DELETE FROM agent_events WHERE agent_id = ?").run(id);
	db.prepare("DELETE FROM agents WHERE id = ?").run(id);
}

export function getFleetSummary(
	db: DatabaseSync,
	filters: Pick<ListAgentsFilters, "projectKey" | "spawnSessionId" | "spawnSessionFile"> = {},
): FleetSummary {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.projectKey) {
		where.push("a.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const row = db
		.prepare(
			`SELECT
				SUM(CASE WHEN a.state IN (${makePlaceholders(ACTIVE_STATES.length)}) THEN 1 ELSE 0 END) AS active,
				SUM(CASE WHEN a.state = 'blocked' THEN 1 ELSE 0 END) AS blocked
			FROM agents a
			${whereClause}`,
		)
		.get(...ACTIVE_STATES, ...params) as { active?: number | null; blocked?: number | null } | undefined;
	const inbox = summarizeInbox(db, filters);
	return {
		active: Number(row?.active ?? 0),
		blocked: Number(row?.blocked ?? 0),
		userQuestions: inbox.userQuestions,
		unread: inbox.unread,
		attentionOpen: inbox.attentionOpen,
		attentionWaitingOnUser: inbox.attentionWaitingOnUser,
		attentionCompletions: inbox.attentionCompletions,
	};
}

