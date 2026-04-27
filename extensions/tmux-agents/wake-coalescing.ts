import type { AgentMessageRecord, DownwardMessagePayload } from "./types.js";

export type CoalescedWakeMessage = NonNullable<DownwardMessagePayload["coalescedWakeMessages"]>[number];

export interface QueuedWakeCoalescingContext {
	expiredMessageIds: string[];
	expiredV2MessageIds: string[];
	expiredV2RecipientRowIds: string[];
	coalescedWakeMessages: CoalescedWakeMessage[];
}

function appendUniqueString(target: string[], seen: Set<string>, value: string | null | undefined): void {
	if (!value || seen.has(value)) return;
	seen.add(value);
	target.push(value);
}

function appendUniqueStrings(target: string[], seen: Set<string>, values: string[] | undefined): void {
	if (!values) return;
	for (const value of values) appendUniqueString(target, seen, value);
}

function appendCoalescedWakeMessage(target: CoalescedWakeMessage[], seen: Set<string>, message: CoalescedWakeMessage): void {
	if (!message.id || seen.has(message.id)) return;
	seen.add(message.id);
	target.push(message);
}

function normalizePayload(message: AgentMessageRecord): DownwardMessagePayload {
	return (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
}

export function collectQueuedWakeCoalescingContext(queued: AgentMessageRecord[]): QueuedWakeCoalescingContext {
	const state = {
		expiredMessageIds: [] as string[],
		expiredMessageIdSet: new Set<string>(),
		expiredV2MessageIds: [] as string[],
		expiredV2MessageIdSet: new Set<string>(),
		expiredV2RecipientRowIds: [] as string[],
		expiredV2RecipientRowIdSet: new Set<string>(),
		coalescedWakeMessages: [] as CoalescedWakeMessage[],
		coalescedWakeMessageIdSet: new Set<string>(),
	};
	for (const message of queued) {
		const payload = normalizePayload(message);
		for (const prior of payload.coalescedWakeMessages ?? []) {
			appendCoalescedWakeMessage(state.coalescedWakeMessages, state.coalescedWakeMessageIdSet, prior);
			appendUniqueString(state.expiredMessageIds, state.expiredMessageIdSet, prior.id);
			appendUniqueString(state.expiredV2MessageIds, state.expiredV2MessageIdSet, prior.v2MessageId);
			appendUniqueString(state.expiredV2RecipientRowIds, state.expiredV2RecipientRowIdSet, prior.v2RecipientRowId);
		}
		appendUniqueStrings(state.expiredMessageIds, state.expiredMessageIdSet, payload.coalescedMessageIds);
		appendUniqueStrings(state.expiredV2MessageIds, state.expiredV2MessageIdSet, payload.coalescedV2MessageIds);
		appendUniqueStrings(state.expiredV2RecipientRowIds, state.expiredV2RecipientRowIdSet, payload.coalescedV2RecipientRowIds);
		appendCoalescedWakeMessage(state.coalescedWakeMessages, state.coalescedWakeMessageIdSet, {
			id: message.id,
			kind: message.kind,
			summary: payload.summary ?? "(no summary)",
			details: payload.details,
			files: payload.files,
			inReplyToMessageId: payload.inReplyToMessageId,
			v2MessageId: payload.v2MessageId,
			v2RecipientRowId: payload.v2RecipientRowId,
			createdAt: message.createdAt,
		});
		appendUniqueString(state.expiredMessageIds, state.expiredMessageIdSet, message.id);
		appendUniqueString(state.expiredV2MessageIds, state.expiredV2MessageIdSet, payload.v2MessageId);
		appendUniqueString(state.expiredV2RecipientRowIds, state.expiredV2RecipientRowIdSet, payload.v2RecipientRowId);
	}
	return {
		expiredMessageIds: state.expiredMessageIds,
		expiredV2MessageIds: state.expiredV2MessageIds,
		expiredV2RecipientRowIds: state.expiredV2RecipientRowIds,
		coalescedWakeMessages: state.coalescedWakeMessages,
	};
}
