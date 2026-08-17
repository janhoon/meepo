/**
 * Messaging + attention store (legacy delivery queue + v2 hierarchy messages).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { deliveryMessageFromInboxV2, mergeDeliveryMessages } from "./message-adapters.js";
import {
	addSessionScopeFilter,
	makePlaceholders,
	runImmediateTransaction,
	safeJsonParse,
	toBoolean,
} from "./sql-util.js";
import {
	toAgentAttentionV2Record,
	toAgentMessageRecipientRecord,
	toAgentMessageRouteRecord,
	toAgentMessageV2Record,
	toAgentThreadRecord,
	toAttentionItemRecord,
	toMailboxRecord,
} from "./registry-shared.js";
import type {
	AgentAttentionV2Record,
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentMessageRecipientRecord,
	AgentMessageRecipientStatus,
	AgentMessageRouteRecord,
	AgentMessageTransportKind,
	AgentMessageV2Record,
	AgentRecipientRef,
	AgentThreadRecord,
	AttentionItemRecord,
	CreateAgentEventInput,
	CreateAgentMessageInput,
	CreateArtifactInput,
	CreateAttentionItemInput,
	ListAttentionItemsFilters,
	ListInboxFilters,
	UpdateAttentionItemInput,
} from "./types.js";

import type {
	CreateAgentAttentionItemV2Input,
	ListAgentAttentionItemsV2Filters,
	UpdateAgentAttentionItemsV2Patch,
	FetchAgentInboxV2Input,
	AgentMessageRecipientUnreadSummaryFilters,
} from "./registry-types.js";

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

type AttentionPatch = {
	state?: string;
	priority?: number;
	summary?: string;
	payload?: unknown;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
};

function applyAttentionUpdate(
	db: DatabaseSync,
	table: "attention_items" | "agent_attention_items_v2",
	patch: AttentionPatch,
	where: { clauses: string[]; params: unknown[] },
	options: { alwaysTouchUpdatedAt?: boolean } = {},
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
	} else if (options.alwaysTouchUpdatedAt) {
		assignments.push("updated_at = ?");
		params.push(Date.now());
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
	params.push(...where.params);
	const result = db.prepare(`UPDATE ${table} SET ${assignments.join(", ")} WHERE ${where.clauses.join(" AND ")}`).run(...params) as { changes?: number };
	return Number(result.changes ?? 0);
}

export function updateAttentionItem(
	db: DatabaseSync,
	id: string,
	patch: UpdateAttentionItemInput,
	filters: { states?: AttentionItemRecord["state"][]; taskId?: string } = {},
): number {
	const clauses = ["id = ?"];
	const params: unknown[] = [id];
	if (filters.states && filters.states.length > 0) {
		clauses.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.taskId) {
		clauses.push("agent_id IN (SELECT id FROM agents WHERE task_id = ?)");
		params.push(filters.taskId);
	}
	return applyAttentionUpdate(db, "attention_items", patch, { clauses, params });
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
	const clauses = ["agent_id = ?"];
	const params: unknown[] = [agentId];
	if (filters.states && filters.states.length > 0) {
		clauses.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		clauses.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.audiences && filters.audiences.length > 0) {
		clauses.push(`audience IN (${makePlaceholders(filters.audiences.length)})`);
		params.push(...filters.audiences);
	}
	return applyAttentionUpdate(db, "attention_items", patch, { clauses, params }, { alwaysTouchUpdatedAt: true });
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
	if (filters.taskIds && filters.taskIds.length === 0) return [];
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
	if (filters.taskIds && filters.taskIds.length > 0) {
		where.push(`task_id IN (${makePlaceholders(filters.taskIds.length)})`);
		params.push(...filters.taskIds);
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
	const clauses = ["owner_kind = ?"];
	const params: unknown[] = [owner.kind];
	if (owner.kind === "agent") {
		clauses.push("owner_agent_id = ?");
		params.push(owner.agentId);
	} else {
		clauses.push("owner_agent_id IS NULL");
	}
	if (filters.states && filters.states.length > 0) {
		clauses.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		clauses.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	if (filters.subjectAgentIds && filters.subjectAgentIds.length > 0) {
		clauses.push(`subject_agent_id IN (${makePlaceholders(filters.subjectAgentIds.length)})`);
		params.push(...filters.subjectAgentIds);
	}
	return applyAttentionUpdate(db, "agent_attention_items_v2", patch, { clauses, params });
}

export function updateAgentAttentionItemV2(
	db: DatabaseSync,
	id: string,
	patch: UpdateAgentAttentionItemsV2Patch,
	filters: { states?: AgentAttentionV2Record["state"][]; taskId?: string } = {},
): number {
	const clauses = ["id = ?"];
	const params: unknown[] = [id];
	if (filters.states && filters.states.length > 0) {
		clauses.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.taskId) {
		clauses.push("(task_id = ? OR subject_agent_id IN (SELECT id FROM agents WHERE task_id = ?))");
		params.push(filters.taskId, filters.taskId);
	}
	return applyAttentionUpdate(db, "agent_attention_items_v2", patch, { clauses, params });
}

export function updateAgentAttentionItemsV2ForSubject(
	db: DatabaseSync,
	subjectAgentId: string,
	patch: UpdateAgentAttentionItemsV2Patch,
	filters: Pick<ListAgentAttentionItemsV2Filters, "states" | "kinds"> = {},
): number {
	const clauses = ["subject_agent_id = ?"];
	const params: unknown[] = [subjectAgentId];
	if (filters.states && filters.states.length > 0) {
		clauses.push(`state IN (${makePlaceholders(filters.states.length)})`);
		params.push(...filters.states);
	}
	if (filters.kinds && filters.kinds.length > 0) {
		clauses.push(`kind IN (${makePlaceholders(filters.kinds.length)})`);
		params.push(...filters.kinds);
	}
	return applyAttentionUpdate(db, "agent_attention_items_v2", patch, { clauses, params });
}

function listLegacyInboxMessages(db: DatabaseSync, filters: ListInboxFilters = {}): AgentMessageRecord[] {
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = ["m.target_kind IN ('primary', 'user')"];
	const params: unknown[] = [];
	if (!filters.includeDelivered) {
		where.push("m.status = 'queued'");
	}
	// Skip dual-write shadows; v2 is canonical for new publishes.
	where.push("(m.payload_json IS NULL OR instr(m.payload_json, '\"v2MessageId\"') = 0)");
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

const V2_INBOX_SELECT = `
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
	NULL AS thread_kind
`;

function mapV2DeliveryRows(rows: Array<Record<string, unknown>>): AgentMessageRecord[] {
	return rows.map((row) =>
		deliveryMessageFromInboxV2({
			message: toAgentMessageV2Record(row),
			recipient: toAgentMessageRecipientRecord(row),
			thread: null,
		}),
	);
}

function listV2CoordinatorInboxMessages(db: DatabaseSync, filters: ListInboxFilters = {}): AgentMessageRecord[] {
	if (filters.agentIds && filters.agentIds.length === 0) return [];
	const where: string[] = ["r.recipient_kind IN ('root', 'user')"];
	const params: unknown[] = [];
	if (!filters.includeDelivered) {
		where.push("r.status IN ('queued', 'notified')");
	}
	if (filters.agentIds && filters.agentIds.length > 0) {
		where.push(`m.sender_agent_id IN (${makePlaceholders(filters.agentIds.length)})`);
		params.push(...filters.agentIds);
	}
	if (filters.projectKey) {
		where.push("m.project_key = ?");
		params.push(filters.projectKey);
	}
	if (filters.spawnSessionId || filters.spawnSessionFile) {
		where.push("m.sender_agent_id IS NOT NULL");
		addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile, "a");
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT ${V2_INBOX_SELECT}
			 FROM agent_message_recipients r
			 JOIN agent_messages_v2 m ON m.id = r.message_id
			 LEFT JOIN agents a ON a.id = m.sender_agent_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY m.created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return mapV2DeliveryRows(rows);
}

/** Coordinator inbox: v2 canonical + legacy read-compat (non-shadow rows only). */
export function listInboxMessages(db: DatabaseSync, filters: ListInboxFilters = {}): AgentMessageRecord[] {
	const limit = Math.max(1, Math.min(filters.limit ?? 100, 500));
	const v2 = listV2CoordinatorInboxMessages(db, { ...filters, limit });
	const legacy = listLegacyInboxMessages(db, { ...filters, limit });
	return mergeDeliveryMessages(v2, legacy).slice(0, limit);
}

function listLegacyMessagesForRecipient(
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
	// Prefer v2 for dual-written rows; keep pure-legacy delivery queue rows (downward).
	// Downward messages never carry v2MessageId today, so they remain visible.
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

function listV2MessagesForAgentRecipient(
	db: DatabaseSync,
	recipientAgentId: string,
	options: { includeDelivered?: boolean; limit?: number } = {},
): AgentMessageRecord[] {
	const where: string[] = ["r.recipient_kind = 'agent'", "r.recipient_agent_id = ?"];
	const params: unknown[] = [recipientAgentId];
	if (!options.includeDelivered) {
		where.push("r.status IN ('queued', 'notified')");
	}
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT ${V2_INBOX_SELECT}
			 FROM agent_message_recipients r
			 JOIN agent_messages_v2 m ON m.id = r.message_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY m.created_at ASC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return mapV2DeliveryRows(rows);
}

/**
 * Delivery queue for an agent recipient.
 * v2 is canonical for new agent-targeted publishes; legacy rows remain for downward control-plane
 * and pre-migration data. Dual-write shadows are suppressed when a live v2 row exists.
 */
export function listMessagesForRecipient(
	db: DatabaseSync,
	recipientAgentId: string,
	options: {
		targetKind?: AgentMessageRecord["targetKind"];
		includeDelivered?: boolean;
		limit?: number;
	} = {},
): AgentMessageRecord[] {
	const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
	// Agent-targeted delivery (parent routes, downward still mostly legacy).
	const v2 =
		!options.targetKind || options.targetKind === "child"
			? listV2MessagesForAgentRecipient(db, recipientAgentId, options)
			: [];
	const legacy = listLegacyMessagesForRecipient(db, recipientAgentId, options);
	return mergeDeliveryMessages(v2, legacy).slice(0, limit);
}

