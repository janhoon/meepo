/**
 * Shared mappers/constants for Meepo registry stores.
 */
import type { DatabaseSync } from "./sqlite.js";
import {
	makePlaceholders,
	safeJsonParse,
	toBoolean,
} from "./sql-util.js";
import { hostIdentityFromRecord, parseHostKind } from "./process-host.js";
import type {
	AgentAccessGrantRecord,
	AgentActiveEdgeRecord,
	AgentAttentionV2Record,
	AgentEdgeRecord,
	AgentMessageRecipientRecord,
	AgentMessageRecord,
	AgentMessageRouteRecord,
	AgentMessageV2Record,
	AgentOrgRecord,
	AgentRoleRecord,
	AgentState,
	AgentSummary,
	AgentThreadRecord,
	AttentionItemRecord,
	DownwardMessageActionPolicy,
	UpdateAgentInput,
} from "./types.js";

export const ACTIVE_STATES: AgentState[] = ["launching", "running", "idle", "waiting", "blocked"];
/** Alias used by task/health modules. */
export const ACTIVE_AGENT_STATES: AgentState[] = ACTIVE_STATES;
export const TERMINAL_AGENT_STATES: AgentState[] = ["done", "error", "stopped", "lost"];
export const OPEN_ATTENTION_STATES: AttentionItemRecord["state"][] = [
	"open",
	"acknowledged",
	"waiting_on_coordinator",
	"waiting_on_user",
];
export const OPEN_AGENT_ATTENTION_V2_STATES: AgentAttentionV2Record["state"][] = [
	"open",
	"acknowledged",
	"waiting_on_owner",
];

export const AGENT_FIELD_TO_COLUMN: Record<Exclude<keyof UpdateAgentInput, "host">, string> = {
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
	hostTargetJson: "host_target_json",
	runDir: "run_dir",
	sessionFile: "session_file",
	lastToolName: "last_tool_name",
	lastAssistantPreview: "last_assistant_preview",
	lastError: "last_error",
	finalSummary: "final_summary",
	updatedAt: "updated_at",
	finishedAt: "finished_at",
};

export function toAgentMessageRecord(row: Record<string, unknown> | undefined): AgentMessageRecord | null {
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

export function toAgentSummary(row: Record<string, unknown>): AgentSummary {
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
		host: hostIdentityFromRecord({
			hostKind: parseHostKind(row.host_kind as string | null),
			hostPrimaryId: (row.host_primary_id as string | null) ?? null,
			hostDisplayName: (row.host_display_name as string | null) ?? null,
		}),
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

export function toMailboxRecord(row: Record<string, unknown>): AgentMessageRecord {
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

export function toAttentionItemRecord(row: Record<string, unknown>): AttentionItemRecord {
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

export function toAgentAttentionV2Record(row: Record<string, unknown>): AgentAttentionV2Record {
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

export function toAgentRoleRecord(row: Record<string, unknown>): AgentRoleRecord {
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

export function toAgentOrgRecord(row: Record<string, unknown>): AgentOrgRecord {
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

export function toAgentEdgeRecord(row: Record<string, unknown>): AgentEdgeRecord {
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

export function toAgentActiveEdgeRecord(row: Record<string, unknown>): AgentActiveEdgeRecord {
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

export function toAgentAccessGrantRecord(row: Record<string, unknown>): AgentAccessGrantRecord {
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

export function toAgentThreadRecord(row: Record<string, unknown>): AgentThreadRecord {
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

export function toAgentMessageV2Record(row: Record<string, unknown>): AgentMessageV2Record {
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

export function toAgentMessageRecipientRecord(row: Record<string, unknown>): AgentMessageRecipientRecord {
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

export function toAgentMessageRouteRecord(row: Record<string, unknown>): AgentMessageRouteRecord {
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

