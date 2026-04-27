import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
	AgentAccessGrantKind,
	AgentAccessGrantRecord,
	AgentActiveEdgeRecord,
	AgentActorContext,
	AgentAttentionV2Record,
	AgentEdgeRecord,
	AgentEdgeType,
	AgentInboxMessageV2Record,
	AgentMessageActorKind,
	AgentMessageRecipientDeliveryMode,
	AgentMessageRecipientRecord,
	AgentMessageRecipientStatus,
	AgentMessageRecord,
	AgentMessageRouteRecord,
	AgentMessageTransportKind,
	AgentMessageV2Kind,
	AgentMessageV2Record,
	AgentOrgRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentRoleRecord,
	AgentState,
	AgentSummary,
	AgentSystemActorKind,
	AgentThreadKind,
	AgentThreadRecord,
	AgentThreadState,
	AgentUnreadSummaryRecord,
	AttentionItemRecord,
	CanSendMessageDecision,
	CreateAgentEventInput,
	CreateAgentInput,
	CreateAgentMessageInput,
	CreateArtifactInput,
	CreateAttentionItemInput,
	DownwardMessageActionPolicy,
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
	orgId: "org_id",
	roleKey: "role_key",
	spawnedByAgentId: "spawned_by_agent_id",
	hierarchyState: "hierarchy_state",
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
		orgId: (row.org_id as string | null) ?? null,
		roleKey: (row.role_key as string | null) ?? null,
		spawnedByAgentId: (row.spawned_by_agent_id as string | null) ?? null,
		hierarchyState: (row.hierarchy_state as AgentSummary["hierarchyState"] | null) ?? "attached",
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

function toAgentAttentionV2Record(row: Record<string, unknown>): AgentAttentionV2Record {
	return {
		id: row.id as string,
		messageId: (row.message_id as string | null) ?? null,
		recipientRowId: (row.recipient_row_id as string | null) ?? null,
		orgId: (row.org_id as string | null) ?? null,
		projectKey: row.project_key as string,
		taskId: (row.task_id as string | null) ?? null,
		subjectAgentId: (row.subject_agent_id as string | null) ?? null,
		ownerAgentId: (row.owner_agent_id as string | null) ?? null,
		ownerKind: row.owner_kind as AgentAttentionV2Record["ownerKind"],
		kind: row.kind as AgentAttentionV2Record["kind"],
		priority: Number(row.priority ?? 0),
		state: row.state as AgentAttentionV2Record["state"],
		summary: row.summary as string,
		payload: safeJsonParse(row.payload_json as string | null, null),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		resolvedAt: (row.resolved_at as number | null) ?? null,
		resolutionKind: (row.resolution_kind as string | null) ?? null,
		resolutionSummary: (row.resolution_summary as string | null) ?? null,
	};
}

function toBoolean(value: unknown, fallback = false): boolean {
	if (value === null || value === undefined) return fallback;
	return Number(value) !== 0;
}

function toAgentRoleRecord(row: Record<string, unknown>): AgentRoleRecord {
	return {
		roleKey: row.role_key as string,
		label: row.label as string,
		authorityRank: Number(row.authority_rank ?? 0),
		defaultVisibilityScope: row.default_visibility_scope as AgentRoleRecord["defaultVisibilityScope"],
		canSpawnChildren: toBoolean(row.can_spawn_children),
		canAdminOverride: toBoolean(row.can_admin_override),
		metadata: safeJsonParse(row.metadata_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
	};
}

function toAgentOrgRecord(row: Record<string, unknown>): AgentOrgRecord {
	return {
		id: row.id as string,
		projectKey: row.project_key as string,
		rootAgentId: (row.root_agent_id as string | null) ?? null,
		title: row.title as string,
		state: row.state as AgentOrgRecord["state"],
		metadata: safeJsonParse(row.metadata_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		archivedAt: (row.archived_at as number | null) ?? null,
	};
}

function toAgentEdgeRecord(row: Record<string, unknown>): AgentEdgeRecord {
	return {
		id: row.id as string,
		orgId: row.org_id as string,
		parentAgentId: row.parent_agent_id as string,
		childAgentId: row.child_agent_id as string,
		edgeType: row.edge_type as AgentEdgeRecord["edgeType"],
		rolePolicyId: (row.role_policy_id as string | null) ?? null,
		taskId: (row.task_id as string | null) ?? null,
		state: row.state as AgentEdgeRecord["state"],
		createdByAgentId: (row.created_by_agent_id as string | null) ?? null,
		createdByKind: row.created_by_kind as AgentEdgeRecord["createdByKind"],
		reason: (row.reason as string | null) ?? null,
		metadata: safeJsonParse(row.metadata_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		endedAt: (row.ended_at as number | null) ?? null,
	};
}

function toAgentActiveEdgeRecord(row: Record<string, unknown>): AgentActiveEdgeRecord {
	return {
		...toAgentEdgeRecord(row),
		allowSpawn: toBoolean(row.allow_spawn),
		allowParentToChildMessage: toBoolean(row.allow_parent_to_child_message),
		allowChildToParentMessage: toBoolean(row.allow_child_to_parent_message),
		allowParentInspectChild: toBoolean(row.allow_parent_inspect_child),
		allowChildInspectParent: toBoolean(row.allow_child_inspect_parent),
		allowParentInspectSubtree: toBoolean(row.allow_parent_inspect_subtree),
	};
}

function toAgentAccessGrantRecord(row: Record<string, unknown>): AgentAccessGrantRecord {
	return {
		id: row.id as string,
		orgId: row.org_id as string,
		granteeAgentId: row.grantee_agent_id as string,
		subjectAgentId: (row.subject_agent_id as string | null) ?? null,
		subjectTaskId: (row.subject_task_id as string | null) ?? null,
		grantKind: row.grant_kind as AgentAccessGrantRecord["grantKind"],
		grantedByAgentId: (row.granted_by_agent_id as string | null) ?? null,
		grantedByKind: row.granted_by_kind as AgentAccessGrantRecord["grantedByKind"],
		reason: (row.reason as string | null) ?? null,
		state: row.state as AgentAccessGrantRecord["state"],
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		expiresAt: (row.expires_at as number | null) ?? null,
		revokedAt: (row.revoked_at as number | null) ?? null,
	};
}

function toAgentThreadRecord(row: Record<string, unknown>): AgentThreadRecord {
	return {
		id: row.thread_id !== undefined ? (row.thread_id as string) : (row.id as string),
		orgId: (row.thread_org_id !== undefined ? row.thread_org_id : row.org_id) as string | null,
		projectKey: (row.thread_project_key !== undefined ? row.thread_project_key : row.project_key) as string,
		taskId: ((row.thread_task_id !== undefined ? row.thread_task_id : row.task_id) as string | null) ?? null,
		subjectAgentId: ((row.thread_subject_agent_id !== undefined ? row.thread_subject_agent_id : row.subject_agent_id) as string | null) ?? null,
		parentThreadId: ((row.thread_parent_thread_id !== undefined ? row.thread_parent_thread_id : row.parent_thread_id) as string | null) ?? null,
		kind: (row.thread_kind !== undefined ? row.thread_kind : row.kind) as AgentThreadRecord["kind"],
		title: (row.thread_title !== undefined ? row.thread_title : row.title) as string,
		state: (row.thread_state !== undefined ? row.thread_state : row.state) as AgentThreadRecord["state"],
		createdByAgentId: ((row.thread_created_by_agent_id !== undefined ? row.thread_created_by_agent_id : row.created_by_agent_id) as string | null) ?? null,
		createdByKind: (row.thread_created_by_kind !== undefined ? row.thread_created_by_kind : row.created_by_kind) as AgentThreadRecord["createdByKind"],
		createdAt: Number(row.thread_created_at !== undefined ? row.thread_created_at : row.created_at),
		updatedAt: Number(row.thread_updated_at !== undefined ? row.thread_updated_at : row.updated_at),
		resolvedAt: ((row.thread_resolved_at !== undefined ? row.thread_resolved_at : row.resolved_at) as number | null) ?? null,
		metadata: safeJsonParse((row.thread_metadata_json !== undefined ? row.thread_metadata_json : row.metadata_json) as string | null, null),
	};
}

function toAgentMessageV2Record(row: Record<string, unknown>): AgentMessageV2Record {
	return {
		id: row.message_id !== undefined ? (row.message_id as string) : (row.id as string),
		threadId: row.thread_id as string,
		orgId: (row.message_org_id !== undefined ? row.message_org_id : row.org_id) as string | null,
		projectKey: (row.message_project_key !== undefined ? row.message_project_key : row.project_key) as string,
		senderAgentId: ((row.message_sender_agent_id !== undefined ? row.message_sender_agent_id : row.sender_agent_id) as string | null) ?? null,
		senderKind: (row.message_sender_kind !== undefined ? row.message_sender_kind : row.sender_kind) as AgentMessageV2Record["senderKind"],
		kind: (row.message_kind !== undefined ? row.message_kind : row.kind) as AgentMessageV2Record["kind"],
		summary: (row.message_summary !== undefined ? row.message_summary : row.summary) as string,
		bodyMarkdown: ((row.message_body_markdown !== undefined ? row.message_body_markdown : row.body_markdown) as string | null) ?? null,
		payload: safeJsonParse((row.message_payload_json !== undefined ? row.message_payload_json : row.payload_json) as string | null, null),
		actionPolicy: ((row.message_action_policy !== undefined ? row.message_action_policy : row.action_policy) as DownwardMessageActionPolicy | null) ?? null,
		priority: Number(row.message_priority !== undefined ? row.message_priority : row.priority ?? 3),
		requiresResponse: toBoolean(row.message_requires_response !== undefined ? row.message_requires_response : row.requires_response),
		createdAt: Number(row.message_created_at !== undefined ? row.message_created_at : row.created_at),
		supersedesMessageId: ((row.message_supersedes_message_id !== undefined ? row.message_supersedes_message_id : row.supersedes_message_id) as string | null) ?? null,
	};
}

function toAgentMessageRecipientRecord(row: Record<string, unknown>): AgentMessageRecipientRecord {
	return {
		id: row.recipient_row_id !== undefined ? (row.recipient_row_id as string) : (row.id as string),
		messageId: (row.recipient_message_id !== undefined ? row.recipient_message_id : row.message_id) as string,
		recipientAgentId: ((row.recipient_agent_id !== undefined ? row.recipient_agent_id : null) as string | null) ?? null,
		recipientKind: row.recipient_kind as AgentMessageRecipientRecord["recipientKind"],
		deliveryMode: row.recipient_delivery_mode as AgentMessageRecipientRecord["deliveryMode"],
		status: row.recipient_status as AgentMessageRecipientRecord["status"],
		transportKind: (row.recipient_transport_kind as AgentMessageRecipientRecord["transportKind"] | null) ?? null,
		routeId: (row.recipient_route_id as string | null) ?? null,
		queuedAt: Number(row.recipient_queued_at ?? 0),
		notifiedAt: (row.recipient_notified_at as number | null) ?? null,
		readAt: (row.recipient_read_at as number | null) ?? null,
		ackedAt: (row.recipient_acked_at as number | null) ?? null,
		failedAt: (row.recipient_failed_at as number | null) ?? null,
		expiredAt: (row.recipient_expired_at as number | null) ?? null,
		failureSummary: (row.recipient_failure_summary as string | null) ?? null,
		metadata: safeJsonParse(row.recipient_metadata_json as string | null, null),
	};
}

function toAgentMessageRouteRecord(row: Record<string, unknown>): AgentMessageRouteRecord {
	return {
		id: row.id as string,
		messageId: row.message_id as string,
		orgId: (row.org_id as string | null) ?? null,
		fromAgentId: (row.from_agent_id as string | null) ?? null,
		toAgentId: (row.to_agent_id as string | null) ?? null,
		fromKind: row.from_kind as AgentMessageRouteRecord["fromKind"],
		toKind: row.to_kind as AgentMessageRouteRecord["toKind"],
		routeKind: row.route_kind as AgentMessageRouteRecord["routeKind"],
		edgeId: (row.edge_id as string | null) ?? null,
		policyId: (row.policy_id as string | null) ?? null,
		grantId: (row.grant_id as string | null) ?? null,
		decision: row.decision as AgentMessageRouteRecord["decision"],
		decisionReason: row.decision_reason as string,
		createdAt: Number(row.created_at ?? 0),
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

export function markAgentMessageRecipientsByMessageIds(
	db: DatabaseSync,
	messageIds: string[],
	status: AgentMessageRecipientStatus,
	options: { recipientAgentId?: string | null; transportKind?: AgentMessageTransportKind | null } = {},
): number {
	if (messageIds.length === 0) return 0;
	const now = Date.now();
	const placeholders = makePlaceholders(messageIds.length);
	const assignments = [
		"status = ?",
		"transport_kind = COALESCE(?, transport_kind)",
		"notified_at = COALESCE(notified_at, ?)",
		"read_at = COALESCE(read_at, ?)",
		"acked_at = COALESCE(acked_at, ?)",
	];
	const params: unknown[] = [
		status,
		options.transportKind ?? null,
		["notified", "read", "acked"].includes(status) ? now : null,
		["read", "acked"].includes(status) ? now : null,
		status === "acked" ? now : null,
		...messageIds,
	];
	const where = [`message_id IN (${placeholders})`];
	if (options.recipientAgentId !== undefined) {
		if (options.recipientAgentId === null) {
			where.push("recipient_agent_id IS NULL");
		} else {
			where.push("recipient_agent_id = ?");
			params.push(options.recipientAgentId);
		}
	}
	const result = db.prepare(`UPDATE agent_message_recipients SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`).run(...params) as { changes?: number };
	return Number(result.changes ?? 0);
}

export function markAgentMessageRecipientsByIds(
	db: DatabaseSync,
	recipientRowIds: string[],
	status: AgentMessageRecipientStatus,
	options: { recipientAgentId?: string | null; transportKind?: AgentMessageTransportKind | null } = {},
): number {
	if (recipientRowIds.length === 0) return 0;
	const now = Date.now();
	const placeholders = makePlaceholders(recipientRowIds.length);
	const assignments = [
		"status = ?",
		"transport_kind = COALESCE(?, transport_kind)",
		"notified_at = COALESCE(notified_at, ?)",
		"read_at = COALESCE(read_at, ?)",
		"acked_at = COALESCE(acked_at, ?)",
	];
	const params: unknown[] = [
		status,
		options.transportKind ?? null,
		["notified", "read", "acked"].includes(status) ? now : null,
		["read", "acked"].includes(status) ? now : null,
		status === "acked" ? now : null,
		...recipientRowIds,
	];
	const where = [`id IN (${placeholders})`];
	if (options.recipientAgentId !== undefined) {
		if (options.recipientAgentId === null) {
			where.push("recipient_agent_id IS NULL");
		} else {
			where.push("recipient_agent_id = ?");
			params.push(options.recipientAgentId);
		}
	}
	const result = db.prepare(`UPDATE agent_message_recipients SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`).run(...params) as { changes?: number };
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

export function createAgentAttentionItemV2(db: DatabaseSync, input: CreateAgentAttentionItemV2Input): AgentAttentionV2Record {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	const record: AgentAttentionV2Record = {
		id: input.id ?? randomUUID(),
		messageId: input.messageId ?? null,
		recipientRowId: input.recipientRowId ?? null,
		orgId: input.orgId ?? null,
		projectKey: input.projectKey,
		taskId: input.taskId ?? null,
		subjectAgentId: input.subjectAgentId ?? null,
		ownerAgentId: input.ownerKind === "agent" ? input.ownerAgentId ?? null : null,
		ownerKind: input.ownerKind,
		kind: input.kind,
		priority: input.priority,
		state: input.state ?? "waiting_on_owner",
		summary: input.summary,
		payload: input.payload ?? null,
		createdAt,
		updatedAt,
		resolvedAt: input.resolvedAt ?? null,
		resolutionKind: input.resolutionKind ?? null,
		resolutionSummary: input.resolutionSummary ?? null,
	};
	if (record.ownerKind === "agent" && !record.ownerAgentId) {
		throw new Error("createAgentAttentionItemV2 requires ownerAgentId when ownerKind is agent.");
	}
	db.prepare(
		`INSERT INTO agent_attention_items_v2 (
			id, message_id, recipient_row_id, org_id, project_key, task_id, subject_agent_id,
			owner_agent_id, owner_kind, kind, priority, state, summary, payload_json,
			created_at, updated_at, resolved_at, resolution_kind, resolution_summary
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		record.id,
		record.messageId,
		record.recipientRowId,
		record.orgId,
		record.projectKey,
		record.taskId,
		record.subjectAgentId,
		record.ownerAgentId,
		record.ownerKind,
		record.kind,
		record.priority,
		record.state,
		record.summary,
		record.payload === undefined ? null : JSON.stringify(record.payload),
		record.createdAt,
		record.updatedAt,
		record.resolvedAt,
		record.resolutionKind,
		record.resolutionSummary,
	);
	return record;
}

export function listAgentAttentionItemsV2(db: DatabaseSync, filters: ListAgentAttentionItemsV2Filters = {}): AgentAttentionV2Record[] {
	if (filters.ownerAgentIds && filters.ownerAgentIds.length === 0) return [];
	if (filters.subjectAgentIds && filters.subjectAgentIds.length === 0) return [];
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.projectKey) {
		where.push("project_key = ?");
		params.push(filters.projectKey);
	}
	if (filters.ownerKind) {
		where.push("owner_kind = ?");
		params.push(filters.ownerKind);
	}
	if (filters.ownerKinds && filters.ownerKinds.length > 0) {
		where.push(`owner_kind IN (${makePlaceholders(filters.ownerKinds.length)})`);
		params.push(...filters.ownerKinds);
	}
	if (filters.ownerAgentId !== undefined) {
		if (filters.ownerAgentId === null) {
			where.push("owner_agent_id IS NULL");
		} else {
			where.push("owner_agent_id = ?");
			params.push(filters.ownerAgentId);
		}
	}
	if (filters.ownerAgentIds && filters.ownerAgentIds.length > 0) {
		where.push(`owner_agent_id IN (${makePlaceholders(filters.ownerAgentIds.length)})`);
		params.push(...filters.ownerAgentIds);
	}
	if (filters.subjectAgentIds && filters.subjectAgentIds.length > 0) {
		where.push(`subject_agent_id IN (${makePlaceholders(filters.subjectAgentIds.length)})`);
		params.push(...filters.subjectAgentIds);
	}
	if (filters.states && filters.states.length > 0) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
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
			 FROM agent_attention_items_v2
			 ${whereClause}
			 ORDER BY priority ASC, updated_at DESC, created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toAgentAttentionV2Record);
}

export function updateAgentAttentionItemsV2ForOwner(
	db: DatabaseSync,
	owner: AgentRecipientRef,
	patch: UpdateAgentAttentionItemsV2Patch,
	filters: Pick<ListAgentAttentionItemsV2Filters, "states" | "kinds" | "subjectAgentIds"> = {},
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
	if (assignments.length === 0) return 0;
	const where: string[] = ["owner_kind = ?"];
	params.push(owner.kind);
	if (owner.kind === "agent") {
		where.push("owner_agent_id = ?");
		params.push(owner.agentId);
	} else {
		where.push("owner_agent_id IS NULL");
	}
	if (filters.states && filters.states.length > 0) {
		where.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		where.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.subjectAgentIds && filters.subjectAgentIds.length > 0) {
		where.push(`subject_agent_id IN (${makePlaceholders(filters.subjectAgentIds.length)})`);
		params.push(...filters.subjectAgentIds);
	}
	const result = db.prepare(`UPDATE agent_attention_items_v2 SET ${assignments.join(", ")} WHERE ${where.join(" AND ")}`).run(...params) as { changes?: number };
	return Number(result.changes ?? 0);
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

export interface ResolveAgentActorContextInput {
	currentAgentId?: string | null;
	root?: boolean;
	projectKey?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
}

export interface ListHierarchyVisibleAgentIdsOptions {
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	includeArchived?: boolean;
}

export interface GetActiveAgentEdgeInput {
	parentAgentId: string;
	childAgentId: string;
	edgeType?: AgentEdgeType;
	orgId?: string | null;
}

export interface ListActiveAgentEdgesInput {
	parentAgentId?: string;
	childAgentId?: string;
	edgeType?: AgentEdgeType;
	orgId?: string | null;
	limit?: number;
}

export interface GetActiveAgentAccessGrantInput {
	granteeAgentId: string;
	grantKind: AgentAccessGrantKind | AgentAccessGrantKind[];
	orgId?: string | null;
	subjectAgentId?: string | null;
	subjectTaskId?: string | null;
	now?: number;
}

export interface CanSendMessageInput {
	actor: AgentActorContext;
	recipient: AgentRecipientRef;
	messageKind?: AgentMessageV2Kind;
	now?: number;
}

export interface CreateAgentMessageRouteInput {
	id?: string;
	messageId: string;
	orgId?: string | null;
	fromAgentId?: string | null;
	toAgentId?: string | null;
	fromKind: AgentMessageActorKind;
	toKind: AgentRecipientKind;
	routeKind: CanSendMessageDecision["routeKind"];
	edgeId?: string | null;
	policyId?: string | null;
	grantId?: string | null;
	decision: "allowed" | "denied";
	decisionReason: string;
	createdAt?: number;
}

export type CreateAgentMessageRecipientV2Input = AgentRecipientRef & {
	id?: string;
	deliveryMode?: AgentMessageRecipientDeliveryMode;
	status?: AgentMessageRecipientStatus;
	transportKind?: AgentMessageTransportKind | null;
	metadata?: unknown;
};

export interface CreateAgentMessageThreadV2Input {
	id?: string;
	kind?: AgentThreadKind;
	title?: string;
	state?: AgentThreadState;
	parentThreadId?: string | null;
	metadata?: unknown;
}

export interface CreateAgentMessageWithRecipientsInput {
	actor: AgentActorContext;
	recipients: CreateAgentMessageRecipientV2Input[];
	messageId?: string;
	threadId?: string;
	thread?: CreateAgentMessageThreadV2Input;
	orgId?: string | null;
	projectKey?: string;
	taskId?: string | null;
	subjectAgentId?: string | null;
	kind: AgentMessageV2Kind;
	summary: string;
	bodyMarkdown?: string | null;
	payload?: unknown;
	actionPolicy?: DownwardMessageActionPolicy | null;
	priority?: number;
	requiresResponse?: boolean;
	supersedesMessageId?: string | null;
	createdAt?: number;
	skipPermissionCheck?: boolean;
}

export interface CreateAgentMessageWithRecipientsResult {
	thread: AgentThreadRecord;
	message: AgentMessageV2Record;
	recipients: AgentMessageRecipientRecord[];
	routes: AgentMessageRouteRecord[];
}

export interface FetchAgentInboxV2Input {
	actor: AgentActorContext;
	recipient?: AgentRecipientRef;
	includeRead?: boolean;
	markRead?: boolean;
	statuses?: AgentMessageRecipientStatus[];
	projectKey?: string;
	threadId?: string;
	limit?: number;
}

export interface CreateAgentAttentionItemV2Input {
	id?: string;
	messageId?: string | null;
	recipientRowId?: string | null;
	orgId?: string | null;
	projectKey: string;
	taskId?: string | null;
	subjectAgentId?: string | null;
	ownerAgentId?: string | null;
	ownerKind: AgentRecipientKind;
	kind: AgentAttentionV2Record["kind"];
	priority: number;
	state?: AgentAttentionV2Record["state"];
	summary: string;
	payload?: unknown;
	createdAt?: number;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface ListAgentAttentionItemsV2Filters {
	projectKey?: string;
	ownerKind?: AgentRecipientKind;
	ownerKinds?: AgentRecipientKind[];
	ownerAgentId?: string | null;
	ownerAgentIds?: string[];
	subjectAgentIds?: string[];
	states?: AgentAttentionV2Record["state"][];
	kinds?: AgentAttentionV2Record["kind"][];
	limit?: number;
}

export interface UpdateAgentAttentionItemsV2Patch {
	state?: AgentAttentionV2Record["state"];
	priority?: number;
	summary?: string;
	payload?: unknown;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface AgentMessageRecipientUnreadSummaryFilters {
	recipientKind?: AgentRecipientKind;
	agentIds?: string[];
	projectKey?: string;
	limit?: number;
}

export interface UpsertAgentOrgInput {
	id: string;
	projectKey: string;
	rootAgentId?: string | null;
	title: string;
	state?: AgentOrgRecord["state"];
	metadata?: unknown;
	createdAt?: number;
	updatedAt?: number;
	archivedAt?: number | null;
}

export interface CreateAgentHierarchyEdgeInput {
	id?: string;
	orgId?: string | null;
	parentAgentId: string;
	childAgentId: string;
	edgeType?: AgentEdgeType;
	rolePolicyId?: string | null;
	allowPolicyless?: boolean;
	taskId?: string | null;
	createdByAgentId?: string | null;
	createdByKind?: AgentSystemActorKind;
	reason?: string | null;
	metadata?: unknown;
	createdAt?: number;
	updatedAt?: number;
}

export class AgentMessagePermissionError extends Error {
	messageId: string;
	decisions: CanSendMessageDecision[];

	constructor(messageId: string, decisions: CanSendMessageDecision[]) {
		super(`Message ${messageId} denied for ${decisions.length} recipient${decisions.length === 1 ? "" : "s"}.`);
		this.name = "AgentMessagePermissionError";
		this.messageId = messageId;
		this.decisions = decisions;
	}
}

function normalizeRecipient(recipient: AgentRecipientRef): { kind: AgentRecipientKind; agentId: string | null } {
	return {
		kind: recipient.kind,
		agentId: recipient.kind === "agent" ? recipient.agentId : null,
	};
}

function getAgentScopeRow(
	db: DatabaseSync,
	agentId: string,
): { id: string; orgId: string | null; projectKey: string; roleKey: string | null; spawnSessionId: string | null; spawnSessionFile: string | null } | null {
	const row = db
		.prepare(
			`SELECT id, org_id, project_key, role_key, spawn_session_id, spawn_session_file
			 FROM agents
			 WHERE id = ?`,
		)
		.get(agentId) as
		| {
				id: string;
				org_id: string | null;
				project_key: string;
				role_key: string | null;
				spawn_session_id: string | null;
				spawn_session_file: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		id: row.id,
		orgId: row.org_id ?? null,
		projectKey: row.project_key,
		roleKey: row.role_key ?? null,
		spawnSessionId: row.spawn_session_id ?? null,
		spawnSessionFile: row.spawn_session_file ?? null,
	};
}

function runImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = callback();
		db.exec("COMMIT;");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Ignore rollback errors so the original error is preserved.
		}
		throw error;
	}
}

export function createRootActorContext(scope: Omit<ResolveAgentActorContextInput, "currentAgentId" | "root"> = {}): AgentActorContext {
	return {
		kind: "root",
		agentId: null,
		projectKey: scope.projectKey ?? null,
		spawnSessionId: scope.spawnSessionId ?? null,
		spawnSessionFile: scope.spawnSessionFile ?? null,
		defaultVisibilityScope: "root",
		canAdminOverride: true,
	};
}

export function getAgentRole(db: DatabaseSync, roleKey: string): AgentRoleRecord | null {
	const row = db.prepare("SELECT * FROM agent_roles WHERE role_key = ?").get(roleKey) as Record<string, unknown> | undefined;
	return row ? toAgentRoleRecord(row) : null;
}

export function getAgentOrg(db: DatabaseSync, orgId: string): AgentOrgRecord | null {
	const row = db.prepare("SELECT * FROM agent_orgs WHERE id = ?").get(orgId) as Record<string, unknown> | undefined;
	return row ? toAgentOrgRecord(row) : null;
}

export function getAgentActorContext(db: DatabaseSync, agentId: string): AgentActorContext | null {
	const row = db
		.prepare(
			`SELECT
				a.id,
				a.org_id,
				a.role_key,
				a.project_key,
				a.spawn_session_id,
				a.spawn_session_file,
				r.default_visibility_scope,
				r.can_spawn_children,
				r.can_admin_override
			 FROM agents a
			 LEFT JOIN agent_roles r ON r.role_key = a.role_key
			 WHERE a.id = ?`,
		)
		.get(agentId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		kind: "agent",
		agentId: row.id as string,
		orgId: (row.org_id as string | null) ?? null,
		roleKey: (row.role_key as string | null) ?? null,
		projectKey: row.project_key as string,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		defaultVisibilityScope: (row.default_visibility_scope as AgentActorContext["defaultVisibilityScope"] | null) ?? null,
		canSpawnChildren: toBoolean(row.can_spawn_children),
		canAdminOverride: toBoolean(row.can_admin_override),
	};
}

export function resolveAgentActorContext(db: DatabaseSync, input: ResolveAgentActorContextInput = {}): AgentActorContext {
	if (input.currentAgentId) {
		const actor = getAgentActorContext(db, input.currentAgentId);
		if (!actor) throw new Error(`Unknown current agent id "${input.currentAgentId}".`);
		return actor;
	}
	return createRootActorContext(input);
}

function addIdsFromRows(ids: Set<string>, rows: Array<{ id: string }>): void {
	for (const row of rows) ids.add(row.id);
}

function filterAgentIdsByScope(db: DatabaseSync, ids: Set<string>, options: ListHierarchyVisibleAgentIdsOptions): string[] {
	if (ids.size === 0) return [];
	const idList = [...ids];
	const where = [`a.id IN (${makePlaceholders(idList.length)})`];
	const params: unknown[] = [...idList];
	if (options.projectKey) {
		where.push("a.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile, "a");
	if (!options.includeArchived) {
		where.push("COALESCE(a.hierarchy_state, 'attached') <> 'archived'");
	}
	const rows = db
		.prepare(
			`SELECT a.id
			 FROM agents a
			 WHERE ${where.join(" AND ")}
			 ORDER BY a.updated_at DESC, a.id ASC`,
		)
		.all(...params) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

export function listHierarchyVisibleAgentIds(
	db: DatabaseSync,
	actor: AgentActorContext,
	options: ListHierarchyVisibleAgentIdsOptions = {},
): string[] {
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) {
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.projectKey ?? actor.projectKey) {
			where.push("a.project_key = ?");
			params.push(options.projectKey ?? actor.projectKey);
		}
		addSessionScopeFilter(
			where,
			params,
			options.spawnSessionId ?? actor.spawnSessionId ?? undefined,
			options.spawnSessionFile ?? actor.spawnSessionFile ?? undefined,
			"a",
		);
		if (!options.includeArchived) {
			where.push("COALESCE(a.hierarchy_state, 'attached') <> 'archived'");
		}
		const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const rows = db
			.prepare(
				`SELECT a.id
				 FROM agents a
				 ${whereClause}
				 ORDER BY a.updated_at DESC, a.id ASC`,
			)
			.all(...params) as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	const ids = new Set<string>([actor.agentId]);
	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT e.parent_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.child_agent_id = ?
					AND e.state = 'active'
					AND p.allow_child_inspect_parent = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);
	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT e.child_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.parent_agent_id = ?
					AND e.state = 'active'
					AND p.allow_parent_inspect_child = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);

	if (actor.defaultVisibilityScope === "project") {
		addIdsFromRows(
			ids,
			db.prepare("SELECT id FROM agents WHERE project_key = ?").all(actor.projectKey) as Array<{ id: string }>,
		);
	} else if (actor.defaultVisibilityScope === "subtree" || actor.defaultVisibilityScope === "root") {
		addIdsFromRows(
			ids,
			db
				.prepare(
					`SELECT descendant_agent_id AS id
					 FROM agent_hierarchy_closure
					 WHERE ancestor_agent_id = ?
						AND (? IS NULL OR org_id = ?)`,
				)
				.all(actor.agentId, actor.orgId, actor.orgId) as Array<{ id: string }>,
		);
	}

	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT c.descendant_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_hierarchy_closure c
					ON c.org_id = e.org_id
					AND c.ancestor_agent_id = e.child_agent_id
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.parent_agent_id = ?
					AND e.state = 'active'
					AND p.allow_parent_inspect_subtree = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);

	const now = Date.now();
	const grantRows = db
		.prepare(
			`SELECT *
			 FROM agent_access_grants
			 WHERE grantee_agent_id = ?
				AND state = 'active'
				AND grant_kind IN ('inspect_agent', 'inspect_subtree', 'inspect_task')
				AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.all(actor.agentId, now) as Array<Record<string, unknown>>;
	for (const row of grantRows) {
		const grant = toAgentAccessGrantRecord(row);
		if (grant.subjectAgentId && (grant.grantKind === "inspect_agent" || grant.grantKind === "inspect_subtree")) {
			ids.add(grant.subjectAgentId);
		}
		if (grant.subjectAgentId && grant.grantKind === "inspect_subtree") {
			addIdsFromRows(
				ids,
				db
					.prepare(
						`SELECT descendant_agent_id AS id
						 FROM agent_hierarchy_closure
						 WHERE org_id = ? AND ancestor_agent_id = ?`,
					)
					.all(grant.orgId, grant.subjectAgentId) as Array<{ id: string }>,
			);
		}
		if (grant.subjectTaskId) {
			addIdsFromRows(
				ids,
				db.prepare("SELECT id FROM agents WHERE task_id = ?").all(grant.subjectTaskId) as Array<{ id: string }>,
			);
		}
	}

	return filterAgentIdsByScope(db, ids, options);
}

export function listActiveAgentEdges(db: DatabaseSync, input: ListActiveAgentEdgesInput = {}): AgentActiveEdgeRecord[] {
	const where: string[] = ["e.state = 'active'"];
	const params: unknown[] = [];
	if (input.parentAgentId) {
		where.push("e.parent_agent_id = ?");
		params.push(input.parentAgentId);
	}
	if (input.childAgentId) {
		where.push("e.child_agent_id = ?");
		params.push(input.childAgentId);
	}
	if (input.edgeType) {
		where.push("e.edge_type = ?");
		params.push(input.edgeType);
	}
	if (input.orgId) {
		where.push("e.org_id = ?");
		params.push(input.orgId);
	}
	const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				e.*,
				p.allow_spawn,
				p.allow_parent_to_child_message,
				p.allow_child_to_parent_message,
				p.allow_parent_inspect_child,
				p.allow_child_inspect_parent,
				p.allow_parent_inspect_subtree
			 FROM agent_edges e
			 LEFT JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY CASE e.edge_type WHEN 'reports_to' THEN 0 ELSE 1 END, e.updated_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toAgentActiveEdgeRecord);
}

export function getActiveAgentEdge(db: DatabaseSync, input: GetActiveAgentEdgeInput): AgentActiveEdgeRecord | null {
	return listActiveAgentEdges(db, { ...input, limit: 1 })[0] ?? null;
}

export function getActiveAgentAccessGrant(db: DatabaseSync, input: GetActiveAgentAccessGrantInput): AgentAccessGrantRecord | null {
	const grantKinds = Array.isArray(input.grantKind) ? input.grantKind : [input.grantKind];
	if (grantKinds.length === 0) return null;
	const where: string[] = [
		"grantee_agent_id = ?",
		`grant_kind IN (${makePlaceholders(grantKinds.length)})`,
		"state = 'active'",
		"(expires_at IS NULL OR expires_at > ?)",
	];
	const params: unknown[] = [input.granteeAgentId, ...grantKinds, input.now ?? Date.now()];
	if (input.orgId) {
		where.push("org_id = ?");
		params.push(input.orgId);
	}
	if (input.subjectAgentId !== undefined) {
		where.push("subject_agent_id IS ?");
		params.push(input.subjectAgentId);
	}
	if (input.subjectTaskId !== undefined) {
		where.push("subject_task_id IS ?");
		params.push(input.subjectTaskId);
	}
	const row = db
		.prepare(
			`SELECT *
			 FROM agent_access_grants
			 WHERE ${where.join(" AND ")}
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT 1`,
		)
		.get(...params) as Record<string, unknown> | undefined;
	return row ? toAgentAccessGrantRecord(row) : null;
}

function makeCanSendDecision(input: {
	allowed: boolean;
	actor: AgentActorContext;
	recipient: AgentRecipientRef;
	routeKind: CanSendMessageDecision["routeKind"];
	reason: string;
	orgId?: string | null;
	edgeId?: string | null;
	policyId?: string | null;
	grantId?: string | null;
}): CanSendMessageDecision {
	const recipient = normalizeRecipient(input.recipient);
	return {
		allowed: input.allowed,
		fromKind: input.actor.kind === "root" ? "root" : "agent",
		toKind: recipient.kind,
		fromAgentId: input.actor.kind === "agent" ? input.actor.agentId : null,
		toAgentId: recipient.agentId,
		orgId: input.orgId ?? (input.actor.kind === "agent" ? input.actor.orgId : null),
		routeKind: input.routeKind,
		edgeId: input.edgeId ?? null,
		policyId: input.policyId ?? null,
		grantId: input.grantId ?? null,
		decisionReason: input.reason,
	};
}

export function canSendMessage(db: DatabaseSync, input: CanSendMessageInput): CanSendMessageDecision {
	const { actor, recipient } = input;
	const now = input.now ?? Date.now();
	const recipientScope = recipient.kind === "agent" ? getAgentScopeRow(db, recipient.agentId) : null;
	if (recipient.kind === "agent" && !recipientScope) {
		return makeCanSendDecision({
			allowed: false,
			actor,
			recipient,
			routeKind: "multi_hop",
			reason: `Unknown recipient agent id "${recipient.agentId}".`,
		});
	}
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) {
		return makeCanSendDecision({
			allowed: true,
			actor,
			recipient,
			routeKind: "root_override",
			orgId: recipientScope?.orgId ?? (actor.kind === "agent" ? actor.orgId : null),
			reason: "Root/admin override allows this route.",
		});
	}
	if (recipient.kind === "user") {
		return makeCanSendDecision({
			allowed: input.messageKind === "question_for_user",
			actor,
			recipient,
			routeKind: "user_escalation",
			reason:
				input.messageKind === "question_for_user"
					? "question_for_user messages may route to the user."
					: "Only question_for_user messages may route to the user.",
		});
	}
	if (recipient.kind === "root") {
		const parentEdge = listActiveAgentEdges(db, { childAgentId: actor.agentId, edgeType: "reports_to", limit: 1 })[0] ?? null;
		return makeCanSendDecision({
			allowed: parentEdge === null,
			actor,
			recipient,
			routeKind: parentEdge === null ? "user_escalation" : "multi_hop",
			reason:
				parentEdge === null
					? "Agent has no active parent edge; root may own the escalation."
					: "Agent has an active parent edge; route messages to the direct parent unless root uses override.",
		});
	}
	if (recipient.agentId === actor.agentId) {
		return makeCanSendDecision({
			allowed: false,
			actor,
			recipient,
			routeKind: "multi_hop",
			orgId: actor.orgId,
			reason: "Agents cannot send hierarchy messages to themselves.",
		});
	}

	let directDeniedDecision: CanSendMessageDecision | null = null;
	const directDown = getActiveAgentEdge(db, {
		parentAgentId: actor.agentId,
		childAgentId: recipient.agentId,
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
	});
	if (directDown) {
		const decision = makeCanSendDecision({
			allowed: directDown.allowParentToChildMessage,
			actor,
			recipient,
			routeKind: "direct_child",
			orgId: directDown.orgId,
			edgeId: directDown.id,
			policyId: directDown.rolePolicyId,
			reason: !directDown.rolePolicyId
				? "Active direct child edge has no matching role policy; policyless edges deny parent-to-child messaging."
				: directDown.allowParentToChildMessage
					? "Active direct child edge policy allows parent-to-child messaging."
					: "Active direct child edge policy denies parent-to-child messaging.",
		});
		if (decision.allowed) return decision;
		directDeniedDecision = decision;
	}
	const directUp = getActiveAgentEdge(db, {
		parentAgentId: recipient.agentId,
		childAgentId: actor.agentId,
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
	});
	if (directUp) {
		const decision = makeCanSendDecision({
			allowed: directUp.allowChildToParentMessage,
			actor,
			recipient,
			routeKind: "direct_parent",
			orgId: directUp.orgId,
			edgeId: directUp.id,
			policyId: directUp.rolePolicyId,
			reason: !directUp.rolePolicyId
				? "Active direct parent edge has no matching role policy; policyless edges deny child-to-parent messaging."
				: directUp.allowChildToParentMessage
					? "Active direct parent edge policy allows child-to-parent messaging."
					: "Active direct parent edge policy denies child-to-parent messaging.",
		});
		if (decision.allowed) return decision;
		directDeniedDecision ??= decision;
	}
	const grant = getActiveAgentAccessGrant(db, {
		granteeAgentId: actor.agentId,
		grantKind: "message_agent",
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
		subjectAgentId: recipient.agentId,
		now,
	});
	if (grant) {
		return makeCanSendDecision({
			allowed: true,
			actor,
			recipient,
			routeKind: "explicit_grant",
			orgId: grant.orgId,
			grantId: grant.id,
			reason: "Active explicit message_agent grant allows this route.",
		});
	}
	return directDeniedDecision ?? makeCanSendDecision({
		allowed: false,
		actor,
		recipient,
		routeKind: "multi_hop",
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
		reason: "No active direct hierarchy edge or message_agent grant allows this route.",
	});
}

export function createAgentMessageRoute(db: DatabaseSync, input: CreateAgentMessageRouteInput): AgentMessageRouteRecord {
	const record: AgentMessageRouteRecord = {
		id: input.id ?? randomUUID(),
		messageId: input.messageId,
		orgId: input.orgId ?? null,
		fromAgentId: input.fromAgentId ?? null,
		toAgentId: input.toAgentId ?? null,
		fromKind: input.fromKind,
		toKind: input.toKind,
		routeKind: input.routeKind,
		edgeId: input.edgeId ?? null,
		policyId: input.policyId ?? null,
		grantId: input.grantId ?? null,
		decision: input.decision,
		decisionReason: input.decisionReason,
		createdAt: input.createdAt ?? Date.now(),
	};
	db.prepare(
		`INSERT INTO agent_message_routes (
			id, message_id, org_id, from_agent_id, to_agent_id, from_kind, to_kind,
			route_kind, edge_id, policy_id, grant_id, decision, decision_reason, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		record.id,
		record.messageId,
		record.orgId,
		record.fromAgentId,
		record.toAgentId,
		record.fromKind,
		record.toKind,
		record.routeKind,
		record.edgeId,
		record.policyId,
		record.grantId,
		record.decision,
		record.decisionReason,
		record.createdAt,
	);
	return record;
}

export function createAgentMessageRouteAudit(db: DatabaseSync, messageId: string, decision: CanSendMessageDecision, createdAt = Date.now()): AgentMessageRouteRecord {
	return createAgentMessageRoute(db, {
		messageId,
		orgId: decision.orgId,
		fromAgentId: decision.fromAgentId,
		toAgentId: decision.toAgentId,
		fromKind: decision.fromKind,
		toKind: decision.toKind,
		routeKind: decision.routeKind,
		edgeId: decision.edgeId,
		policyId: decision.policyId,
		grantId: decision.grantId,
		decision: decision.allowed ? "allowed" : "denied",
		decisionReason: decision.decisionReason,
		createdAt,
	});
}

function resolveMessageScope(db: DatabaseSync, input: CreateAgentMessageWithRecipientsInput): { orgId: string | null; projectKey: string; subjectAgentId: string | null } {
	const firstAgentRecipient = input.recipients.find((recipient) => recipient.kind === "agent") as CreateAgentMessageRecipientV2Input | undefined;
	const firstRecipientScope = firstAgentRecipient?.kind === "agent" ? getAgentScopeRow(db, firstAgentRecipient.agentId) : null;
	const orgId = input.orgId ?? (input.actor.kind === "agent" ? input.actor.orgId : null) ?? firstRecipientScope?.orgId ?? null;
	const projectKey = input.projectKey ?? (input.actor.kind === "agent" ? input.actor.projectKey : null) ?? firstRecipientScope?.projectKey;
	if (!projectKey) throw new Error("createMessageWithRecipients requires projectKey when neither actor nor recipients provide one.");
	return {
		orgId,
		projectKey,
		subjectAgentId: input.subjectAgentId ?? (input.actor.kind === "agent" ? input.actor.agentId : firstRecipientScope?.id ?? null),
	};
}

function makeSkippedPermissionDecision(actor: AgentActorContext, recipient: AgentRecipientRef, orgId: string | null): CanSendMessageDecision {
	return makeCanSendDecision({
		allowed: true,
		actor,
		recipient,
		routeKind: "root_override",
		orgId,
		reason: "Permission check skipped by trusted registry caller.",
	});
}

export function createMessageWithRecipients(
	db: DatabaseSync,
	input: CreateAgentMessageWithRecipientsInput,
): CreateAgentMessageWithRecipientsResult {
	if (input.recipients.length === 0) throw new Error("createMessageWithRecipients requires at least one recipient.");
	const createdAt = input.createdAt ?? Date.now();
	const messageId = input.messageId ?? randomUUID();
	const threadId = input.thread?.id ?? input.threadId ?? randomUUID();
	const scope = resolveMessageScope(db, input);
	const threadRecord: AgentThreadRecord = {
		id: threadId,
		orgId: scope.orgId,
		projectKey: scope.projectKey,
		taskId: input.taskId ?? null,
		subjectAgentId: scope.subjectAgentId,
		parentThreadId: input.thread?.parentThreadId ?? null,
		kind: input.thread?.kind ?? "task_update",
		title: input.thread?.title ?? input.summary,
		state: input.thread?.state ?? "open",
		createdByAgentId: input.actor.kind === "agent" ? input.actor.agentId : null,
		createdByKind: input.actor.kind === "root" ? "root" : "agent",
		createdAt,
		updatedAt: createdAt,
		resolvedAt: null,
		metadata: input.thread?.metadata ?? null,
	};
	const messageRecord: AgentMessageV2Record = {
		id: messageId,
		threadId,
		orgId: scope.orgId,
		projectKey: scope.projectKey,
		senderAgentId: input.actor.kind === "agent" ? input.actor.agentId : null,
		senderKind: input.actor.kind === "root" ? "root" : "agent",
		kind: input.kind,
		summary: input.summary,
		bodyMarkdown: input.bodyMarkdown ?? null,
		payload: input.payload ?? null,
		actionPolicy: input.actionPolicy ?? null,
		priority: input.priority ?? 3,
		requiresResponse: input.requiresResponse ?? false,
		createdAt,
		supersedesMessageId: input.supersedesMessageId ?? null,
	};
	const decisions = input.recipients.map((recipient) =>
		input.skipPermissionCheck ? makeSkippedPermissionDecision(input.actor, recipient, scope.orgId) : canSendMessage(db, { actor: input.actor, recipient, messageKind: input.kind, now: createdAt }),
	);
	const denied = decisions.filter((decision) => !decision.allowed);
	const routeInputs = decisions.map((decision) => ({ id: randomUUID(), decision }));
	const recipientRecords = input.recipients.map((recipient, index): AgentMessageRecipientRecord => ({
		id: recipient.id ?? randomUUID(),
		messageId,
		recipientAgentId: recipient.kind === "agent" ? recipient.agentId : null,
		recipientKind: recipient.kind,
		deliveryMode: recipient.deliveryMode ?? "inbox_only",
		status: recipient.status ?? "queued",
		transportKind: recipient.transportKind ?? null,
		routeId: routeInputs[index]!.id,
		queuedAt: createdAt,
		notifiedAt: null,
		readAt: null,
		ackedAt: null,
		failedAt: null,
		expiredAt: null,
		failureSummary: null,
		metadata: recipient.metadata ?? null,
	}));
	const routes: AgentMessageRouteRecord[] = [];

	db.exec("BEGIN IMMEDIATE;");
	try {
		db.prepare(
			`INSERT OR IGNORE INTO agent_threads (
				id, org_id, project_key, task_id, subject_agent_id, parent_thread_id, kind, title,
				state, created_by_agent_id, created_by_kind, created_at, updated_at, resolved_at, metadata_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			threadRecord.id,
			threadRecord.orgId,
			threadRecord.projectKey,
			threadRecord.taskId,
			threadRecord.subjectAgentId,
			threadRecord.parentThreadId,
			threadRecord.kind,
			threadRecord.title,
			threadRecord.state,
			threadRecord.createdByAgentId,
			threadRecord.createdByKind,
			threadRecord.createdAt,
			threadRecord.updatedAt,
			threadRecord.resolvedAt,
			threadRecord.metadata === undefined ? null : JSON.stringify(threadRecord.metadata),
		);
		db.prepare(
			`INSERT INTO agent_messages_v2 (
				id, thread_id, org_id, project_key, sender_agent_id, sender_kind, kind, summary,
				body_markdown, payload_json, action_policy, priority, requires_response, created_at, supersedes_message_id
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).run(
			messageRecord.id,
			messageRecord.threadId,
			messageRecord.orgId,
			messageRecord.projectKey,
			messageRecord.senderAgentId,
			messageRecord.senderKind,
			messageRecord.kind,
			messageRecord.summary,
			messageRecord.bodyMarkdown,
			messageRecord.payload === undefined ? null : JSON.stringify(messageRecord.payload),
			messageRecord.actionPolicy,
			messageRecord.priority,
			messageRecord.requiresResponse ? 1 : 0,
			messageRecord.createdAt,
			messageRecord.supersedesMessageId,
		);
		for (const routeInput of routeInputs) {
			routes.push(createAgentMessageRoute(db, {
				id: routeInput.id,
				messageId,
				orgId: routeInput.decision.orgId,
				fromAgentId: routeInput.decision.fromAgentId,
				toAgentId: routeInput.decision.toAgentId,
				fromKind: routeInput.decision.fromKind,
				toKind: routeInput.decision.toKind,
				routeKind: routeInput.decision.routeKind,
				edgeId: routeInput.decision.edgeId,
				policyId: routeInput.decision.policyId,
				grantId: routeInput.decision.grantId,
				decision: routeInput.decision.allowed ? "allowed" : "denied",
				decisionReason: routeInput.decision.decisionReason,
				createdAt,
			}));
		}
		if (denied.length === 0) {
			for (const recipient of recipientRecords) {
				db.prepare(
					`INSERT INTO agent_message_recipients (
						id, message_id, recipient_agent_id, recipient_kind, delivery_mode, status, transport_kind,
						route_id, queued_at, notified_at, read_at, acked_at, failed_at, expired_at, failure_summary, metadata_json
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					recipient.id,
					recipient.messageId,
					recipient.recipientAgentId,
					recipient.recipientKind,
					recipient.deliveryMode,
					recipient.status,
					recipient.transportKind,
					recipient.routeId,
					recipient.queuedAt,
					recipient.notifiedAt,
					recipient.readAt,
					recipient.ackedAt,
					recipient.failedAt,
					recipient.expiredAt,
					recipient.failureSummary,
					recipient.metadata === undefined ? null : JSON.stringify(recipient.metadata),
				);
			}
		}
		db.exec("COMMIT;");
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Ignore rollback errors so the original error is preserved.
		}
		throw error;
	}
	if (denied.length > 0) throw new AgentMessagePermissionError(messageId, denied);
	return { thread: threadRecord, message: messageRecord, recipients: recipientRecords, routes };
}

function resolveInboxRecipient(actor: AgentActorContext, recipient: AgentRecipientRef | undefined): AgentRecipientRef {
	const resolved = recipient ?? (actor.kind === "root" ? { kind: "root" as const } : { kind: "agent" as const, agentId: actor.agentId });
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) return resolved;
	if (resolved.kind === "agent" && resolved.agentId === actor.agentId) return resolved;
	throw new Error("Agent inbox fetch is limited to the current recipient unless the actor has admin override.");
}

function buildInboxWhere(input: FetchAgentInboxV2Input, recipient: AgentRecipientRef): { where: string[]; params: unknown[] } {
	const normalized = normalizeRecipient(recipient);
	const where: string[] = ["r.recipient_kind = ?"];
	const params: unknown[] = [normalized.kind];
	if (normalized.kind === "agent") {
		where.push("r.recipient_agent_id = ?");
		params.push(normalized.agentId);
	} else {
		where.push("r.recipient_agent_id IS NULL");
	}
	if (input.threadId) {
		where.push("m.thread_id = ?");
		params.push(input.threadId);
	}
	if (input.projectKey) {
		where.push("m.project_key = ?");
		params.push(input.projectKey);
	}
	const statuses = input.statuses ?? (input.includeRead ? null : (["queued", "notified"] as AgentMessageRecipientStatus[]));
	if (statuses && statuses.length > 0) {
		where.push(`r.status IN (${makePlaceholders(statuses.length)})`);
		params.push(...statuses);
	}
	return { where, params };
}

function selectInboxRows(db: DatabaseSync, input: FetchAgentInboxV2Input, recipient: AgentRecipientRef): AgentInboxMessageV2Record[] {
	const { where, params } = buildInboxWhere(input, recipient);
	const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				m.id AS message_id,
				m.thread_id,
				m.org_id AS message_org_id,
				m.project_key AS message_project_key,
				m.sender_agent_id AS message_sender_agent_id,
				m.sender_kind AS message_sender_kind,
				m.kind AS message_kind,
				m.summary AS message_summary,
				m.body_markdown AS message_body_markdown,
				m.payload_json AS message_payload_json,
				m.action_policy AS message_action_policy,
				m.priority AS message_priority,
				m.requires_response AS message_requires_response,
				m.created_at AS message_created_at,
				m.supersedes_message_id AS message_supersedes_message_id,
				r.id AS recipient_row_id,
				r.message_id AS recipient_message_id,
				r.recipient_agent_id,
				r.recipient_kind,
				r.delivery_mode AS recipient_delivery_mode,
				r.status AS recipient_status,
				r.transport_kind AS recipient_transport_kind,
				r.route_id AS recipient_route_id,
				r.queued_at AS recipient_queued_at,
				r.notified_at AS recipient_notified_at,
				r.read_at AS recipient_read_at,
				r.acked_at AS recipient_acked_at,
				r.failed_at AS recipient_failed_at,
				r.expired_at AS recipient_expired_at,
				r.failure_summary AS recipient_failure_summary,
				r.metadata_json AS recipient_metadata_json,
				t.org_id AS thread_org_id,
				t.project_key AS thread_project_key,
				t.task_id AS thread_task_id,
				t.subject_agent_id AS thread_subject_agent_id,
				t.parent_thread_id AS thread_parent_thread_id,
				t.kind AS thread_kind,
				t.title AS thread_title,
				t.state AS thread_state,
				t.created_by_agent_id AS thread_created_by_agent_id,
				t.created_by_kind AS thread_created_by_kind,
				t.created_at AS thread_created_at,
				t.updated_at AS thread_updated_at,
				t.resolved_at AS thread_resolved_at,
				t.metadata_json AS thread_metadata_json
			 FROM agent_message_recipients r
			 JOIN agent_messages_v2 m ON m.id = r.message_id
			 LEFT JOIN agent_threads t ON t.id = m.thread_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY r.queued_at ASC, m.created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		message: toAgentMessageV2Record(row),
		recipient: toAgentMessageRecipientRecord(row),
		thread: row.thread_kind === null || row.thread_kind === undefined ? null : toAgentThreadRecord(row),
	}));
}

export function fetchAgentInboxV2(db: DatabaseSync, input: FetchAgentInboxV2Input): AgentInboxMessageV2Record[] {
	const recipient = resolveInboxRecipient(input.actor, input.recipient);
	const markRead = input.markRead ?? !input.includeRead;
	if (!markRead) return selectInboxRows(db, input, recipient);
	const now = Date.now();
	return runImmediateTransaction(db, () => {
		const rows = selectInboxRows(db, input, recipient);
		const unreadRecipientIds = rows
			.filter((row) => row.recipient.status === "queued" || row.recipient.status === "notified")
			.map((row) => row.recipient.id);
		if (unreadRecipientIds.length > 0) {
			db.prepare(
				`UPDATE agent_message_recipients
				 SET status = 'read', read_at = ?
				 WHERE id IN (${makePlaceholders(unreadRecipientIds.length)})
					AND status IN ('queued', 'notified')`,
			).run(now, ...unreadRecipientIds);
			for (const row of rows) {
				if (unreadRecipientIds.includes(row.recipient.id)) {
					row.recipient.status = "read";
					row.recipient.readAt = now;
				}
			}
		}
		return rows;
	});
}

export function listAgentMessageHistoryV2(
	db: DatabaseSync,
	input: Omit<FetchAgentInboxV2Input, "includeRead" | "markRead">,
): AgentInboxMessageV2Record[] {
	return fetchAgentInboxV2(db, { ...input, includeRead: true, markRead: false });
}

export function getAgentMessageRecipientUnreadSummary(
	db: DatabaseSync,
	filters: AgentMessageRecipientUnreadSummaryFilters = {},
): AgentUnreadSummaryRecord[] {
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = ["r.status IN ('queued', 'notified')"];
	const params: unknown[] = [];
	if (filters.recipientKind) {
		where.push("r.recipient_kind = ?");
		params.push(filters.recipientKind);
	}
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`r.recipient_agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.projectKey) {
		where.push("m.project_key = ?");
		params.push(filters.projectKey);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 500, 1000));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				r.recipient_kind,
				r.recipient_agent_id,
				COUNT(*) AS unread_count,
				MAX(r.queued_at) AS latest_queued_at
			 FROM agent_message_recipients r
			 JOIN agent_messages_v2 m ON m.id = r.message_id
			 WHERE ${where.join(" AND ")}
			 GROUP BY r.recipient_kind, r.recipient_agent_id
			 ORDER BY unread_count DESC, latest_queued_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map((row) => ({
		recipientKind: row.recipient_kind as AgentRecipientKind,
		recipientAgentId: (row.recipient_agent_id as string | null) ?? null,
		unreadCount: Number(row.unread_count ?? 0),
		latestQueuedAt: (row.latest_queued_at as number | null) ?? null,
	}));
}

export function upsertAgentOrg(db: DatabaseSync, input: UpsertAgentOrgInput): AgentOrgRecord {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT INTO agent_orgs (id, project_key, root_agent_id, title, state, metadata_json, created_at, updated_at, archived_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			project_key = excluded.project_key,
			root_agent_id = excluded.root_agent_id,
			title = excluded.title,
			state = excluded.state,
			metadata_json = excluded.metadata_json,
			updated_at = excluded.updated_at,
			archived_at = excluded.archived_at`,
	).run(
		input.id,
		input.projectKey,
		input.rootAgentId ?? null,
		input.title,
		input.state ?? "active",
		input.metadata === undefined ? null : JSON.stringify(input.metadata),
		createdAt,
		updatedAt,
		input.archivedAt ?? null,
	);
	const org = getAgentOrg(db, input.id);
	if (!org) throw new Error(`Failed to upsert agent org "${input.id}".`);
	return org;
}

export function ensureAgentHierarchySelfClosure(db: DatabaseSync, orgId: string, agentId: string, createdAt = Date.now()): void {
	db.prepare(
		`INSERT OR IGNORE INTO agent_hierarchy_closure
			(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
		 VALUES (?, ?, ?, 0, NULL, ?)`,
	).run(orgId, agentId, agentId, createdAt);
}

export function wouldCreateHierarchyCycle(
	db: DatabaseSync,
	input: { orgId: string; parentAgentId: string; childAgentId: string },
): boolean {
	if (input.parentAgentId === input.childAgentId) return true;
	const row = db
		.prepare(
			`SELECT 1 AS found
			 FROM agent_hierarchy_closure
			 WHERE org_id = ?
				AND ancestor_agent_id = ?
				AND descendant_agent_id = ?
			 LIMIT 1`,
		)
		.get(input.orgId, input.childAgentId, input.parentAgentId) as { found: number } | undefined;
	if (row) return true;
	const recursiveRow = db
		.prepare(
			`WITH RECURSIVE descendants(agent_id, path) AS (
				SELECT
					edges.child_agent_id,
					'|' || edges.child_agent_id || '|'
				FROM agent_edges edges
				WHERE edges.org_id = ?
					AND edges.parent_agent_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
				UNION ALL
				SELECT
					edges.child_agent_id,
					descendants.path || edges.child_agent_id || '|'
				FROM agent_edges edges
				JOIN descendants ON descendants.agent_id = edges.parent_agent_id
				WHERE edges.org_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
					AND instr(descendants.path, '|' || edges.child_agent_id || '|') = 0
			)
			SELECT 1 AS found
			FROM descendants
			WHERE agent_id = ?
			LIMIT 1`,
		)
		.get(input.orgId, input.childAgentId, input.orgId, input.parentAgentId) as { found: number } | undefined;
	return !!recursiveRow;
}

function getRolePolicyIdForAgents(db: DatabaseSync, parentAgentId: string, childAgentId: string, edgeType: AgentEdgeType): string | null {
	const row = db
		.prepare(
			`SELECT p.id
			 FROM agents parent
			 JOIN agents child ON child.id = ?
			 JOIN agent_role_edge_policies p
				ON p.parent_role_key = parent.role_key
				AND p.child_role_key = child.role_key
				AND p.edge_type = ?
			 WHERE parent.id = ?
			 LIMIT 1`,
		)
		.get(childAgentId, edgeType, parentAgentId) as { id: string } | undefined;
	return row?.id ?? null;
}

function isRolePolicyIdAllowedForAgents(db: DatabaseSync, rolePolicyId: string, parentAgentId: string, childAgentId: string, edgeType: AgentEdgeType): boolean {
	const row = db
		.prepare(
			`SELECT 1 AS found
			 FROM agents parent
			 JOIN agents child ON child.id = ?
			 JOIN agent_role_edge_policies p
				ON p.id = ?
				AND p.parent_role_key = parent.role_key
				AND p.child_role_key = child.role_key
				AND p.edge_type = ?
			 WHERE parent.id = ?
			 LIMIT 1`,
		)
		.get(childAgentId, rolePolicyId, edgeType, parentAgentId) as { found: number } | undefined;
	return !!row;
}

function getAgentEdgeById(db: DatabaseSync, edgeId: string): AgentEdgeRecord | null {
	const row = db.prepare("SELECT * FROM agent_edges WHERE id = ?").get(edgeId) as Record<string, unknown> | undefined;
	return row ? toAgentEdgeRecord(row) : null;
}

function insertClosureRowsForEdge(db: DatabaseSync, edge: AgentEdgeRecord, createdAt: number): void {
	if (edge.edgeType !== "reports_to" || edge.state !== "active") return;
	ensureAgentHierarchySelfClosure(db, edge.orgId, edge.parentAgentId, createdAt);
	ensureAgentHierarchySelfClosure(db, edge.orgId, edge.childAgentId, createdAt);
	db.prepare(
		`INSERT INTO agent_hierarchy_closure
			(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
		 SELECT
			?,
			ancestors.ancestor_agent_id,
			descendants.descendant_agent_id,
			ancestors.depth + descendants.depth + 1,
			?,
			?
		 FROM agent_hierarchy_closure ancestors
		 CROSS JOIN agent_hierarchy_closure descendants
		 WHERE ancestors.org_id = ?
			AND descendants.org_id = ?
			AND ancestors.descendant_agent_id = ?
			AND descendants.ancestor_agent_id = ?
		 ON CONFLICT(org_id, ancestor_agent_id, descendant_agent_id) DO UPDATE SET
			depth = CASE
				WHEN excluded.depth < agent_hierarchy_closure.depth THEN excluded.depth
				ELSE agent_hierarchy_closure.depth
			END,
			through_edge_id = CASE
				WHEN excluded.depth <= agent_hierarchy_closure.depth THEN excluded.through_edge_id
				ELSE agent_hierarchy_closure.through_edge_id
			END`,
	).run(edge.orgId, edge.id, createdAt, edge.orgId, edge.orgId, edge.parentAgentId, edge.childAgentId);
}

export function createAgentHierarchyEdge(db: DatabaseSync, input: CreateAgentHierarchyEdgeInput): AgentEdgeRecord {
	const edgeType = input.edgeType ?? "reports_to";
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	return runImmediateTransaction(db, () => {
		const parent = getAgentScopeRow(db, input.parentAgentId);
		const child = getAgentScopeRow(db, input.childAgentId);
		if (!parent) throw new Error(`Unknown parent agent id "${input.parentAgentId}".`);
		if (!child) throw new Error(`Unknown child agent id "${input.childAgentId}".`);
		const orgId = input.orgId ?? parent.orgId ?? child.orgId;
		if (!orgId) throw new Error("createAgentHierarchyEdge requires orgId when neither agent is attached to an org.");
		if (parent.orgId && parent.orgId !== orgId) throw new Error(`Parent agent "${parent.id}" belongs to org "${parent.orgId}", not "${orgId}".`);
		if (child.orgId && child.orgId !== orgId) throw new Error(`Child agent "${child.id}" belongs to org "${child.orgId}", not "${orgId}".`);
		if (edgeType === "reports_to" && wouldCreateHierarchyCycle(db, { orgId, parentAgentId: parent.id, childAgentId: child.id })) {
			throw new Error(`Refusing to create ${edgeType} edge ${parent.id} -> ${child.id} because it would create a hierarchy cycle.`);
		}
		if (!parent.orgId) updateAgent(db, parent.id, { orgId, updatedAt });
		if (!child.orgId) updateAgent(db, child.id, { orgId, updatedAt });
		const edgeId = input.id ?? `edge:${edgeType}:${parent.id}:${child.id}`;
		const rolePolicyId = input.rolePolicyId === undefined ? getRolePolicyIdForAgents(db, parent.id, child.id, edgeType) : input.rolePolicyId;
		if (rolePolicyId && !isRolePolicyIdAllowedForAgents(db, rolePolicyId, parent.id, child.id, edgeType)) {
			throw new Error(`Refusing to create active ${edgeType} edge ${parent.id} -> ${child.id} with mismatched role policy "${rolePolicyId}".`);
		}
		if (!rolePolicyId && !input.allowPolicyless) {
			throw new Error(
				`Refusing to create active ${edgeType} edge ${parent.id} -> ${child.id} without an agent_role_edge_policies row; pass allowPolicyless for an explicit audited override.`,
			);
		}
		const reason = input.reason ?? (!rolePolicyId ? "Policyless active edge created by explicit registry override." : null);
		db.prepare(
			`INSERT INTO agent_edges (
				id, org_id, parent_agent_id, child_agent_id, edge_type, role_policy_id, task_id, state,
				created_by_agent_id, created_by_kind, reason, metadata_json, created_at, updated_at, ended_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
		).run(
			edgeId,
			orgId,
			parent.id,
			child.id,
			edgeType,
			rolePolicyId,
			input.taskId ?? null,
			input.createdByAgentId ?? null,
			input.createdByKind ?? "system",
			reason,
			input.metadata === undefined ? null : JSON.stringify(input.metadata),
			createdAt,
			updatedAt,
		);
		if (edgeType === "reports_to") {
			updateAgent(db, child.id, {
				parentAgentId: parent.id,
				orgId,
				spawnedByAgentId: input.createdByAgentId ?? parent.id,
				hierarchyState: "attached",
				updatedAt,
			});
		}
		const edge = getAgentEdgeById(db, edgeId);
		if (!edge) throw new Error(`Failed to create agent edge "${edgeId}".`);
		insertClosureRowsForEdge(db, edge, createdAt);
		return edge;
	});
}

export function rebuildAgentHierarchyClosure(db: DatabaseSync, orgId: string, createdAt = Date.now()): number {
	return runImmediateTransaction(db, () => {
		db.prepare("DELETE FROM agent_hierarchy_closure WHERE org_id = ?").run(orgId);
		db.prepare(
			`INSERT OR IGNORE INTO agent_hierarchy_closure
				(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
			 SELECT org_id, id, id, 0, NULL, ?
			 FROM agents
			 WHERE org_id = ?`,
		).run(createdAt, orgId);
		db.prepare(
			`WITH RECURSIVE hierarchy_paths(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, path) AS (
				SELECT
					edges.org_id,
					edges.parent_agent_id,
					edges.child_agent_id,
					1,
					edges.id,
					'|' || edges.parent_agent_id || '|' || edges.child_agent_id || '|'
				FROM agent_edges edges
				WHERE edges.org_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
				UNION ALL
				SELECT
					hierarchy_paths.org_id,
					hierarchy_paths.ancestor_agent_id,
					edges.child_agent_id,
					hierarchy_paths.depth + 1,
					edges.id,
					hierarchy_paths.path || edges.child_agent_id || '|'
				FROM hierarchy_paths
				JOIN agent_edges edges
					ON edges.org_id = hierarchy_paths.org_id
					AND edges.parent_agent_id = hierarchy_paths.descendant_agent_id
				WHERE edges.state = 'active'
					AND edges.edge_type = 'reports_to'
					AND instr(hierarchy_paths.path, '|' || edges.child_agent_id || '|') = 0
			)
			INSERT OR IGNORE INTO agent_hierarchy_closure
				(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
			SELECT
				org_id,
				ancestor_agent_id,
				descendant_agent_id,
				MIN(depth),
				MIN(through_edge_id),
				?
			FROM hierarchy_paths
			GROUP BY org_id, ancestor_agent_id, descendant_agent_id`,
		).run(orgId, createdAt);
		const row = db
			.prepare("SELECT COUNT(*) AS count FROM agent_hierarchy_closure WHERE org_id = ?")
			.get(orgId) as { count: number } | undefined;
		return Number(row?.count ?? 0);
	});
}
