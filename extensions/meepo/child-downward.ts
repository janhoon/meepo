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
import type {
	AgentMessageRecord,
	AgentTransportState,
	DownwardMessageActionPolicy,
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


export function defaultDownwardActionPolicy(kind: AgentMessageRecord["kind"]): DownwardMessageActionPolicy {
	switch (kind) {
		case "answer":
			return "resume_if_blocked";
		case "redirect":
			return "interrupt_and_replan";
		case "cancel":
			return "stop";
		case "priority":
			return "replan";
		case "note":
		default:
			return "fyi";
	}
}

export function expectedHandlingLines(actionPolicy: DownwardMessageActionPolicy): string[] {
	switch (actionPolicy) {
		case "resume_if_blocked":
			return [
				"If this resolves your current blocker or waiting state, resume work now.",
				"Publish a concise note once you resume so the coordinator can track progress without capture.",
				"If you are still blocked after this message, publish one concrete blocker or question immediately.",
			];
		case "replan":
			return [
				"Revise your plan before the next substantive tool call if this changes your priorities.",
				"Publish a concise note if the plan or file focus changes.",
			];
		case "interrupt_and_replan":
			return [
				"Stop the current approach and replan before more substantive work.",
				"Publish a concise note after adopting this redirect, with exact file paths when relevant.",
			];
		case "stop":
			return [
				"Stop current work gracefully.",
				"Publish a completion-style handoff or cancellation summary before exiting if possible.",
			];
		case "fyi":
		default:
			return [
				"Treat this as additional context. Continue unless it materially changes your plan.",
				"Publish a concise note only if this changes your course of action.",
			];
	}
}

export function formatDownwardMessage(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
	const actionPolicy = payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind);
	const sender = payload.senderAgentId ?? message.senderAgentId ?? "root";
	const route = payload.routeKind ? ` · route ${payload.routeKind}` : "";
	const lines = [`[Hierarchy ${message.kind} · from ${sender} · action ${actionPolicy}${route}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.inReplyToMessageId) {
		lines.push("", `Replying to message: ${payload.inReplyToMessageId}`);
	}
	lines.push("", "Expected handling:");
	for (const line of expectedHandlingLines(actionPolicy)) {
		lines.push(`- ${line}`);
	}
	return lines.join("\n");
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
	legacyMessageIds: string[];
	v2AckedMessageIds: string[];
	error?: string;
	reason?: string;
}

export function getV2Payload(message: AgentMessageRecord): DownwardMessagePayload | null {
	return message.payload && typeof message.payload === "object" ? (message.payload as DownwardMessagePayload) : null;
}

export function markV2RecipientStatusForLegacyMessage(
	db: ReturnType<typeof getMeepoDb>,
	message: AgentMessageRecord,
	status: "read" | "acked",
	recipientAgentId: string,
	transportKind: "rpc_bridge" | "poll_fallback",
): string | null {
	const payload = getV2Payload(message);
	if (payload?.v2RecipientRowId) {
		markInbox(db, [payload.v2RecipientRowId], status === "acked" ? "acked" : "delivered", { childId: recipientAgentId, transportKind });
		return payload.v2MessageId ?? null;
	}
	if (payload?.v2MessageId) {
		markInbox(db, [payload.v2MessageId], status === "acked" ? "acked" : "delivered", { childId: recipientAgentId, transportKind });
		return payload.v2MessageId;
	}
	return null;
}

export async function deliverQueuedParentMessagesViaBridge(parentAgentId: string): Promise<ParentPublishDeliveryResult> {
	const db = getMeepoDb();
	const queued = listChildDeliveryQueue(db, parentAgentId, { limit: 50 });
	const legacyMessageIds = queued.map((message) => message.id);
	const parent = getAgent(db, parentAgentId);
	if (!parent) {
		return { attempted: false, delivered: 0, deferred: queued.length, transportState: "missing", legacyMessageIds, v2AckedMessageIds: [], reason: "Parent agent was not found." };
	}
	if (queued.length === 0) {
		return { attempted: false, delivered: 0, deferred: 0, transportState: parent.transportState, legacyMessageIds, v2AckedMessageIds: [] };
	}
	if (parent.transportKind !== "rpc_bridge") {
		return {
			attempted: false,
			delivered: 0,
			deferred: queued.length,
			transportState: parent.transportState,
			legacyMessageIds,
			v2AckedMessageIds: [],
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
			payload: { queued: queued.length, legacyMessageIds },
		});
		return {
			attempted: true,
			delivered: 0,
			deferred: queued.length,
			transportState: "fallback",
			legacyMessageIds,
			v2AckedMessageIds: [],
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
	const v2AckedMessageIds: string[] = [];
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
			const ackedV2MessageId = markV2RecipientStatusForLegacyMessage(db, message, "acked", parent.id, "rpc_bridge");
			markInbox(db, [getV2Payload(message)?.v2RecipientRowId ?? message.id], "acked", {
				childId: parent.id,
				transportKind: "rpc_bridge",
			});
			if (ackedV2MessageId) v2AckedMessageIds.push(ackedV2MessageId);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: parent.id,
				eventType: "parent_publish_live_delivered",
				summary: getV2Payload(message)?.summary ?? `${message.kind} delivered via RPC bridge`,
				payload: { messageId: message.id, v2MessageId: ackedV2MessageId, bridgeCommand: bridgeCommand.command, deliveryMode: message.deliveryMode },
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
		return { attempted: true, delivered, deferred: Math.max(0, queued.length - delivered), transportState: "live", legacyMessageIds, v2AckedMessageIds };
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
			payload: { error: message, queued: Math.max(0, queued.length - delivered), delivered, legacyMessageIds },
		});
		return {
			attempted: true,
			delivered,
			deferred: Math.max(0, queued.length - delivered),
			transportState: "fallback",
			legacyMessageIds,
			v2AckedMessageIds,
			error: message,
		};
	}
}

