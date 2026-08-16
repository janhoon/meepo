/**
 * Child fleet: stop, focus, capture, reconcile Children.
 */
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { getRpcBridgeSocketPath, pingRpcBridge, readRpcBridgeStatus } from "./rpc-client.js";
import {
	createAgentEvent,
	getAgent,
	listAgents,
	updateAgent,
} from "./registry.js";
import { unlinkTaskAgent } from "./task-registry.js";
import { listOpenAttention, markAttention } from "./inbox.js";
import { getProcessHost, type HostIdentity } from "./process-host.js";
import { deliverQueuedMessagesViaBridge, queueDownwardMessage } from "./bridge-delivery.js";
import type { CleanupCandidate } from "./cleanup-types.js";
import { OPEN_ATTENTION_STATES, TERMINAL_AGENT_STATES } from "./registry-shared.js";
import { resolveAgentFilters } from "./session-scope.js";
import type { AgentSummary, RuntimeStatusSnapshot, UpdateAgentInput } from "./types.js";

function requireHost(agent: AgentSummary): HostIdentity {
	if (!agent.host) {
		throw new Error(`Child ${agent.id} has no HostTarget. Reconcile or spawn first.`);
	}
	return agent.host;
}

export async function focusAgentById(id: string): Promise<{
	agent: AgentSummary;
	result: { focused: boolean; command: string; reason?: string };
}> {
	const agent = getAgent(getMeepoDb(), id);
	if (!agent) throw new Error(`Unknown agent id "${id}".`);
	const result = await getProcessHost().focus(requireHost(agent));
	return { agent, result };
}

export async function captureAgentById(
	id: string,
	lines = 200,
): Promise<{ agent: AgentSummary; content: string; command: string }> {
	const agent = getAgent(getMeepoDb(), id);
	if (!agent) throw new Error(`Unknown agent id "${id}".`);
	const host = getProcessHost();
	const target = requireHost(agent);
	if (!(await host.targetExists(target))) {
		throw new Error(`Cannot capture agent ${agent.id} because its host target is missing. Reconcile first.`);
	}
	const result = await host.capture(target, { lines });
	return { agent, content: result.content, command: result.command };
}

export async function listCleanupCandidates(
	ctx: ExtensionContext,
	params: { scope?: "all" | "current_project" | "current_session" | "descendants"; ids?: string[]; force?: boolean; limit?: number },
): Promise<CleanupCandidate[]> {
	const db = getMeepoDb();
	const host = getProcessHost();
	const inventory = await host.listInventory();
	const agents =
		params.ids && params.ids.length > 0
			? listAgents(db, { ids: params.ids, limit: params.limit ?? params.ids.length })
			: listAgents(db, resolveAgentFilters(ctx, params.scope ?? "current_project", { limit: params.limit }));
	const openItems = listOpenAttention(db, {
		childIds: agents.map((agent) => agent.id),
		states: OPEN_ATTENTION_STATES,
		limit: 500,
	});
	const attentionByAgent = new Map<string, typeof openItems>();
	for (const item of openItems) {
		const items = attentionByAgent.get(item.agentId) ?? [];
		items.push(item);
		attentionByAgent.set(item.agentId, items);
	}
	const candidates: CleanupCandidate[] = [];
	for (const agent of agents.filter((agent) => TERMINAL_AGENT_STATES.includes(agent.state))) {
		const items = (attentionByAgent.get(agent.id) ?? []).sort(
			(left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt,
		);
		const targetExists = agent.host ? await host.targetExists(agent.host, inventory) : false;
		const blockingItems = items.filter((item) => item.kind !== "complete");
		let cleanupAllowed = targetExists;
		let reason = !targetExists
			? "host target already gone"
			: items.length === 0
				? "no unresolved attention items"
				: "completion attention can be resolved during cleanup";
		if (blockingItems.length > 0 && !(params.force ?? false)) {
			cleanupAllowed = false;
			reason = `blocked by unresolved ${blockingItems[0]!.kind}`;
		}
		if (blockingItems.length > 0 && (params.force ?? false)) {
			reason = `force cleanup despite unresolved ${blockingItems[0]!.kind}`;
		}
		if (targetExists || params.ids?.includes(agent.id)) {
			candidates.push({ agent, attentionItems: items, targetExists, cleanupAllowed, reason });
		}
	}
	return candidates;
}

export async function cleanupAgentTarget(
	candidate: CleanupCandidate,
	force = false,
): Promise<{ agentId: string; cleaned: boolean; reason: string; command: string }> {
	const db = getMeepoDb();
	const agent = candidate.agent;
	const host = getProcessHost();
	if (!agent.host || !(await host.targetExists(agent.host))) {
		return { agentId: agent.id, cleaned: false, reason: "host target already gone", command: "(already gone)" };
	}
	const result = await host.stop(agent.host, { force: true });
	const now = Date.now();
	const completionItems = candidate.attentionItems.filter((item) => item.kind === "complete");
	if (completionItems.length > 0) {
		markAttention(
			db,
			agent.id,
			{
				state: "resolved",
				updatedAt: now,
				resolvedAt: now,
				resolutionKind: "cleanup",
				resolutionSummary: "Agent host target cleaned up after completion.",
			},
			{ states: OPEN_ATTENTION_STATES, kinds: ["complete"] },
		);
	}
	if (force) {
		const blockingKinds = candidate.attentionItems.filter((item) => item.kind !== "complete").map((item) => item.kind);
		if (blockingKinds.length > 0) {
			markAttention(
				db,
				agent.id,
				{
					state: "cancelled",
					updatedAt: now,
					resolvedAt: now,
					resolutionKind: "cleanup_force",
					resolutionSummary: "Agent host target force-cleaned while unresolved attention remained.",
				},
				{ states: OPEN_ATTENTION_STATES, kinds: ["question", "question_for_user", "blocked"] },
			);
		}
	}
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: agent.id,
		eventType: "cleaned_up",
		summary: force ? "Cleaned up host target with force." : "Cleaned up host target after terminal state.",
		payload: { command: result.command, force },
	});
	if (agent.taskId) {
		unlinkTaskAgent(db, agent.taskId, agent.id, force ? "cleanup_force" : "cleanup_terminal_agent");
	}
	updateAgent(db, agent.id, { updatedAt: now });
	return { agentId: agent.id, cleaned: true, reason: force ? "force-cleaned" : "cleaned", command: result.command };
}

export function readLatestStatus(agent: AgentSummary): RuntimeStatusSnapshot | null {
	const statusFile = resolve(agent.runDir, "latest-status.json");
	if (!existsSync(statusFile)) return null;
	try {
		return JSON.parse(readFileSync(statusFile, "utf8")) as RuntimeStatusSnapshot;
	} catch {
		return null;
	}
}

export async function stopAgentById(
	id: string,
	force: boolean,
	reason?: string,
): Promise<{
	agent: AgentSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
}> {
	const agent = getAgent(getMeepoDb(), id);
	if (!agent) throw new Error(`Unknown agent id "${id}".`);
	if (!force && ["done", "error", "stopped", "lost"].includes(agent.state)) {
		throw new Error(`Agent ${agent.id} is already in terminal state ${agent.state}.`);
	}
	const host = getProcessHost();
	const target = agent.host;
	const targetExists = target ? await host.targetExists(target) : false;
	if (!targetExists && force) {
		updateAgent(getMeepoDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		if (agent.taskId) {
			unlinkTaskAgent(getMeepoDb(), agent.taskId, agent.id, reason?.trim() || "force_stop_missing_host_target");
		}
		markAttention(
			getMeepoDb(),
			agent.id,
			{
				state: "cancelled",
				updatedAt: Date.now(),
				resolvedAt: Date.now(),
				resolutionKind: "force_stop",
				resolutionSummary: reason?.trim() || "host target missing; registry marked stopped.",
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
		);
		createAgentEvent(getMeepoDb(), {
			id: randomUUID(),
			agentId: agent.id,
			eventType: "force_stopped",
			summary: reason?.trim() || "host target missing; registry marked stopped.",
			payload: { command: "(host target already missing)" },
		});
		return {
			agent: getAgent(getMeepoDb(), agent.id) ?? agent,
			result: {
				stopped: true,
				graceful: false,
				command: "(host target already missing)",
				reason: "host target was already gone; registry marked stopped.",
			},
		};
	}
	if (!targetExists && !force) {
		throw new Error(`Agent ${agent.id} no longer has a live host target. Use force stop or reconcile.`);
	}
	if (!force) {
		const cancelMessageId = queueDownwardMessage(
			agent,
			"cancel",
			{
				summary: reason?.trim() || "Stop requested by coordinator.",
				details: reason?.trim() || "Please stop current work and provide a short completion or blocker handoff.",
			},
			"immediate",
		);
		const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
		const cancelStillQueued = liveDelivery.deferred > 0 || liveDelivery.transportState === "busy";
		if (liveDelivery.delivered > 0 || cancelStillQueued) {
			createAgentEvent(getMeepoDb(), {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "graceful_stop_requested",
				summary: reason?.trim() || "Stop requested via RPC bridge.",
				payload: { liveDelivery, cancelMessageId, cancelStillQueued },
			});
			return {
				agent: getAgent(getMeepoDb(), agent.id) ?? agent,
				result: {
					stopped: false,
					graceful: true,
					command: liveDelivery.delivered > 0 ? "rpc cancel" : "queued cancel",
					reason:
						liveDelivery.delivered > 0
							? "Cancel delivered via RPC bridge. Waiting for the child to stop gracefully."
							: "Cancel is queued for graceful child delivery. Waiting for the child to stop before falling back to host kill.",
				},
			};
		}
	}
	const result = await host.stop(target!, { force });
	if (force) {
		updateAgent(getMeepoDb(), agent.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: reason?.trim() || agent.lastError,
		});
		if (agent.taskId) {
			unlinkTaskAgent(getMeepoDb(), agent.taskId, agent.id, reason?.trim() || "force_stop");
		}
		markAttention(
			getMeepoDb(),
			agent.id,
			{
				state: "cancelled",
				updatedAt: Date.now(),
				resolvedAt: Date.now(),
				resolutionKind: "force_stop",
				resolutionSummary: reason?.trim() || "Force stop issued by coordinator.",
			},
			{ states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"] },
		);
		createAgentEvent(getMeepoDb(), {
			id: randomUUID(),
			agentId: agent.id,
			eventType: "force_stopped",
			summary: reason?.trim() || "Force stop issued by coordinator.",
			payload: { command: result.command },
		});
	}
	return { agent: getAgent(getMeepoDb(), agent.id) ?? agent, result };
}

export async function reconcileAgents(
	ctx: ExtensionContext,
	params: { scope?: "all" | "current_project" | "current_session" | "descendants"; activeOnly?: boolean; limit?: number },
): Promise<{
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; transportState: string; reason: string }>;
}> {
	const scope = params.scope ?? "current_project";
	const filters = resolveAgentFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getMeepoDb();
	const agents = listAgents(db, filters);
	const host = getProcessHost();
	const inventory = await host.listInventory();
	const changed: Array<{ id: string; state: string; transportState: string; reason: string }> = [];
	const bridgeHealth = new Map(
		await Promise.all(
			agents
				.filter((agent) => agent.transportKind === "rpc_bridge")
				.map(async (agent) => [
					agent.id,
					{
						status: readRpcBridgeStatus(agent.bridgeStatusFile),
						ping: await pingRpcBridge(agent, 1200),
					},
				] as const),
		),
	);
	for (const agent of agents) {
		const latestStatus = readLatestStatus(agent);
		const bridge = bridgeHealth.get(agent.id);
		const bridgeStatus = bridge?.status ?? null;
		const bridgeReachable = Boolean(bridge?.ping?.success);
		const targetExists = agent.host ? await host.targetExists(agent.host, inventory) : false;
		let patch: UpdateAgentInput = {};
		let reason = "";
		if (bridgeStatus && bridgeStatus.updatedAt > (agent.bridgeUpdatedAt ?? 0)) {
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: bridgeStatus.transportState,
				bridgeSocketPath: bridgeStatus.socketPath ?? agent.bridgeSocketPath,
				bridgePid: bridgeStatus.bridgePid,
				bridgeConnectedAt: bridgeStatus.connectedAt ?? agent.bridgeConnectedAt,
				bridgeUpdatedAt: bridgeStatus.updatedAt,
				bridgeLastError: bridgeStatus.lastError ?? null,
			};
			reason = reason || "bridge-status.json was newer than the registry";
		}
		if (bridgeReachable) {
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: "live",
				bridgeSocketPath: getRpcBridgeSocketPath(agent),
				bridgeConnectedAt: bridgeStatus?.connectedAt ?? agent.bridgeConnectedAt ?? Date.now(),
				bridgeUpdatedAt: Date.now(),
				bridgeLastError: null,
				updatedAt: Date.now(),
			};
			reason = reason || "RPC bridge responded to health check";
		} else if (agent.transportKind === "rpc_bridge") {
			const inferredTransportState = !targetExists
				? "lost"
				: bridgeStatus?.transportState === "error"
					? "error"
					: bridgeStatus?.transportState === "stopped"
						? "stopped"
						: bridgeStatus?.transportState === "listening" || bridgeStatus?.transportState === "launching"
							? "disconnected"
							: "fallback";
			patch = {
				...patch,
				transportKind: "rpc_bridge",
				transportState: inferredTransportState,
				bridgeUpdatedAt: Date.now(),
				bridgeLastError:
					bridgeStatus?.lastError ??
					agent.bridgeLastError ??
					(targetExists ? "RPC bridge health check failed." : "host target missing during reconcile"),
			};
			reason =
				reason ||
				(targetExists
					? `RPC bridge not reachable; using ${inferredTransportState} transport state`
					: "host target missing during reconcile");
		}
		if (latestStatus && latestStatus.updatedAt > agent.updatedAt) {
			const preferLiveBridgeTransport = patch.transportKind === "rpc_bridge" && patch.transportState === "live";
			patch = {
				...patch,
				state: latestStatus.state,
				transportKind: preferLiveBridgeTransport ? patch.transportKind : latestStatus.transportKind ?? patch.transportKind,
				transportState: preferLiveBridgeTransport ? patch.transportState : latestStatus.transportState ?? patch.transportState,
				bridgeUpdatedAt: preferLiveBridgeTransport
					? patch.bridgeUpdatedAt
					: latestStatus.transportKind === "rpc_bridge" && latestStatus.transportState
						? latestStatus.updatedAt
						: patch.bridgeUpdatedAt,
				updatedAt: Math.max(latestStatus.updatedAt, patch.updatedAt ?? 0),
				finishedAt: latestStatus.finishedAt ?? agent.finishedAt,
				lastToolName: latestStatus.lastToolName,
				lastAssistantPreview: latestStatus.lastAssistantPreview,
				lastError: latestStatus.lastError,
				finalSummary: latestStatus.finalSummary,
			};
			reason = reason || "latest-status.json was newer than the registry";
		}
		if (!targetExists) {
			if (latestStatus && ["done", "error", "stopped"].includes(latestStatus.state)) {
				patch = {
					...patch,
					state: latestStatus.state,
					transportState:
						agent.transportKind === "rpc_bridge"
							? latestStatus.state === "error"
								? "error"
								: "stopped"
							: patch.transportState,
					updatedAt: Date.now(),
					finishedAt: latestStatus.finishedAt ?? Date.now(),
				};
				reason = reason || "host target exited after terminal latest-status update";
			} else if (["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)) {
				patch = {
					...patch,
					state: "lost",
					transportState: agent.transportKind === "rpc_bridge" ? "lost" : patch.transportState,
					bridgeUpdatedAt: agent.transportKind === "rpc_bridge" ? Date.now() : patch.bridgeUpdatedAt,
					updatedAt: Date.now(),
					lastError: agent.lastError ?? "host target missing during reconcile",
					bridgeLastError:
						agent.transportKind === "rpc_bridge"
							? (bridgeStatus?.lastError ?? agent.bridgeLastError ?? "host target missing during reconcile")
							: patch.bridgeLastError,
				};
				reason = reason || "host target missing during reconcile";
			}
		} else if (agent.state === "launching" && !latestStatus) {
			patch = {
				...patch,
				state: "running",
				updatedAt: Date.now(),
			};
			reason = reason || "host target exists and the child appears to be running";
		}
		if (Object.keys(patch).length > 0) {
			updateAgent(db, agent.id, patch);
			createAgentEvent(db, {
				id: randomUUID(),
				agentId: agent.id,
				eventType: "reconciled",
				summary: reason,
				payload: {
					state: patch.state ?? agent.state,
					transportState: patch.transportState ?? agent.transportState,
					targetExists,
					bridgeReachable,
				},
			});
			changed.push({
				id: agent.id,
				state: patch.state ?? agent.state,
				transportState: patch.transportState ?? agent.transportState,
				reason,
			});
		}
	}
	return { scope, reconciled: agents.length, changed };
}
