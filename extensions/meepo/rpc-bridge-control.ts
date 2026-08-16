/**
 * Host-agnostic RPC bridge control plane helpers.
 *
 * Contract source: wayfinder #20 / #24 — same rpc_bridge on tmux and herdr.
 * herdr (or tmux) only hosts the process; delivery never uses host PTY typing.
 */

import { spawnSync } from "node:child_process";
import type { DeliveryMode } from "./types.js";

export type RpcBridgeDownwardCommand = "prompt" | "steer" | "follow_up";

/**
 * Map Meepo deliveryMode → bridge command when the child is already streaming.
 * When the child is idle (!isStreaming), callers should use `prompt` instead.
 *
 * No host-specific branches: herdr send/pane APIs are intentionally absent.
 */
export function mapDeliveryModeToBridgeCommand(
	deliveryMode: DeliveryMode | string | null | undefined,
	options?: { isStreaming?: boolean },
): RpcBridgeDownwardCommand {
	if (!options?.isStreaming) return "prompt";
	if (deliveryMode === "follow_up" || deliveryMode === "idle_only") return "follow_up";
	// immediate, steer, unknown → steer while streaming
	return "steer";
}

/** True when transport is the shared socket bridge (not a host-native channel). */
export function isSharedRpcBridgeTransport(transportKind: string | null | undefined): boolean {
	return transportKind === "rpc_bridge";
}

/**
 * Launch argv fragment used as ProcessHost launchCommand on every backend.
 * Host adapters must run this as the pane main process (bridge supervises pi).
 */
export function looksLikeNodeExecutable(executable: string): boolean {
	const base = executable.replace(/\\/g, "/").split("/").pop() ?? executable;
	return base === "node" || base === "nodejs" || /^node\d/.test(base);
}

/**
 * The RPC bridge is a Node script. Compiled `pi` sets process.execPath to itself
 * and rejects `--config`, so the child pane exits immediately.
 */
export function resolveNodeExecutable(preferred?: string | null): string {
	if (preferred && looksLikeNodeExecutable(preferred)) return preferred;
	const result = spawnSync("bash", ["-lc", "command -v node"], { encoding: "utf8" });
	const found = result.stdout?.trim();
	if (found) return found;
	throw new Error(
		"Meepo child launch needs a Node executable on PATH. process.execPath is not Node (compiled pi?).",
	);
}

export function buildBridgeLaunchCommand(options: {
	nodeExecutable?: string | null;
	bridgeEntryScript: string;
	bridgeConfigFile: string;
	shellQuote?: (value: string) => string;
}): string {
	const q = options.shellQuote ?? ((value: string) => `'${value.replace(/'/g, `'"'"'`)}'`);
	const nodeExecutable = resolveNodeExecutable(options.nodeExecutable);
	return `exec ${q(nodeExecutable)} ${q(options.bridgeEntryScript)} --config ${q(options.bridgeConfigFile)}`;
}

/** Operator-facing label for missing process-host targets (tmux pane or herdr terminal). */
export function missingHostTargetMessage(agentId: string): string {
	return `Cannot message agent ${agentId} because its host target is missing. Reconcile first.`;
}
