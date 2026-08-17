/**
 * Inbox: publish / list / mark. v2 is the implementation; leftover legacy rows are a read adapter.
 */
import type { DatabaseSync } from "./sqlite.js";
import {
	listAgentAttentionItemsV2,
	listAttentionItems,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessages,
	updateAgentAttentionItemV2,
	updateAgentAttentionItemsV2ForSubject,
	updateAttentionItem,
	updateAttentionItemsForAgent,
} from "./message-store.js";
import { createMessageWithRecipients } from "./message-v2-store.js";
import { OPEN_AGENT_ATTENTION_V2_STATES, OPEN_ATTENTION_STATES } from "./registry-shared.js";
import { payloadObject, payloadString } from "./sql-util.js";
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
	FleetSummary,
	InboxDirection,
	InboxEntry,
	ListInboxFilters,
	MessageKind,
	MessageStatus,
	UpdateAttentionItemInput,
} from "./types.js";

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
		actionPolicy: typeof payload.actionPolicy === "string" ? (payload.actionPolicy as DownwardMessageActionPolicy) : undefined,
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

function recipientStatusForInbox(status: MessageStatus): "acked" | "read" | "expired" | "failed" | "notified" {
	if (status === "acked") return "acked";
	if (status === "delivered") return "read";
	if (status === "expired") return "expired";
	if (status === "failed") return "failed";
	return "notified";
}

/** One listed id, one mark. Recipient-row first, leftover agent_messages second. */
export function markInbox(
	db: DatabaseSync,
	ids: string[],
	status: MessageStatus,
	options: { childId?: string; transportKind?: "rpc_bridge" | "inbox" | "poll_fallback" } = {},
): number {
	if (ids.length === 0) return 0;
	const recipientStatus = recipientStatusForInbox(status);
	const markOptions = { recipientAgentId: options.childId, transportKind: options.transportKind };
	let changes = 0;
	for (const id of ids) {
		const byRecipient = markAgentMessageRecipientsByIds(db, [id], recipientStatus, markOptions);
		changes += byRecipient > 0 ? byRecipient : markAgentMessages(db, [id], status);
	}
	return changes;
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

function toV2PatchState(state: AttentionItemState | undefined): AgentAttentionV2Record["state"] | undefined {
	if (!state) return undefined;
	if (state === "waiting_on_user" || state === "waiting_on_coordinator") return "waiting_on_owner";
	return state;
}

function toV2Patch(patch: UpdateAttentionItemInput) {
	return {
		state: toV2PatchState(patch.state),
		priority: patch.priority,
		summary: patch.summary,
		payload: patch.payload,
		updatedAt: patch.updatedAt,
		resolvedAt: patch.resolvedAt,
		resolutionKind: patch.resolutionKind,
		resolutionSummary: patch.resolutionSummary,
	};
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
			taskId: item.taskId,
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

/** Mark Attention for a Child. Leftover + v2 writes stay private. */
export function markAttention(
	db: DatabaseSync,
	childId: string,
	patch: UpdateAttentionItemInput,
	filters: { states?: AttentionItemState[]; kinds?: AttentionItemKind[] } = {},
): number {
	const leftover = updateAttentionItemsForAgent(db, childId, patch, {
		states: filters.states,
		kinds: filters.kinds,
	});
	const v2 = updateAgentAttentionItemsV2ForSubject(db, childId, toV2Patch(patch), {
		states: toV2States(filters.states) ?? OPEN_AGENT_ATTENTION_V2_STATES,
		kinds: toV2Kinds(filters.kinds),
	});
	return leftover + v2;
}

/** One Attention id, one mark. Tries v2 first, leftover second. */
export function markAttentionById(
	db: DatabaseSync,
	id: string,
	patch: UpdateAttentionItemInput,
	filters: { states?: AttentionItemState[]; taskId?: string } = {},
): number {
	const v2 = updateAgentAttentionItemV2(db, id, toV2Patch(patch), {
		states: toV2States(filters.states),
		taskId: filters.taskId,
	});
	if (v2 > 0) return v2;
	return updateAttentionItem(db, id, patch, {
		states: filters.states,
		taskId: filters.taskId,
	});
}

/** Fleet unread + Attention counts. Leftover merge stays private to Inbox. */
export function summarizeInbox(
	db: DatabaseSync,
	filters: { projectKey?: string; spawnSessionId?: string; spawnSessionFile?: string } = {},
): Pick<FleetSummary, "unread" | "attentionOpen" | "attentionWaitingOnUser" | "attentionCompletions" | "userQuestions"> {
	const items = listOpenAttention(db, {
		projectKey: filters.projectKey,
		states: OPEN_ATTENTION_STATES,
		limit: 500,
	});
	const unread = listInbox(db, {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
		limit: 500,
	}).length;
	return {
		unread,
		attentionOpen: items.length,
		attentionWaitingOnUser: items.filter((item) => item.audience === "user").length,
		attentionCompletions: items.filter((item) => item.kind === "complete").length,
		userQuestions: new Set(items.filter((item) => item.kind === "question_for_user").map((item) => item.agentId)).size,
	};
}

/** Attach per-child unread from the Inbox list. Listed id is already the recipient row / leftover message id. */
export function attachInboxUnread(
	db: DatabaseSync,
	agents: AgentSummary[],
	filters: { projectKey?: string; spawnSessionId?: string; spawnSessionFile?: string } = {},
): AgentSummary[] {
	if (agents.length === 0) return agents;
	const messages = listInboxMessages(db, {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
		agentIds: agents.map((agent) => agent.id),
		limit: 500,
	});
	const byChild = new Map<string, AgentMessageRecord[]>();
	for (const message of messages) {
		const childId = message.senderAgentId;
		if (!childId) continue;
		const existing = byChild.get(childId) ?? [];
		existing.push(message);
		byChild.set(childId, existing);
	}
	return agents.map((agent) => {
		const unread = (byChild.get(agent.id) ?? []).sort((left, right) => right.createdAt - left.createdAt);
		return {
			...agent,
			unreadCount: unread.length,
			latestUnreadMessage: unread[0] ?? null,
		};
	});
}
