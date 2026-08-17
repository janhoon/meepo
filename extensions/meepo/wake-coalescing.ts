import type { AgentMessageRecord, DownwardMessagePayload } from "./types.js";

export type CoalescedWakeMessage = NonNullable<DownwardMessagePayload["coalescedWakeMessages"]>[number];

export interface QueuedWakeCoalescingContext {
	expiredMessageIds: string[];
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
	const expiredMessageIds: string[] = [];
	const expiredMessageIdSet = new Set<string>();
	const coalescedWakeMessages: CoalescedWakeMessage[] = [];
	const coalescedWakeMessageIdSet = new Set<string>();
	for (const message of queued) {
		const payload = normalizePayload(message);
		for (const prior of payload.coalescedWakeMessages ?? []) {
			appendCoalescedWakeMessage(coalescedWakeMessages, coalescedWakeMessageIdSet, prior);
			appendUniqueString(expiredMessageIds, expiredMessageIdSet, prior.id);
		}
		appendUniqueStrings(expiredMessageIds, expiredMessageIdSet, payload.coalescedMessageIds);
		appendCoalescedWakeMessage(coalescedWakeMessages, coalescedWakeMessageIdSet, {
			id: message.id,
			kind: message.kind,
			summary: payload.summary ?? "(no summary)",
			details: payload.details,
			files: payload.files,
			inReplyToMessageId: payload.inReplyToMessageId,
			createdAt: message.createdAt,
		});
		appendUniqueString(expiredMessageIds, expiredMessageIdSet, message.id);
	}
	return { expiredMessageIds, coalescedWakeMessages };
}
