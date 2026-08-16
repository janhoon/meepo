/**
 * Inbox: publish / list / mark. v2 is the implementation; leftover legacy rows are a read adapter.
 */
import type { DatabaseSync } from "./sqlite.js";
import {
	createMessageWithRecipients,
	listAgentAttentionItemsV2,
	listAttentionItems,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessages,
} from "./registry.js";
import type {
	AgentActorContext,
	AgentAttentionV2Record,
	AgentMessageRecord,
	AgentSummary,
	AttentionItemRecord,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	InboxDirection,
	InboxEntry,
	ListAttentionItemsFilters,
	ListInboxFilters,
	MessageKind,
	MessageStatus,
} from "./types.js";
import type { ListAgentAttentionItemsV2Filters } from "./registry.js";

function payloadObject(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

function payloadString(payload: unknown, key: string): string | undefined {
	const value = payloadObject(payload)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function inboxDirectionFromRecord(message: AgentMessageRecord): InboxDirection {
	return message.targetKind === "child" ? "downward" : "upward";
}

export function inboxEntryFromRecord(message: AgentMessageRecord): InboxEntry {
	const payload = payloadObject(message.payload);
	const summary =
		payloadString(message.payload, "summary") ??
		(typeof payload.kind === "string" ? payload.kind : message.kind);
	return {
		id: message.id,
		direction: inboxDirectionFromRecord(message),
		kind: message.kind,
		summary,
		status: message.status,
		childId:
			message.targetKind === "child"
				? message.recipientAgentId
				: message.senderAgentId,
		createdAt: message.createdAt,
		details: payloadString(message.payload, "details"),
		actionPolicy: payload.actionPolicy as DownwardMessageActionPolicy | undefined,
	};
}

export function listInbox(db: DatabaseSync, filters: ListInboxFilters = {}): InboxEntry[] {
	return listInboxMessages(db, filters).map(inboxEntryFromRecord);
}

export function listInboxForChild(
	db: DatabaseSync,
	childId: string,
	options: { includeDelivered?: boolean; limit?: number } = {},
): InboxEntry[] {
	return listMessagesForRecipient(db, childId, {
		targetKind: "child",
		includeDelivered: options.includeDelivered,
		limit: options.limit,
	}).map(inboxEntryFromRecord);
}

export function markInbox(
	db: DatabaseSync,
	ids: string[],
	status: MessageStatus,
	options: { childId?: string; transportKind?: "rpc_bridge" | "inbox" | "poll_fallback" } = {},
): number {
	if (ids.length === 0) return 0;
	const recipientStatus =
		status === "delivered" ? "read" : status === "acked" ? "acked" : status === "expired" ? "expired" : status === "failed" ? "failed" : "notified";
	const v2ById = markAgentMessageRecipientsByIds(db, ids, recipientStatus, {
		recipientAgentId: options.childId,
		transportKind: options.transportKind,
	});
	const v2ByMessage = markAgentMessageRecipientsByMessageIds(db, ids, recipientStatus, {
		recipientAgentId: options.childId,
		transportKind: options.transportKind,
	});
	const legacy = markAgentMessages(db, ids, status);
	return Math.max(v2ById, v2ByMessage, legacy);
}

export function publishDownward(
	db: DatabaseSync,
	input: {
		actor: AgentActorContext;
		agent: AgentSummary;
		kind: Extract<MessageKind, "answer" | "note" | "redirect" | "cancel" | "priority">;
		summary: string;
		details?: string;
		files?: string[];
		actionPolicy?: DownwardMessageActionPolicy;
		inReplyToMessageId?: string;
		deliveryMode: DeliveryMode;
		payload?: DownwardMessagePayload;
	},
): { messageId: string; recipientRowId: string | null } {
	const result = createMessageWithRecipients(db, {
		actor: input.actor,
		recipients: [{ kind: "agent", agentId: input.agent.id, deliveryMode: input.deliveryMode, transportKind: "inbox" }],
		projectKey: input.agent.projectKey,
		orgId: input.agent.orgId,
		taskId: input.agent.taskId,
		subjectAgentId: input.agent.id,
		kind: input.kind,
		summary: input.summary,
		bodyMarkdown: input.details ?? null,
		payload: {
			summary: input.summary,
			details: input.details,
			files: input.files,
			actionPolicy: input.actionPolicy,
			inReplyToMessageId: input.inReplyToMessageId,
			...input.payload,
		},
		actionPolicy: input.actionPolicy,
		thread: { kind: "command", title: input.summary },
	});
	return {
		messageId: result.message.id,
		recipientRowId: result.recipients[0]?.id ?? null,
	};
}

function leftoverAttentionDuplicatesV2(
	item: AttentionItemRecord,
	v2MessageIds: Set<string>,
	v2RecipientRowIds: Set<string>,
): boolean {
	if (item.messageId && v2MessageIds.has(item.messageId)) return true;
	const payload = payloadObject(item.payload);
	const v2MessageId = typeof payload.v2MessageId === "string" ? payload.v2MessageId : null;
	const v2RecipientRowId = typeof payload.v2RecipientRowId === "string" ? payload.v2RecipientRowId : null;
	return Boolean((v2MessageId && v2MessageIds.has(v2MessageId)) || (v2RecipientRowId && v2RecipientRowIds.has(v2RecipientRowId)));
}

/** Attention list: v2 first, leftover legacy rows that are not v2 shadows. */
export function listOpenAttention(
	db: DatabaseSync,
	filters: {
		v2?: ListAgentAttentionItemsV2Filters;
		legacy?: ListAttentionItemsFilters;
	} = {},
): { v2: AgentAttentionV2Record[]; leftover: AttentionItemRecord[] } {
	const v2 = listAgentAttentionItemsV2(db, filters.v2 ?? {});
	const rawLegacy = listAttentionItems(db, filters.legacy ?? {});
	const v2MessageIds = new Set(v2.map((item) => item.messageId).filter((value): value is string => Boolean(value)));
	const v2RecipientRowIds = new Set(v2.map((item) => item.recipientRowId).filter((value): value is string => Boolean(value)));
	const leftover =
		v2MessageIds.size === 0 && v2RecipientRowIds.size === 0
			? rawLegacy
			: rawLegacy.filter((item) => !leftoverAttentionDuplicatesV2(item, v2MessageIds, v2RecipientRowIds));
	return { v2, leftover };
}
