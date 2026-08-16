/**
 * Agent record store: create/update/list/get + fleet summary.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { addSessionScopeFilter, makePlaceholders, safeJsonParse } from "./sql-util.js";
import {
	ACTIVE_STATES,
	AGENT_FIELD_TO_COLUMN,
	toAgentMessageRecord,
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
		input.host?.kind ?? "",
		input.host?.primaryId ?? null,
		input.host?.displayName ?? null,
		null,
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
		assignments.push("host_kind = ?", "host_primary_id = ?", "host_display_name = ?");
		params.push(patch.host?.kind ?? null, patch.host?.primaryId ?? null, patch.host?.displayName ?? null);
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
	if (filters.unreadOnly) {
		where.push(`(
			EXISTS (
				SELECT 1
				FROM agent_message_recipients r
				JOIN agent_messages_v2 m ON m.id = r.message_id
				WHERE m.sender_agent_id = a.id
					AND r.recipient_kind IN ('root', 'user')
					AND r.status IN ('queued', 'notified')
			)
			OR EXISTS (
				SELECT 1
				FROM agent_messages unread
				WHERE unread.sender_agent_id = a.id
					AND unread.status = 'queued'
					AND unread.target_kind IN ('primary', 'user')
					AND (unread.payload_json IS NULL OR instr(unread.payload_json, '"v2MessageId"') = 0)
			)
		)`);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
	params.push(limit);
	// One latest-unread join (v2 + non-shadow legacy) instead of N correlated column subqueries.
	const sql = `
SELECT
	a.*,
	(
		COALESCE((
			SELECT COUNT(*)
			FROM agent_message_recipients r
			JOIN agent_messages_v2 m ON m.id = r.message_id
			WHERE m.sender_agent_id = a.id
				AND r.recipient_kind IN ('root', 'user')
				AND r.status IN ('queued', 'notified')
		), 0)
		+
		COALESCE((
			SELECT COUNT(*)
			FROM agent_messages legacy_unread
			WHERE legacy_unread.sender_agent_id = a.id
				AND legacy_unread.status = 'queued'
				AND legacy_unread.target_kind IN ('primary', 'user')
				AND (legacy_unread.payload_json IS NULL OR instr(legacy_unread.payload_json, '"v2MessageId"') = 0)
		), 0)
	) AS unread_count,
	latest_unread.latest_unread_id AS latest_unread_id,
	latest_unread.latest_unread_thread_id AS latest_unread_thread_id,
	latest_unread.latest_unread_sender_agent_id AS latest_unread_sender_agent_id,
	latest_unread.latest_unread_recipient_agent_id AS latest_unread_recipient_agent_id,
	latest_unread.latest_unread_target_kind AS latest_unread_target_kind,
	latest_unread.latest_unread_kind AS latest_unread_kind,
	latest_unread.latest_unread_delivery_mode AS latest_unread_delivery_mode,
	latest_unread.latest_unread_payload_json AS latest_unread_payload_json,
	latest_unread.latest_unread_status AS latest_unread_status,
	latest_unread.latest_unread_created_at AS latest_unread_created_at,
	latest_unread.latest_unread_delivered_at AS latest_unread_delivered_at,
	latest_unread.latest_unread_acked_at AS latest_unread_acked_at
FROM agents a
LEFT JOIN (
	SELECT *
	FROM (
		SELECT
			agent_id,
			id AS latest_unread_id,
			thread_id AS latest_unread_thread_id,
			sender_agent_id AS latest_unread_sender_agent_id,
			recipient_agent_id AS latest_unread_recipient_agent_id,
			target_kind AS latest_unread_target_kind,
			kind AS latest_unread_kind,
			delivery_mode AS latest_unread_delivery_mode,
			payload_json AS latest_unread_payload_json,
			status AS latest_unread_status,
			created_at AS latest_unread_created_at,
			delivered_at AS latest_unread_delivered_at,
			acked_at AS latest_unread_acked_at,
			ROW_NUMBER() OVER (PARTITION BY agent_id ORDER BY created_at DESC) AS rn
		FROM (
			SELECT
				m.sender_agent_id AS agent_id,
				r.id AS id,
				m.thread_id AS thread_id,
				m.sender_agent_id AS sender_agent_id,
				r.recipient_agent_id AS recipient_agent_id,
				CASE WHEN r.recipient_kind = 'user' THEN 'user' ELSE 'primary' END AS target_kind,
				m.kind AS kind,
				CASE
					WHEN r.delivery_mode IN ('immediate', 'steer', 'follow_up', 'idle_only') THEN r.delivery_mode
					ELSE 'follow_up'
				END AS delivery_mode,
				json_object(
					'summary', m.summary,
					'v2MessageId', m.id,
					'v2RecipientRowId', r.id,
					'payload', json(m.payload_json)
				) AS payload_json,
				CASE
					WHEN r.status = 'acked' THEN 'acked'
					WHEN r.status = 'read' THEN 'delivered'
					WHEN r.status = 'failed' THEN 'failed'
					WHEN r.status = 'expired' THEN 'expired'
					ELSE 'queued'
				END AS status,
				m.created_at AS created_at,
				r.read_at AS delivered_at,
				r.acked_at AS acked_at
			FROM agent_messages_v2 m
			JOIN agent_message_recipients r ON r.message_id = m.id
			WHERE m.sender_agent_id IS NOT NULL
				AND r.recipient_kind IN ('root', 'user')
				AND r.status IN ('queued', 'notified')
			UNION ALL
			SELECT
				m.sender_agent_id AS agent_id,
				m.id AS id,
				m.thread_id AS thread_id,
				m.sender_agent_id AS sender_agent_id,
				m.recipient_agent_id AS recipient_agent_id,
				m.target_kind AS target_kind,
				m.kind AS kind,
				m.delivery_mode AS delivery_mode,
				m.payload_json AS payload_json,
				m.status AS status,
				m.created_at AS created_at,
				m.delivered_at AS delivered_at,
				m.acked_at AS acked_at
			FROM agent_messages m
			WHERE m.status = 'queued'
				AND m.target_kind IN ('primary', 'user')
				AND (m.payload_json IS NULL OR instr(m.payload_json, '"v2MessageId"') = 0)
		) combined_unread
	) ranked_unread
	WHERE rn = 1
) latest_unread ON latest_unread.agent_id = a.id
${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY
	CASE WHEN a.state = 'blocked' THEN 0 ELSE 1 END,
	CASE WHEN unread_count > 0 THEN 0 ELSE 1 END,
	a.updated_at DESC
LIMIT ?`;
	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	return rows.map(toAgentSummary);
}

export function getAgent(db: DatabaseSync, id: string): AgentSummary | null {
	return listAgents(db, { ids: [id], limit: 1 })[0] ?? null;
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
	const attentionWhere: string[] = ["state IN ('open', 'acknowledged', 'waiting_on_coordinator', 'waiting_on_user')"];
	const attentionParams: unknown[] = [];
	if (filters.projectKey) {
		attentionWhere.push("project_key = ?");
		attentionParams.push(filters.projectKey);
	}
	addSessionScopeFilter(attentionWhere, attentionParams, filters.spawnSessionId, filters.spawnSessionFile, "attention_items");
	const attentionWhereClause = attentionWhere.length > 0 ? `WHERE ${attentionWhere.join(" AND ")}` : "";
	const attentionV2Where: string[] = ["state IN ('open', 'acknowledged', 'waiting_on_owner')"];
	const attentionV2Params: unknown[] = [];
	if (filters.projectKey) {
		attentionV2Where.push("project_key = ?");
		attentionV2Params.push(filters.projectKey);
	}
	const attentionV2WhereClause = `WHERE ${attentionV2Where.join(" AND ")}`;
	const row = db
		.prepare(
			`SELECT
				SUM(CASE WHEN a.state IN (${makePlaceholders(ACTIVE_STATES.length)}) THEN 1 ELSE 0 END) AS active,
				SUM(CASE WHEN a.state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
				SUM(CASE WHEN EXISTS (
					SELECT 1
					FROM agent_attention_items_v2 ai
					WHERE ai.subject_agent_id = a.id
						AND ai.state IN ('open', 'acknowledged', 'waiting_on_owner')
						AND ai.kind = 'question_for_user'
				) OR EXISTS (
					SELECT 1
					FROM attention_items ai
					WHERE ai.agent_id = a.id
						AND ai.state IN ('open', 'acknowledged', 'waiting_on_user')
						AND ai.kind = 'question_for_user'
						AND (ai.payload_json IS NULL OR instr(ai.payload_json, '"v2MessageId"') = 0)
				) THEN 1 ELSE 0 END) AS user_questions,
				COALESCE(SUM((
					SELECT COUNT(*)
					FROM agent_message_recipients r
					JOIN agent_messages_v2 m ON m.id = r.message_id
					WHERE m.sender_agent_id = a.id
						AND r.recipient_kind IN ('root', 'user')
						AND r.status IN ('queued', 'notified')
				) + (
					SELECT COUNT(*)
					FROM agent_messages m
					WHERE m.sender_agent_id = a.id
						AND m.status = 'queued'
						AND m.target_kind IN ('primary', 'user')
						AND (m.payload_json IS NULL OR instr(m.payload_json, '"v2MessageId"') = 0)
				)), 0) AS unread,
				(
					SELECT COUNT(*) FROM agent_attention_items_v2 ${attentionV2WhereClause}
				) + (
					SELECT COUNT(*) FROM attention_items ${attentionWhereClause}
						AND (payload_json IS NULL OR instr(payload_json, '"v2MessageId"') = 0)
				) AS attention_open,
				(
					SELECT COUNT(*) FROM agent_attention_items_v2 ${attentionV2WhereClause} AND owner_kind = 'user'
				) + (
					SELECT COUNT(*) FROM attention_items ${attentionWhereClause} AND audience = 'user'
						AND (payload_json IS NULL OR instr(payload_json, '"v2MessageId"') = 0)
				) AS attention_waiting_on_user,
				(
					SELECT COUNT(*) FROM agent_attention_items_v2 ${attentionV2WhereClause} AND kind = 'complete'
				) + (
					SELECT COUNT(*) FROM attention_items ${attentionWhereClause} AND kind = 'complete'
						AND (payload_json IS NULL OR instr(payload_json, '"v2MessageId"') = 0)
				) AS attention_completions
			FROM agents a
			${whereClause}`,
		)
		.get(
			...ACTIVE_STATES,
			...attentionV2Params,
			...attentionParams,
			...attentionV2Params,
			...attentionParams,
			...attentionV2Params,
			...attentionParams,
			...params,
		) as
		| {
				active?: number | null;
				blocked?: number | null;
				user_questions?: number | null;
				unread?: number | null;
				attention_open?: number | null;
				attention_waiting_on_user?: number | null;
				attention_completions?: number | null;
		  }
		| undefined;
	return {
		active: Number(row?.active ?? 0),
		blocked: Number(row?.blocked ?? 0),
		userQuestions: Number(row?.user_questions ?? 0),
		unread: Number(row?.unread ?? 0),
		attentionOpen: Number(row?.attention_open ?? 0),
		attentionWaitingOnUser: Number(row?.attention_waiting_on_user ?? 0),
		attentionCompletions: Number(row?.attention_completions ?? 0),
	};
}

