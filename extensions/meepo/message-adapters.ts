/**
 * Adapters between hierarchy messaging (v2) and the delivery-queue shape (AgentMessageRecord).
 *
 * Canonical write path for new upward publishes is v2 only.
 * Delivery/bridge code still consumes AgentMessageRecord; these adapters project v2 rows into that shape
 * and keep legacy agent_messages as read-compat for pre-migration rows.
 */

import type {
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentMessageV2Record,
	AgentMessageRecipientRecord,
	DeliveryMode,
	DownwardMessagePayload,
	MessageKind,
	MessageStatus,
} from "./types.js";

const DELIVERY_MODES = new Set<DeliveryMode>(["immediate", "steer", "follow_up", "idle_only"]);

function asDeliveryMode(value: string | null | undefined, fallback: DeliveryMode = "follow_up"): DeliveryMode {
	if (value && DELIVERY_MODES.has(value as DeliveryMode)) return value as DeliveryMode;
	// inbox_only is v2-only; treat as follow_up for bridge/poll delivery.
	return fallback;
}

function asMessageKind(value: string): MessageKind {
	return value as MessageKind;
}

function asMessageStatus(status: AgentMessageRecipientRecord["status"]): MessageStatus {
	switch (status) {
		case "queued":
		case "notified":
			return "queued";
		case "read":
			return "delivered";
		case "acked":
			return "acked";
		case "failed":
			return "failed";
		case "expired":
			return "expired";
		default:
			return "queued";
	}
}

function targetKindForRecipient(recipientKind: AgentMessageRecipientRecord["recipientKind"]): AgentMessageRecord["targetKind"] {
	if (recipientKind === "user") return "user";
	if (recipientKind === "agent") return "child";
	return "primary";
}

/** Project a v2 inbox row into the delivery-queue message shape. */
export function deliveryMessageFromInboxV2(entry: AgentInboxMessageV2Record): AgentMessageRecord {
	const basePayload =
		entry.message.payload && typeof entry.message.payload === "object" && !Array.isArray(entry.message.payload)
			? { ...(entry.message.payload as Record<string, unknown>) }
			: {};
	const payload: DownwardMessagePayload & Record<string, unknown> = {
		...basePayload,
		summary: entry.message.summary,
		details: entry.message.bodyMarkdown ?? undefined,
		actionPolicy: entry.message.actionPolicy ?? undefined,
		senderKind: entry.message.senderKind,
		senderAgentId: entry.message.senderAgentId,
	};
	return {
		// Listed id is the recipient row for v2, leftover agent_messages.id otherwise.
		id: entry.recipient.id,
		threadId: entry.message.threadId,
		senderAgentId: entry.message.senderAgentId,
		recipientAgentId: entry.recipient.recipientAgentId,
		targetKind: targetKindForRecipient(entry.recipient.recipientKind),
		kind: asMessageKind(entry.message.kind),
		deliveryMode: asDeliveryMode(entry.recipient.deliveryMode),
		payload,
		status: asMessageStatus(entry.recipient.status),
		createdAt: entry.message.createdAt,
		deliveredAt: entry.recipient.readAt ?? entry.recipient.notifiedAt,
		ackedAt: entry.recipient.ackedAt,
	};
}

export function deliveryMessageFromV2Parts(
	message: AgentMessageV2Record,
	recipient: AgentMessageRecipientRecord,
): AgentMessageRecord {
	return deliveryMessageFromInboxV2({ message, recipient, thread: null });
}

/** True when a legacy mailbox row is only a dual-write shadow of a v2 message. */
export function legacyMessageIsV2Shadow(message: AgentMessageRecord): boolean {
	const payload = message.payload && typeof message.payload === "object" ? (message.payload as Record<string, unknown>) : null;
	return Boolean(payload && (typeof payload.v2MessageId === "string" || typeof payload.v2RecipientRowId === "string"));
}

/** Merge delivery queues: v2 first, then legacy rows that are not v2 shadows. */
export function mergeDeliveryMessages(v2: AgentMessageRecord[], legacy: AgentMessageRecord[]): AgentMessageRecord[] {
	const seenV2MessageIds = new Set<string>();
	const seenV2RecipientIds = new Set<string>();
	for (const message of v2) {
		const payload = message.payload && typeof message.payload === "object" ? (message.payload as Record<string, unknown>) : null;
		if (typeof payload?.v2MessageId === "string") seenV2MessageIds.add(payload.v2MessageId);
		if (typeof payload?.v2RecipientRowId === "string") seenV2RecipientIds.add(payload.v2RecipientRowId);
		seenV2RecipientIds.add(message.id);
	}
	const legacyOnly = legacy.filter((message) => {
		if (legacyMessageIsV2Shadow(message)) {
			const payload = message.payload as Record<string, unknown>;
			const v2MessageId = typeof payload.v2MessageId === "string" ? payload.v2MessageId : null;
			const v2RecipientRowId = typeof payload.v2RecipientRowId === "string" ? payload.v2RecipientRowId : null;
			if (v2MessageId && seenV2MessageIds.has(v2MessageId)) return false;
			if (v2RecipientRowId && seenV2RecipientIds.has(v2RecipientRowId)) return false;
			// Shadow without live v2 row: keep for read-compat of partially migrated DBs.
		}
		return true;
	});
	return [...v2, ...legacyOnly].sort((a, b) => a.createdAt - b.createdAt);
}
