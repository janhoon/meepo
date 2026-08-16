/**
 * Downward message queue + RPC bridge delivery.
 */
import { randomUUID } from "node:crypto";
import { getMeepoDb } from "./db.js";
import {
	createAgentEvent,
	createRootActorContext,
	getAgent,
	updateAgent,
} from "./registry.js";
import { listChildDeliveryQueue, listInboxForChild, markAttention, markInbox, publishDownward } from "./inbox.js";
import { getRpcBridgeSocketPath, sendRpcBridgeCommand } from "./rpc-client.js";
import { mapDeliveryModeToBridgeCommand } from "./rpc-bridge-control.js";
import { collectQueuedWakeCoalescingContext } from "./wake-coalescing.js";
import { defaultDownwardActionPolicy, formatDownwardMessageForChild } from "./formatters.js";
import type {
	AgentActorContext,
	AgentMessageRecord,
	AgentSummary,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
} from "./types.js";

export const liveBridgeDeliveryInFlight = new Set<string>();
export const scheduledBridgeDeliveryRetries = new Map<string, ReturnType<typeof setTimeout>>();

export function isCoalescableWake(kind: AgentMessageRecord["kind"], actionPolicy: DownwardMessageActionPolicy | undefined): boolean {
	return actionPolicy === "resume_if_blocked" && ["answer", "note", "priority"].includes(kind);
}

export function coalesceQueuedDownwardWakeMessages(
	db: ReturnType<typeof getMeepoDb>,
	agent: AgentSummary,
	kind: "answer" | "note" | "redirect" | "cancel" | "priority",
	actionPolicy: DownwardMessageActionPolicy,
): { expiredMessageIds: string[]; expiredV2MessageIds: string[]; expiredV2RecipientRowIds: string[]; coalescedWakeMessages: NonNullable<DownwardMessagePayload["coalescedWakeMessages"]> } {
	if (!isCoalescableWake(kind, actionPolicy)) {
		return { expiredMessageIds: [], expiredV2MessageIds: [], expiredV2RecipientRowIds: [], coalescedWakeMessages: [] };
	}
	const queued = listChildDeliveryQueue(db, agent.id, { limit: 100 }).filter((message) => {
		const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
		return isCoalescableWake(message.kind, payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind as "answer" | "note" | "redirect" | "cancel" | "priority"));
	});
	if (queued.length === 0) {
		return { expiredMessageIds: [], expiredV2MessageIds: [], expiredV2RecipientRowIds: [], coalescedWakeMessages: [] };
	}
	const { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages } = collectQueuedWakeCoalescingContext(queued);
	markInbox(db, [...expiredMessageIds, ...expiredV2MessageIds, ...expiredV2RecipientRowIds], "expired", {
		childId: agent.id,
		transportKind: "inbox",
	});
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: "downward_wake_coalesced",
		summary: `Coalesced ${queued.length} queued resume/wake message${queued.length === 1 ? "" : "s"}.`,
		payload: { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages, replacementKind: kind, actionPolicy },
	});
	return { expiredMessageIds, expiredV2MessageIds, expiredV2RecipientRowIds, coalescedWakeMessages };
}

export function scheduleBridgeDeliveryRetry(agentId: string, delayMs = 250): void {
	if (scheduledBridgeDeliveryRetries.has(agentId)) return;
	const timer = setTimeout(() => {
		scheduledBridgeDeliveryRetries.delete(agentId);
		void deliverQueuedMessagesViaBridge(agentId).catch(() => {});
	}, Math.max(1, delayMs));
	scheduledBridgeDeliveryRetries.set(agentId, timer);
}

export async function deliverQueuedMessagesViaBridge(agentId: string): Promise<{ delivered: number; deferred: number; transportState: string }> {
	if (liveBridgeDeliveryInFlight.has(agentId)) {
		scheduleBridgeDeliveryRetry(agentId, 300);
		const queued = listInboxForChild(getMeepoDb(), agentId, { limit: 50 });
		return { delivered: 0, deferred: queued.length, transportState: "busy" };
	}
	liveBridgeDeliveryInFlight.add(agentId);
	let lastFailureWasTransport = false;
	let stateProbeFailed = false;
	let stateProbeError: string | null = null;
	try {
		const db = getMeepoDb();
		let agent = getAgent(db, agentId);
		if (!agent) return { delivered: 0, deferred: 0, transportState: "missing" };
		if (agent.transportKind !== "rpc_bridge") {
			return { delivered: 0, deferred: 0, transportState: agent.transportState };
		}
		const queued = listChildDeliveryQueue(db, agent.id, { limit: 50 });
		if (queued.length === 0) {
			return { delivered: 0, deferred: 0, transportState: agent.transportState };
		}
		const socketPath = getRpcBridgeSocketPath(agent);
		if (!socketPath) {
			updateAgent(db, agent.id, {
				transportKind: "rpc_bridge",
				transportState: "fallback",
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: "RPC bridge socket is unavailable.",
				updatedAt: Date.now(),
			});
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "downward_live_deferred",
				summary: "RPC bridge socket is unavailable.",
				payload: { queued: queued.length },
			});
			return { delivered: 0, deferred: queued.length, transportState: "fallback" };
		}

		let isStreaming = false;
		try {
			const stateResponse = await sendRpcBridgeCommand(socketPath, { command: "get_state" }, 2500);
			if (stateResponse.success && stateResponse.data && typeof stateResponse.data === "object") {
				isStreaming = Boolean((stateResponse.data as { isStreaming?: boolean }).isStreaming);
			}
		} catch (error) {
			stateProbeFailed = true;
			stateProbeError = error instanceof Error ? error.message : String(error);
			isStreaming = true;
		}

		let delivered = 0;
		for (const message of queued) {
			// Host-agnostic: delivery modes map to bridge commands only (wayfinder #20/#24).
			const bridgeCommand = {
				command: mapDeliveryModeToBridgeCommand(message.deliveryMode, { isStreaming }),
				message: formatDownwardMessageForChild(message),
			};
			let response;
			try {
				response = await sendRpcBridgeCommand(socketPath, bridgeCommand, 5000);
			} catch (error) {
				lastFailureWasTransport = true;
				throw error;
			}
			if (!response.success) {
				lastFailureWasTransport = false;
				throw new Error(response.error ?? `RPC bridge rejected ${message.kind}.`);
			}
			const v2Payload = (message.payload && typeof message.payload === "object" ? message.payload : null) as DownwardMessagePayload | null;
			markInbox(
				db,
				[message.id, v2Payload?.v2RecipientRowId, v2Payload?.v2MessageId].filter((id): id is string => Boolean(id)),
				"acked",
				{ childId: agent.id, transportKind: "rpc_bridge" },
			);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "downward_live_delivered",
				summary: (message.payload as DownwardMessagePayload | null)?.summary ?? `${message.kind} delivered via RPC bridge`,
				payload: { messageId: message.id, bridgeCommand: bridgeCommand.command, deliveryMode: message.deliveryMode },
			});
			delivered += 1;
			isStreaming = true;
		}

		updateAgent(db, agent.id, {
			transportKind: "rpc_bridge",
			transportState: "live",
			bridgeSocketPath: socketPath,
			bridgeConnectedAt: Date.now(),
			bridgeUpdatedAt: Date.now(),
			bridgeLastError: stateProbeFailed ? stateProbeError : null,
			updatedAt: Date.now(),
		});
		return { delivered, deferred: Math.max(0, queued.length - delivered), transportState: "live" };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const db = getMeepoDb();
		const agent = getAgent(db, agentId);
		if (agent && agent.transportKind === "rpc_bridge") {
			updateAgent(db, agent.id, {
				transportKind: "rpc_bridge",
				transportState: lastFailureWasTransport ? "fallback" : agent.transportState,
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: message,
				updatedAt: Date.now(),
			});
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: lastFailureWasTransport ? "downward_live_failed" : "downward_live_deferred",
				summary: message,
				payload: { error: message, transportFailure: lastFailureWasTransport },
			});
			if (!lastFailureWasTransport) {
				scheduleBridgeDeliveryRetry(agentId, 500);
			}
		}
		const queued = listChildDeliveryQueue(db, agentId, { limit: 50 });
		return { delivered: 0, deferred: queued.length, transportState: lastFailureWasTransport ? "fallback" : "live" };
	} finally {
		liveBridgeDeliveryInFlight.delete(agentId);
		const queued = listChildDeliveryQueue(getMeepoDb(), agentId, { limit: 1 });
		if (queued.length > 0) scheduleBridgeDeliveryRetry(agentId, 300);
	}
}

export function queueDownwardMessage(
	agent: AgentSummary,
	kind: "answer" | "note" | "redirect" | "cancel" | "priority",
	payload: DownwardMessagePayload,
	deliveryMode: DeliveryMode,
	actor: AgentActorContext = createRootActorContext(),
): string {
	const db = getMeepoDb();
	const fullPayload: DownwardMessagePayload = {
		...payload,
		senderKind: actor.kind === "root" ? "root" : "agent",
		senderAgentId: actor.kind === "agent" ? actor.agentId : null,
		actionPolicy: payload.actionPolicy ?? defaultDownwardActionPolicy(kind),
	};
	const coalescedWake = coalesceQueuedDownwardWakeMessages(db, agent, kind, fullPayload.actionPolicy!);
	if (coalescedWake.expiredMessageIds.length > 0) {
		fullPayload.coalescedMessageIds = coalescedWake.expiredMessageIds;
		fullPayload.coalescedV2MessageIds = coalescedWake.expiredV2MessageIds;
		fullPayload.coalescedV2RecipientRowIds = coalescedWake.expiredV2RecipientRowIds;
		fullPayload.coalescedWakeMessages = coalescedWake.coalescedWakeMessages;
	}
	let messageId = payload.v2MessageId ?? null;
	if (!messageId) {
		const published = publishDownward(db, {
			actor,
			agent,
			kind,
			summary: fullPayload.summary,
			details: fullPayload.details,
			files: fullPayload.files,
			actionPolicy: fullPayload.actionPolicy,
			inReplyToMessageId: fullPayload.inReplyToMessageId,
			deliveryMode,
			payload: fullPayload,
		});
		messageId = published.messageId;
		fullPayload.v2MessageId = published.messageId;
		fullPayload.v2RecipientRowId = published.recipientRowId ?? undefined;
	}
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: `downward_${kind}`,
		summary: fullPayload.summary,
		payload: { messageId, deliveryMode, coalescedWake, ...fullPayload },
	});
	if (kind === "cancel" || ["answer", "redirect", "priority"].includes(kind)) {
		markAttention(
			db,
			agent.id,
			{
				state: kind === "cancel" ? "cancelled" : "acknowledged",
				updatedAt: Date.now(),
				resolvedAt: kind === "cancel" ? Date.now() : undefined,
				resolutionKind: kind,
				resolutionSummary: fullPayload.summary,
			},
			kind === "cancel"
				? { states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] }
				: {
						states: ["open", "waiting_on_coordinator", "waiting_on_user"],
						kinds: ["question", "question_for_user", "blocked"],
				  },
		);
	}
	updateAgent(db, agent.id, { updatedAt: Date.now() });
	return messageId;
}

