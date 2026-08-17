/**
 * Host-agnostic RPC bridge control plane helpers.
 *
 * Contract source: wayfinder #20 / #24 — same rpc_bridge on tmux and herdr.
 * herdr (or tmux) only hosts the process; delivery never uses host PTY typing.
 */

import { shellQuote } from "./text-util.js";
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
export function buildBridgeLaunchCommand(options: {
	nodeExecutable: string;
	bridgeEntryScript: string;
	bridgeConfigFile: string;
}): string {
	return `exec ${shellQuote(options.nodeExecutable)} ${shellQuote(options.bridgeEntryScript)} --config ${shellQuote(options.bridgeConfigFile)}`;
}

/** Operator-facing label for missing process-host targets (tmux pane or herdr terminal). */
export function missingHostTargetMessage(agentId: string): string {
	return `Cannot message agent ${agentId} because its host target is missing. Reconcile first.`;
}
