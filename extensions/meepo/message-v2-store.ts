/**
 * message-v2-store
 */
/**
 * Hierarchy, routing permissions, and v2 multi-recipient message creation.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "./sqlite.js";
import { makePlaceholders, runImmediateTransaction, safeJsonParse, toBoolean } from "./sql-util.js";
import {
	toAgentAccessGrantRecord,
	toAgentActiveEdgeRecord,
	toAgentEdgeRecord,
	toAgentMessageRecipientRecord,
	toAgentMessageRouteRecord,
	toAgentMessageV2Record,
	toAgentOrgRecord,
	toAgentRoleRecord,
	toAgentThreadRecord,
} from "./registry-shared.js";
import type {
	CanSendMessageInput,
	CreateAgentHierarchyEdgeInput,
	CreateAgentMessageRouteInput,
	CreateAgentMessageWithRecipientsInput,
	CreateAgentMessageWithRecipientsResult,
	CreateAgentMessageRecipientV2Input,
	FetchAgentInboxV2Input,
	GetActiveAgentAccessGrantInput,
	GetActiveAgentEdgeInput,
	ListActiveAgentEdgesInput,
	ListHierarchyVisibleAgentIdsOptions,
	ResolveAgentActorContextInput,
	UpsertAgentOrgInput,
	AgentMessageRecipientUnreadSummaryFilters,
} from "./registry-types.js";
import type {
	AgentAccessGrantRecord,
	AgentActiveEdgeRecord,
	AgentActorContext,
	AgentEdgeRecord,
	AgentEdgeType,
	AgentInboxMessageV2Record,
	AgentMessageRecipientRecord,
	AgentMessageRecipientStatus,
	AgentMessageRouteRecord,
	AgentMessageV2Record,
	AgentOrgRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentRoleRecord,
	AgentThreadRecord,
	AgentUnreadSummaryRecord,
	CanSendMessageDecision,
} from "./types.js";
import { canSendMessage, createAgentMessageRoute, makeCanSendDecision } from "./hierarchy-routing.js";
import { AgentMessagePermissionError, getAgentScopeRow, normalizeRecipient } from "./hierarchy-actors.js";

export type {
	ResolveAgentActorContextInput,
	ListHierarchyVisibleAgentIdsOptions,
	GetActiveAgentEdgeInput,
	ListActiveAgentEdgesInput,
	GetActiveAgentAccessGrantInput,
	CanSendMessageInput,
	CreateAgentMessageRouteInput,
	CreateAgentMessageWithRecipientsInput,
	CreateAgentMessageWithRecipientsResult,
	UpsertAgentOrgInput,
	CreateAgentHierarchyEdgeInput,
} from "./registry-types.js";

export function resolveMessageScope(db: DatabaseSync, input: CreateAgentMessageWithRecipientsInput): { orgId: string | null; projectKey: string; subjectAgentId: string | null } {
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

export function makeSkippedPermissionDecision(actor: AgentActorContext, recipient: AgentRecipientRef, orgId: string | null): CanSendMessageDecision {
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

export function resolveInboxRecipient(actor: AgentActorContext, recipient: AgentRecipientRef | undefined): AgentRecipientRef {
	const resolved = recipient ?? (actor.kind === "root" ? { kind: "root" as const } : { kind: "agent" as const, agentId: actor.agentId });
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) return resolved;
	if (resolved.kind === "agent" && resolved.agentId === actor.agentId) return resolved;
	throw new Error("Agent inbox fetch is limited to the current recipient unless the actor has admin override.");
}

export function buildInboxWhere(input: FetchAgentInboxV2Input, recipient: AgentRecipientRef): { where: string[]; params: unknown[] } {
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

export function selectInboxRows(db: DatabaseSync, input: FetchAgentInboxV2Input, recipient: AgentRecipientRef): AgentInboxMessageV2Record[] {
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

