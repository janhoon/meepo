import type { DatabaseSync } from "node:sqlite";
import type {
	AgentMessageRecord,
	AgentState,
	AgentSummary,
	AttentionItemRecord,
	CreateAgentEventInput,
	CreateAgentInput,
	CreateAgentMessageInput,
	CreateArtifactInput,
	CreateAttentionItemInput,
	FleetSummary,
	ListAgentsFilters,
	ListAttentionItemsFilters,
	ListInboxFilters,
	UpdateAgentInput,
	UpdateAttentionItemInput,
} from "./types.js";

const ACTIVE_STATES: AgentState[] = ["launching", "running", "idle", "waiting", "blocked"];

const AGENT_FIELD_TO_COLUMN: Record<keyof UpdateAgentInput, string> = {
	parentAgentId: "parent_agent_id",
	spawnSessionId: "spawn_session_id",
	spawnSessionFile: "spawn_session_file",
	spawnCwd: "spawn_cwd",
	projectKey: "project_key",
	taskId: "task_id",
	profile: "profile",
	title: "title",
	task: "task",
	state: "state",
	transportKind: "transport_kind",
	transportState: "transport_state",
	model: "model",
	tools: "tools_json",
	bridgeSocketPath: "bridge_socket_path",
	bridgeStatusFile: "bridge_status_file",
	bridgeLogFile: "bridge_log_file",
	bridgeEventsFile: "bridge_events_file",
	bridgePid: "bridge_pid",
	bridgeConnectedAt: "bridge_connected_at",
	bridgeUpdatedAt: "bridge_updated_at",
	bridgeLastError: "bridge_last_error",
	tmuxSessionId: "tmux_session_id",
	tmuxSessionName: "tmux_session_name",
	tmuxWindowId: "tmux_window_id",
	tmuxPaneId: "tmux_pane_id",
	runDir: "run_dir",
	sessionFile: "session_file",
	lastToolName: "last_tool_name",
	lastAssistantPreview: "last_assistant_preview",
	lastError: "last_error",
	finalSummary: "final_summary",
	updatedAt: "updated_at",
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

function toAgentMessageRecord(row: Record<string, unknown> | undefined): AgentMessageRecord | null {
	if (!row || typeof row.latest_unread_id !== "string") return null;
	return {
		id: row.latest_unread_id,
		threadId: (row.latest_unread_thread_id as string) ?? "",
		senderAgentId: (row.latest_unread_sender_agent_id as string | null) ?? null,
		recipientAgentId: (row.latest_unread_recipient_agent_id as string | null) ?? null,
		targetKind: row.latest_unread_target_kind as AgentMessageRecord["targetKind"],
		kind: row.latest_unread_kind as AgentMessageRecord["kind"],
		deliveryMode: row.latest_unread_delivery_mode as AgentMessageRecord["deliveryMode"],
		payload: safeJsonParse(row.latest_unread_payload_json as string | null, null),
		status: row.latest_unread_status as AgentMessageRecord["status"],
		createdAt: Number(row.latest_unread_created_at ?? 0),
		deliveredAt: (row.latest_unread_delivered_at as number | null) ?? null,
		ackedAt: (row.latest_unread_acked_at as number | null) ?? null,
	};
}

function toAgentSummary(row: Record<string, unknown>): AgentSummary {
	const transportKind = (row.transport_kind as AgentSummary["transportKind"] | null) ?? "direct";
	return {
		id: row.id as string,
		parentAgentId: (row.parent_agent_id as string | null) ?? null,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		spawnCwd: row.spawn_cwd as string,
		projectKey: row.project_key as string,
		taskId: (row.task_id as string | null) ?? null,
		profile: row.profile as string,
		title: row.title as string,
		task: row.task as string,
		state: row.state as AgentSummary["state"],
		transportKind,
		transportState:
			(row.transport_state as AgentSummary["transportState"] | null) ??
			(transportKind === "direct" ? "legacy" : "launching"),
		model: (row.model as string | null) ?? null,
		tools: safeJsonParse(row.tools_json as string | null, null),
		bridgeSocketPath: (row.bridge_socket_path as string | null) ?? null,
		bridgeStatusFile: (row.bridge_status_file as string | null) ?? null,
		bridgeLogFile: (row.bridge_log_file as string | null) ?? null,
		bridgeEventsFile: (row.bridge_events_file as string | null) ?? null,
		bridgePid: typeof row.bridge_pid === "number" ? row.bridge_pid : row.bridge_pid == null ? null : Number(row.bridge_pid),
		bridgeConnectedAt: (row.bridge_connected_at as number | null) ?? null,
		bridgeUpdatedAt: (row.bridge_updated_at as number | null) ?? null,
		bridgeLastError: (row.bridge_last_error as string | null) ?? null,
		tmuxSessionId: (row.tmux_session_id as string | null) ?? null,
		tmuxSessionName: (row.tmux_session_name as string | null) ?? null,
		tmuxWindowId: (row.tmux_window_id as string | null) ?? null,
		tmuxPaneId: (row.tmux_pane_id as string | null) ?? null,
		runDir: row.run_dir as string,
		sessionFile: row.session_file as string,
		lastToolName: (row.last_tool_name as string | null) ?? null,
		lastAssistantPreview: (row.last_assistant_preview as string | null) ?? null,
		lastError: (row.last_error as string | null) ?? null,
		finalSummary: (row.final_summary as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		finishedAt: (row.finished_at as number | null) ?? null,
		unreadCount: Number(row.unread_count ?? 0),
		latestUnreadMessage: toAgentMessageRecord(row),
	};
}

function toMailboxRecord(row: Record<string, unknown>): AgentMessageRecord {
	return {
		id: row.id as string,
		threadId: row.thread_id as string,
		senderAgentId: (row.sender_agent_id as string | null) ?? null,
		recipientAgentId: (row.recipient_agent_id as string | null) ?? null,
		targetKind: row.target_kind as AgentMessageRecord["targetKind"],
		kind: row.kind as AgentMessageRecord["kind"],
		deliveryMode: row.delivery_mode as AgentMessageRecord["deliveryMode"],
		payload: safeJsonParse(row.payload_json as string | null, null),
		status: row.status as AgentMessageRecord["status"],
		createdAt: Number(row.created_at),
		deliveredAt: (row.delivered_at as number | null) ?? null,
		ackedAt: (row.acked_at as number | null) ?? null,
	};
}

function toAttentionItemRecord(row: Record<string, unknown>): AttentionItemRecord {
	return {
		id: row.id as string,
		messageId: (row.message_id as string | null) ?? null,
		agentId: row.agent_id as string,
		threadId: row.thread_id as string,
		projectKey: row.project_key as string,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		audience: row.audience as AttentionItemRecord["audience"],
		kind: row.kind as AttentionItemRecord["kind"],
		priority: Number(row.priority ?? 0),
		state: row.state as AttentionItemRecord["state"],
		summary: row.summary as string,
		payload: safeJsonParse(row.payload_json as string | null, null),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		resolvedAt: (row.resolved_at as number | null) ?? null,
		resolutionKind: (row.resolution_kind as string | null) ?? null,
		resolutionSummary: (row.resolution_summary as string | null) ?? null,
	};
}

function makePlaceholders(count: number): string {
	return new Array(count).fill("?").join(", ");
}

function addSessionScopeFilter(
	where: string[],
	params: unknown[],
	spawnSessionId: string | undefined,
	spawnSessionFile: string | undefined,
	alias = "a",
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

export function createAgent(db: DatabaseSync, input: CreateAgentInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT INTO agents (
			id,
			parent_agent_id,
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
			tmux_session_id,
			tmux_session_name,
			tmux_window_id,
			tmux_pane_id,
			run_dir,
			session_file,
			last_tool_name,
			last_assistant_preview,
			last_error,
			final_summary,
			created_at,
			updated_at,
			finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.parentAgentId ?? null,
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
		input.tmuxSessionId ?? null,
		input.tmuxSessionName ?? null,
		input.tmuxWindowId ?? null,
		input.tmuxPaneId ?? null,
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
	for (const [field, value] of Object.entries(patch) as Array<[keyof UpdateAgentInput, UpdateAgentInput[keyof UpdateAgentInput]]>) {
		if (value === undefined) continue;
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

export function createAgentMessage(db: DatabaseSync, input: CreateAgentMessageInput): void {
	db.prepare(
		`INSERT INTO agent_messages (
			id,
			thread_id,
			sender_agent_id,
			recipient_agent_id,
			target_kind,
			kind,
			delivery_mode,
			payload_json,
			status,
			created_at,
			delivered_at,
			acked_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.threadId,
		input.senderAgentId ?? null,
		input.recipientAgentId ?? null,
		input.targetKind,
		input.kind,
		input.deliveryMode,
		JSON.stringify(input.payload ?? null),
		input.status,
		input.createdAt ?? Date.now(),
		input.deliveredAt ?? null,
		input.ackedAt ?? null,
	);
}

export function markAgentMessages(db: DatabaseSync, ids: string[], status: AgentMessageRecord["status"]): number {
	if (ids.length === 0) return 0;
	const now = Date.now();
	const deliveredAt = status === "delivered" ? now : null;
	const ackedAt = status === "acked" ? now : null;
	const placeholders = makePlaceholders(ids.length);
	const result = db
		.prepare(
			`UPDATE agent_messages
			SET status = ?,
				delivered_at = COALESCE(?, delivered_at),
				acked_at = COALESCE(?, acked_at)
			WHERE id IN (${placeholders})`,
		)
		.run(status, deliveredAt, ackedAt, ...ids) as { changes?: number };
	return Number(result.changes ?? 0);
}

export function createAgentEvent(db: DatabaseSync, input: CreateAgentEventInput): void {
	db.prepare(
		"INSERT INTO agent_events (id, agent_id, event_type, summary, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
	).run(
		input.id,
		input.agentId,
		input.eventType,
		input.summary ?? null,
		input.payload === undefined ? null : JSON.stringify(input.payload),
		input.createdAt ?? Date.now(),
	);
}

export function createArtifact(db: DatabaseSync, input: CreateArtifactInput): void {
	db.prepare(
		`INSERT OR REPLACE INTO artifacts (id, agent_id, kind, path, label, metadata_json, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.agentId,
		input.kind,
		input.path,
		input.label ?? null,
		input.metadata === undefined ? null : JSON.stringify(input.metadata),
		input.createdAt ?? Date.now(),
	);
}

export function createAttentionItem(db: DatabaseSync, input: CreateAttentionItemInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT OR REPLACE INTO attention_items (
			id,
			message_id,
			agent_id,
			thread_id,
			project_key,
			spawn_session_id,
			spawn_session_file,
			audience,
			kind,
			priority,
			state,
			summary,
			payload_json,
			created_at,
			updated_at,
			resolved_at,
			resolution_kind,
			resolution_summary
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.messageId ?? null,
		input.agentId,
		input.threadId,
		input.projectKey,
		input.spawnSessionId ?? null,
		input.spawnSessionFile ?? null,
		input.audience,
		input.kind,
		input.priority,
		input.state,
		input.summary,
		input.payload === undefined ? null : JSON.stringify(input.payload),
		createdAt,
		updatedAt,
		input.resolvedAt ?? null,
		input.resolutionKind ?? null,
		input.resolutionSummary ?? null,
	);
}

export function updateAttentionItem(db: DatabaseSync, id: string, patch: UpdateAttentionItemInput): void {
	const assignments: string[] = [];
	const params: unknown[] = [];
	if (patch.state !== undefined) {
		assignments.push("state = ?");
		params.push(patch.state);
	}
	if (patch.priority !== undefined) {
		assignments.push("priority = ?");
		params.push(patch.priority);
	}
	if (patch.summary !== undefined) {
		assignments.push("summary = ?");
		params.push(patch.summary);
	}
	if (patch.payload !== undefined) {
		assignments.push("payload_json = ?");
		params.push(JSON.stringify(patch.payload));
	}
	if (patch.updatedAt !== undefined) {
		assignments.push("updated_at = ?");
		params.push(patch.updatedAt);
	}
	if (patch.resolvedAt !== undefined) {
		assignments.push("resolved_at = ?");
		params.push(patch.resolvedAt);
	}
	if (patch.resolutionKind !== undefined) {
		assignments.push("resolution_kind = ?");
		params.push(patch.resolutionKind);
	}
	if (patch.resolutionSummary !== undefined) {
		assignments.push("resolution_summary = ?");
		params.push(patch.resolutionSummary);
	}
	if (assignments.length === 0) return;
	params.push(id);
	db.prepare(`UPDATE attention_items SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

export function updateAttentionItemsForAgent(
	db: DatabaseSync,
	agentId: string,
	patch: UpdateAttentionItemInput,
	filters: {
		states?: AttentionItemRecord["state"][];
		kinds?: AttentionItemRecord["kind"][];
		audiences?: AttentionItemRecord["audience"][];
	} = {},
): number {
	const assignments: string[] = [];
	const params: unknown[] = [];
	if (patch.state !== undefined) {
		assignments.push("state = ?");
		params.push(patch.state);
	}
	if (patch.priority !== undefined) {
		assignments.push("priority = ?");
		params.push(patch.priority);
	}
	if (patch.summary !== undefined) {
		assignments.push("summary = ?");
		params.push(patch.summary);
	}
	if (patch.payload !== undefined) {
		assignments.push("payload_json = ?");
		params.push(JSON.stringify(patch.payload));
	}
	assignments.push("updated_at = ?");
	params.push(patch.updatedAt ?? Date.now());
	if (patch.resolvedAt !== undefined) {
		assignments.push("resolved_at = ?");
		params.push(patch.resolvedAt);
	}
	if (patch.resolutionKind !== undefined) {
		assignments.push("resolution_kind = ?");
		params.push(patch.resolutionKind);
	}
	if (patch.resolutionSummary !== undefined) {
		assignments.push("resolution_summary = ?");
		params.push(patch.resolutionSummary);
	}
	const where: string[] = ["agent_id = ?"];
	params.push(agentId);
	if (filters.states && filters.states.length > 0) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		where.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.audiences && filters.audiences.length > 0) {
		where.push(`audience IN (${makePlaceholders(filters.audiences.length)})`);
		params.push(...filters.audiences);
	}
	const result = db.prepare(`UPDATE attention_items SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`).run(...params) as {
		changes?: number;
	};
	return Number(result.changes ?? 0);
}

export function listAttentionItems(db: DatabaseSync, filters: ListAttentionItemsFilters = {}): AttentionItemRecord[] {
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.projectKey) {
		where.push("project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "attention_items");
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.states && filters.states.length > 0) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.audiences && filters.audiences.length > 0) {
		where.push(`audience IN (${makePlaceholders(filters.audiences.length)})`);
		params.push(...filters.audiences);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		where.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
	const rows = db
		.prepare(
			`SELECT *
			 FROM attention_items
			 ${whereClause}
			 ORDER BY priority ASC, updated_at DESC, created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toAttentionItemRecord);
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

	const where: string[] = [];
	const params: unknown[] = [];
	if (ids && ids.length > 0) {
		where.push(`a.id IN (${makePlaceholders(ids.length)})`);
		params.push(...ids);
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
		where.push(`EXISTS (
			SELECT 1
			FROM agent_messages unread
			WHERE unread.sender_agent_id = a.id
				AND unread.status = 'queued'
				AND unread.target_kind IN ('primary', 'user')
		)`);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
	params.push(limit);
	const sql = `
SELECT
	a.*,
	COALESCE((
		SELECT COUNT(*)
		FROM agent_messages unread_count
		WHERE unread_count.sender_agent_id = a.id
			AND unread_count.status = 'queued'
			AND unread_count.target_kind IN ('primary', 'user')
	), 0) AS unread_count,
	(
		SELECT unread.id
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_id,
	(
		SELECT unread.thread_id
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_thread_id,
	(
		SELECT unread.sender_agent_id
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_sender_agent_id,
	(
		SELECT unread.recipient_agent_id
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
		) AS latest_unread_recipient_agent_id,
	(
		SELECT unread.target_kind
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_target_kind,
	(
		SELECT unread.kind
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_kind,
	(
		SELECT unread.delivery_mode
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_delivery_mode,
	(
		SELECT unread.payload_json
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_payload_json,
	(
		SELECT unread.status
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_status,
	(
		SELECT unread.created_at
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_created_at,
	(
		SELECT unread.delivered_at
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_delivered_at,
	(
		SELECT unread.acked_at
		FROM agent_messages unread
		WHERE unread.sender_agent_id = a.id
			AND unread.status = 'queued'
			AND unread.target_kind IN ('primary', 'user')
		ORDER BY unread.created_at DESC
		LIMIT 1
	) AS latest_unread_acked_at
FROM agents a
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

export function listInboxMessages(db: DatabaseSync, filters: ListInboxFilters = {}): AgentMessageRecord[] {
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = ["m.target_kind IN ('primary', 'user')"];
	const params: unknown[] = [];
	if (!filters.includeDelivered) {
		where.push("m.status = 'queued'");
	}
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`m.sender_agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.projectKey) {
		where.push("a.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "a");
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT m.*
			 FROM agent_messages m
			 JOIN agents a ON a.id = m.sender_agent_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY m.created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toMailboxRecord);
}

export function listMessagesForRecipient(
	db: DatabaseSync,
	recipientAgentId: string,
	options: {
		targetKind?: AgentMessageRecord["targetKind"];
		includeDelivered?: boolean;
		limit?: number;
	} = {},
): AgentMessageRecord[] {
	const where: string[] = ["recipient_agent_id = ?"];
	const params: unknown[] = [recipientAgentId];
	if (options.targetKind) {
		where.push("target_kind = ?");
		params.push(options.targetKind);
	}
	if (!options.includeDelivered) {
		where.push("status = 'queued'");
	}
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT *
			 FROM agent_messages
			 WHERE ${where.join(" AND ")}
			 ORDER BY created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toMailboxRecord);
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
	const row = db
		.prepare(
			`SELECT
				SUM(CASE WHEN a.state IN (${makePlaceholders(ACTIVE_STATES.length)}) THEN 1 ELSE 0 END) AS active,
				SUM(CASE WHEN a.state = 'blocked' THEN 1 ELSE 0 END) AS blocked,
				SUM(CASE WHEN EXISTS (
					SELECT 1
					FROM attention_items ai
					WHERE ai.agent_id = a.id
						AND ai.state IN ('open', 'acknowledged', 'waiting_on_user')
						AND ai.kind = 'question_for_user'
				) THEN 1 ELSE 0 END) AS user_questions,
				COALESCE(SUM((
					SELECT COUNT(*)
					FROM agent_messages m
					WHERE m.sender_agent_id = a.id
						AND m.status = 'queued'
						AND m.target_kind IN ('primary', 'user')
				)), 0) AS unread,
				(
					SELECT COUNT(*)
					FROM attention_items
					${attentionWhereClause}
				) AS attention_open,
				(
					SELECT COUNT(*)
					FROM attention_items
					${attentionWhereClause} AND audience = 'user'
				) AS attention_waiting_on_user,
				(
					SELECT COUNT(*)
					FROM attention_items
					${attentionWhereClause} AND kind = 'complete'
				) AS attention_completions
			FROM agents a
			${whereClause}`,
		)
		.get(...ACTIVE_STATES, ...attentionParams, ...attentionParams, ...attentionParams, ...params) as
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
