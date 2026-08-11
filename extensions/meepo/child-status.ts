/**
 * Child runtime status snapshot (disk + DB).
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { updateAgent } from "./registry.js";
import type {
	ChildDownwardDeliveryMode,
	ChildRuntimeEnvironment,
	RuntimeStatusSnapshot,
} from "./types.js";

const BRIDGE_TERMINAL_STATES = new Set<RuntimeStatusSnapshot["state"]>(["error", "stopped"]);

export function appendRunEvent(environment: ChildRuntimeEnvironment, eventType: string, summary: string, payload: unknown): void {
	appendFileSync(
		join(environment.runDir, "events.jsonl"),
		`${JSON.stringify({ id: randomUUID(), eventType, summary, payload, createdAt: Date.now() })}\n`,
	);
}

export function readLatestStatusFromDisk(environment: ChildRuntimeEnvironment): RuntimeStatusSnapshot | null {
	const statusFile = join(environment.runDir, "latest-status.json");
	if (!existsSync(statusFile)) return null;
	try {
		const parsed = JSON.parse(readFileSync(statusFile, "utf8"));
		return parsed && typeof parsed === "object" ? (parsed as RuntimeStatusSnapshot) : null;
	} catch {
		return null;
	}
}

export function writeLatestStatus(environment: ChildRuntimeEnvironment, snapshot: RuntimeStatusSnapshot): void {
	// Atomic temp-file + rename, matching rpc-bridge.mjs writeJson. Prevents readers
	// (bridge, parent) from observing partially-written JSON when the bridge and
	// child-runtime briefly contend on latest-status.json.
	const target = join(environment.runDir, "latest-status.json");
	const tempPath = `${target}.${process.pid}.${randomUUID()}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
	renameSync(tempPath, target);
}

export function resolveDownwardDeliveryMode(environment: ChildRuntimeEnvironment): {
	mode: ChildDownwardDeliveryMode;
	transportState: AgentTransportState;
	reason: string | null;
} {
	if (environment.transportKind !== "rpc_bridge") {
		return { mode: "poll_fallback", transportState: "legacy", reason: null };
	}
	const bridgeStatus = readRpcBridgeStatus(environment.bridgeStatusFile ?? join(environment.runDir, "bridge-status.json"));
	if (!bridgeStatus) {
		return {
			mode: "poll_fallback",
			transportState: "fallback",
			reason: "bridge-status.json is unavailable inside the child runtime",
		};
	}
	if (Date.now() - bridgeStatus.updatedAt > BRIDGE_STATUS_STALE_MS) {
		return {
			mode: "poll_fallback",
			transportState: "fallback",
			reason: `bridge status is stale (${Date.now() - bridgeStatus.updatedAt}ms old)`,
		};
	}
	if (POLL_FALLBACK_TRANSPORT_STATES.has(bridgeStatus.transportState)) {
		return {
			mode: "poll_fallback",
			transportState: bridgeStatus.transportState,
			reason: bridgeStatus.lastError ?? `bridge transport state is ${bridgeStatus.transportState}`,
		};
	}
	return {
		mode: "rpc_bridge",
		transportState: bridgeStatus.transportState,
		reason: null,
	};
}

export function updateStatus(
	environment: ChildRuntimeEnvironment,
	_ctx: ExtensionContext,
	patch: Partial<RuntimeStatusSnapshot>,
	currentState: RuntimeStatusSnapshot,
): RuntimeStatusSnapshot {
	// Merge with whatever is on disk so we don't regress bridge-owned fields that were
	// written after our in-memory snapshot was last computed.
	const onDisk = environment.transportKind === "rpc_bridge" ? readLatestStatusFromDisk(environment) : null;
	const isBridgeTerminalOnDisk = !!onDisk && onDisk.source === "rpc_bridge" && BRIDGE_TERMINAL_STATES.has(onDisk.state);
	const now = Date.now();
	const updatedAt = patch.updatedAt ?? now;

	// If the bridge already recorded a terminal state, the child-runtime must not regress it
	// to running/launching or overwrite its error/finish metadata.
	if (isBridgeTerminalOnDisk && onDisk) {
		const preservedState: RuntimeStatusSnapshot = {
			...currentState,
			...onDisk,
			// Allow child-owned preview fields to update even after terminal bridge state.
			lastAssistantPreview: patch.lastAssistantPreview ?? onDisk.lastAssistantPreview ?? currentState.lastAssistantPreview ?? null,
			lastToolName: onDisk.lastToolName ?? null,
			source: onDisk.source ?? "rpc_bridge",
			transportKind: onDisk.transportKind ?? environment.transportKind,
			transportState: onDisk.transportState ?? currentState.transportState ?? null,
			downwardDeliveryMode: onDisk.downwardDeliveryMode ?? currentState.downwardDeliveryMode ?? null,
			updatedAt: Math.max(onDisk.updatedAt ?? 0, updatedAt),
		};
		writeLatestStatus(environment, preservedState);
		// Do not touch the DB state/terminal columns in this branch; reconcile will sync from disk.
		updateAgent(getMeepoDb(), environment.childId, {
			lastAssistantPreview: preservedState.lastAssistantPreview ?? null,
			updatedAt: preservedState.updatedAt,
		});
		return preservedState;
	}

	const nextState: RuntimeStatusSnapshot = {
		...currentState,
		...(onDisk ?? {}),
		...patch,
		source: patch.source ?? "child_runtime",
		transportKind: patch.transportKind ?? currentState.transportKind ?? environment.transportKind,
		transportState:
			patch.transportState ??
			currentState.transportState ??
			(environment.transportKind === "rpc_bridge" ? "launching" : "legacy"),
		downwardDeliveryMode:
			patch.downwardDeliveryMode ??
			currentState.downwardDeliveryMode ??
			(environment.transportKind === "rpc_bridge" ? "rpc_bridge" : "poll_fallback"),
		updatedAt,
	};
	writeLatestStatus(environment, nextState);
	updateAgent(getMeepoDb(), environment.childId, {
		state: nextState.state,
		transportKind: nextState.transportKind ?? undefined,
		transportState: nextState.transportState ?? undefined,
		bridgeUpdatedAt: nextState.transportKind === "rpc_bridge" ? nextState.updatedAt : undefined,
		lastToolName: nextState.lastToolName ?? null,
		lastAssistantPreview: nextState.lastAssistantPreview ?? null,
		lastError: nextState.lastError ?? null,
		finalSummary: nextState.finalSummary ?? null,
		updatedAt: nextState.updatedAt,
		finishedAt: nextState.finishedAt ?? null,
	});
	return nextState;
}

