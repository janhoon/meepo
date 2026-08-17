/**
 * Child downward message delivery (parent -> this child via bridge/poll).
 */
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import { getMeepoDb } from "./db.js";
import { getRpcBridgeSocketPath, sendRpcBridgeCommand } from "./rpc-client.js";
import { createAgentEvent, getAgent, updateAgent } from "./registry.js";
import { listChildDeliveryQueue, markInbox } from "./inbox.js";
import { formatDownwardMessage } from "./downward-policy.js";
import type {
	AgentMessageRecord,
	AgentTransportState,
	DownwardMessagePayload,
} from "./types.js";

export function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant";
}

export function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

export function getDeliveryOptions(message: AgentMessageRecord): { deliverAs: "steer" | "followUp" | "nextTurn"; triggerTurn?: boolean } {
	switch (message.deliveryMode) {
		case "follow_up":
			return { deliverAs: "followUp", triggerTurn: true };
		case "idle_only":
			return { deliverAs: "followUp" };
		case "steer":
		case "immediate":
		default:
			return { deliverAs: "steer", triggerTurn: true };
	}
}

interface ParentPublishDeliveryResult {
	attempted: boolean;
	delivered: number;
	deferred: number;
	transportState: AgentTransportState | "missing";
	ackedMessageIds: string[];
	error?: string;
	reason?: string;
}

function payloadSummary(message: AgentMessageRecord): string {
	const payload = message.payload && typeof message.payload === "object" ? (message.payload as DownwardMessagePayload) : null;
	return payload?.summary ?? `${message.kind} delivered via RPC bridge`;
}

export async function deliverQueuedParentMessagesViaBridge(parentAgentId: string): Promise<ParentPublishDeliveryResult> {
	const db = getMeepoDb();
	const queued = listChildDeliveryQueue(db, parentAgentId, { limit: 50 });
	const messageIds = queued.map((message) => message.id);
	const parent = getAgent(db, parentAgentId);
	if (!parent) {
		return { attempted: false, delivered: 0, deferred: queued.length, transportState: "missing", ackedMessageIds: [], reason: "Parent agent was not found." };
	}
	if (queued.length === 0) {
		return { attempted: false, delivered: 0, deferred: 0, transportState: parent.transportState, ackedMessageIds: [] };
	}
	if (parent.transportKind !== "rpc_bridge") {
		return {
			attempted: false,
			delivered: 0,
			deferred: queued.length,
			transportState: parent.transportState,
			ackedMessageIds: [],
			reason: "parent agent is using poll-fallback delivery",
		};
	}
	const socketPath = getRpcBridgeSocketPath(parent);
	if (!socketPath) {
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "fallback",
			bridgeUpdatedAt: now,
			bridgeLastError: "RPC bridge socket is unavailable for parent-routed publish delivery.",
			updatedAt: now,
		});
		createAgentEvent(db, {
			id: randomUUID(),
			agentId: parent.id,
			eventType: "parent_publish_live_deferred",
			summary: "RPC bridge socket is unavailable for parent-routed publish delivery.",
			payload: { queued: queued.length, messageIds },
		});
		return {
			attempted: true,
			delivered: 0,
			deferred: queued.length,
			transportState: "fallback",
			ackedMessageIds: [],
			reason: "RPC bridge socket is unavailable.",
		};
	}

	let isStreaming = false;
	let stateProbeError: string | null = null;
	try {
		const stateResponse = await sendRpcBridgeCommand(socketPath, { command: "get_state" }, 2500);
		if (stateResponse.success && stateResponse.data && typeof stateResponse.data === "object") {
			isStreaming = Boolean((stateResponse.data as { isStreaming?: boolean }).isStreaming);
		}
	} catch (error) {
		stateProbeError = error instanceof Error ? error.message : String(error);
		isStreaming = true;
	}

	let delivered = 0;
	const ackedMessageIds: string[] = [];
	try {
		for (const message of queued) {
			const formatted = formatDownwardMessage(message);
			const bridgeCommand = !isStreaming
				? { command: "prompt" as const, message: formatted }
				: message.deliveryMode === "follow_up" || message.deliveryMode === "idle_only"
					? { command: "follow_up" as const, message: formatted }
					: { command: "steer" as const, message: formatted };
			const response = await sendRpcBridgeCommand(socketPath, bridgeCommand, 5000);
			if (!response.success) throw new Error(response.error ?? `RPC bridge rejected ${message.kind}.`);
			markInbox(db, [message.id], "acked", {
				childId: parent.id,
				transportKind: "rpc_bridge",
			});
			ackedMessageIds.push(message.id);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: parent.id,
				eventType: "parent_publish_live_delivered",
				summary: payloadSummary(message),
				payload: { messageId: message.id, bridgeCommand: bridgeCommand.command, deliveryMode: message.deliveryMode },
			});
			delivered += 1;
			isStreaming = true;
		}
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "live",
			bridgeSocketPath: socketPath,
			bridgeConnectedAt: now,
			bridgeUpdatedAt: now,
			bridgeLastError: stateProbeError,
			updatedAt: now,
		});
		return { attempted: true, delivered, deferred: Math.max(0, queued.length - delivered), transportState: "live", ackedMessageIds };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const now = Date.now();
		updateAgent(db, parent.id, {
			transportKind: "rpc_bridge",
			transportState: "fallback",
			bridgeUpdatedAt: now,
			bridgeLastError: message,
			updatedAt: now,
		});
		createAgentEvent(db, {
			id: randomUUID(),
			agentId: parent.id,
			eventType: "parent_publish_live_deferred",
			summary: message,
			payload: { error: message, queued: Math.max(0, queued.length - delivered), delivered, messageIds },
		});
		return {
			attempted: true,
			delivered,
			deferred: Math.max(0, queued.length - delivered),
			transportState: "fallback",
			ackedMessageIds,
			error: message,
		};
	}
}

