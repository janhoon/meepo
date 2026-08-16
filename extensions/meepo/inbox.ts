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
} from "./registry.js";
import { OPEN_AGENT_ATTENTION_V2_STATES, OPEN_ATTENTION_STATES } from "./registry-shared.js";
import type {
	AgentActorContext,
	AgentAttentionV2Record,
	AgentMessageRecord,
	AgentRecipientKind,
	AgentSummary,
	AttentionItemAudience,
	AttentionItemKind,
	AttentionItemRecord,
	AttentionItemState,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	InboxDirection,
	InboxEntry,
	ListInboxFilters,
	MessageKind,
	MessageStatus,
} from "./types.js";

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
		status === "delivered" || status === "acked" ? "acked" : status === "expired" ? "expired" : status === "failed" ? "failed" : "notified";
	return markAgentMessageRecipientsByIds(db, ids, recipientStatus, {
		recipientAgentId: options.childId,
		transportKind: options.transportKind,
	});
}

/** Delivery queue for the RPC bridge. Inbox-owned wrap of the v2+leftover merge. */
export function listChildDeliveryQueue(
	db: DatabaseSync,
	childId: string,
	options: { includeDelivered?: boolean; limit?: number } = {},
): AgentMessageRecord[] {
	return listMessagesForRecipient(db, childId, {
		targetKind: "child",
		includeDelivered: options.includeDelivered,
		limit: options.limit,
	});
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

export interface ListOpenAttentionFilters {
	projectKey?: string;
	childIds?: string[];
	taskIds?: string[];
	ownerKinds?: AgentRecipientKind[];
	audiences?: AttentionItemAudience[];
	states?: AttentionItemState[];
	kinds?: AttentionItemKind[];
	limit?: number;
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

function toV2States(states?: AttentionItemState[]): AgentAttentionV2Record["state"][] | undefined {
	if (!states) return undefined;
	const mapped = new Set<AgentAttentionV2Record["state"]>();
	for (const state of states) {
		if (state === "waiting_on_user" || state === "waiting_on_coordinator") mapped.add("waiting_on_owner");
		else if (state === "open" || state === "acknowledged" || state === "resolved" || state === "cancelled" || state === "superseded") {
			mapped.add(state);
		}
	}
	return [...mapped];
}

function toV2OwnerKinds(filters: ListOpenAttentionFilters): AgentRecipientKind[] | undefined {
	if (filters.ownerKinds && filters.ownerKinds.length > 0) return filters.ownerKinds;
	if (!filters.audiences || filters.audiences.length === 0) return undefined;
	const kinds = new Set<AgentRecipientKind>();
	for (const audience of filters.audiences) {
		if (audience === "user") kinds.add("user");
		else kinds.add("root");
	}
	return [...kinds];
}

function toLegacyAudiences(filters: ListOpenAttentionFilters): AttentionItemAudience[] | undefined {
	if (filters.audiences && filters.audiences.length > 0) return filters.audiences;
	if (!filters.ownerKinds || filters.ownerKinds.length === 0) return undefined;
	const audiences = new Set<AttentionItemAudience>();
	for (const kind of filters.ownerKinds) {
		if (kind === "user") audiences.add("user");
		else if (kind === "root") audiences.add("coordinator");
	}
	return audiences.size > 0 ? [...audiences] : undefined;
}

function toV2Kinds(kinds?: AttentionItemKind[]): AgentAttentionV2Record["kind"][] | undefined {
	if (!kinds || kinds.length === 0) return undefined;
	const mapped = new Set<AgentAttentionV2Record["kind"]>(kinds);
	if (kinds.includes("question")) {
		mapped.add("approval");
		mapped.add("change_request");
	}
	return [...mapped];
}

export function attentionItemFromV2(item: AgentAttentionV2Record): AttentionItemRecord {
	return {
		id: item.id,
		messageId: item.messageId,
		agentId: item.subjectAgentId ?? "unknown",
		threadId: item.subjectAgentId ?? item.id,
		projectKey: item.projectKey,
		spawnSessionId: null,
		spawnSessionFile: null,
		audience: item.ownerKind === "user" ? "user" : "coordinator",
		kind: (item.kind === "approval" || item.kind === "change_request" ? "question" : item.kind) as AttentionItemRecord["kind"],
		priority: item.priority,
		state:
			item.state === "waiting_on_owner"
				? item.ownerKind === "user"
					? "waiting_on_user"
					: "waiting_on_coordinator"
				: (item.state as AttentionItemRecord["state"]),
		summary: item.summary,
		payload: {
			...payloadObject(item.payload),
			_source: "v2",
			taskId: item.taskId,
			v2MessageId: item.messageId,
			v2RecipientRowId: item.recipientRowId,
			ownerKind: item.ownerKind,
			ownerAgentId: item.ownerAgentId,
		},
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		resolvedAt: item.resolvedAt,
		resolutionKind: item.resolutionKind,
		resolutionSummary: item.resolutionSummary,
	};
}

/** Attention list. Leftover legacy rows stay a private read adapter. */
export function listOpenAttention(db: DatabaseSync, filters: ListOpenAttentionFilters = {}): AttentionItemRecord[] {
	if (filters.childIds && filters.childIds.length === 0 && (!filters.taskIds || filters.taskIds.length === 0)) {
		return [];
	}
	const v2 = listAgentAttentionItemsV2(db, {
		projectKey: filters.projectKey,
		subjectAgentIds: filters.childIds,
		taskIds: filters.taskIds,
		ownerKinds: toV2OwnerKinds(filters),
		states: toV2States(filters.states) ?? OPEN_AGENT_ATTENTION_V2_STATES,
		kinds: toV2Kinds(filters.kinds),
		limit: filters.limit,
	});
	const rawLegacy = listAttentionItems(db, {
		projectKey: filters.projectKey,
		agentIds: filters.childIds,
		states: filters.states ?? OPEN_ATTENTION_STATES,
		audiences: toLegacyAudiences(filters),
		kinds: filters.kinds,
		limit: filters.limit,
	});
	const v2MessageIds = new Set(v2.map((item) => item.messageId).filter((value): value is string => Boolean(value)));
	const v2RecipientRowIds = new Set(v2.map((item) => item.recipientRowId).filter((value): value is string => Boolean(value)));
	const leftover =
		v2MessageIds.size === 0 && v2RecipientRowIds.size === 0
			? rawLegacy
			: rawLegacy.filter((item) => !leftoverAttentionDuplicatesV2(item, v2MessageIds, v2RecipientRowIds));
	return [...v2.map(attentionItemFromV2), ...leftover].sort(
		(left, right) => right.priority - left.priority || left.createdAt - right.createdAt,
	);
}
