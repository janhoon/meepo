import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	buildBridgeLaunchCommand,
	isSharedRpcBridgeTransport,
	mapDeliveryModeToBridgeCommand,
	missingHostTargetMessage,
} from "./rpc-bridge-control.js";
import { hostTargetRefFromLegacy } from "./process-host.js";

describe("rpc bridge control plane (host-agnostic, wayfinder #20/#24)", () => {
	it("maps delivery modes to bridge commands only (no host PTY path)", () => {
		assert.equal(mapDeliveryModeToBridgeCommand("immediate", { isStreaming: false }), "prompt");
		assert.equal(mapDeliveryModeToBridgeCommand("steer", { isStreaming: false }), "prompt");
		assert.equal(mapDeliveryModeToBridgeCommand("follow_up", { isStreaming: false }), "prompt");
		assert.equal(mapDeliveryModeToBridgeCommand("idle_only", { isStreaming: false }), "prompt");

		assert.equal(mapDeliveryModeToBridgeCommand("immediate", { isStreaming: true }), "steer");
		assert.equal(mapDeliveryModeToBridgeCommand("steer", { isStreaming: true }), "steer");
		assert.equal(mapDeliveryModeToBridgeCommand("follow_up", { isStreaming: true }), "follow_up");
		assert.equal(mapDeliveryModeToBridgeCommand("idle_only", { isStreaming: true }), "follow_up");
	});

	it("treats rpc_bridge as the only shared control-plane transport kind", () => {
		assert.equal(isSharedRpcBridgeTransport("rpc_bridge"), true);
		assert.equal(isSharedRpcBridgeTransport("legacy"), false);
		assert.equal(isSharedRpcBridgeTransport(null), false);
		// Explicit non-goal: no herdr-native transport kind.
		assert.equal(isSharedRpcBridgeTransport("rpc_bridge_herdr"), false);
		assert.equal(isSharedRpcBridgeTransport("herdr_pty"), false);
	});

	it("builds identical bridge launch command for every ProcessHost backend", () => {
		const command = buildBridgeLaunchCommand({
			nodeExecutable: "/usr/bin/node",
			bridgeEntryScript: "/pkg/extensions/tmux-agents/rpc-bridge.mjs",
			bridgeConfigFile: "/tmp/runs/sa_1/bridge-config.json",
		});
		assert.equal(
			command,
			"exec '/usr/bin/node' '/pkg/extensions/tmux-agents/rpc-bridge.mjs' --config '/tmp/runs/sa_1/bridge-config.json'",
		);
		assert.match(command, /rpc-bridge\.mjs/);
		// Bridge is the main process — not bare `pi`, and not a host CLI wrapper.
		// (Path may still contain the extension dir name `tmux-agents`.)
		assert.doesNotMatch(command, /(^|[\s'"])pi([\s'"]|$)/);
		assert.doesNotMatch(command, /(^|[\s'"])herdr([\s'"]|$)/);
		assert.doesNotMatch(command, /(^|[\s'"])tmux([\s'"]|$)/);
	});

	it("resolves herdr registry fields for message/stop targetExists gates", () => {
		const ref = hostTargetRefFromLegacy({
			hostKind: "herdr",
			hostPrimaryId: "term_abc",
			hostDisplayName: "research-herdr",
			hostTargetJson: JSON.stringify({
				terminalId: "term_abc",
				paneId: "w1:p2",
				workspaceId: "ws_1",
				tabId: "tab_1",
				agentName: "research-herdr",
			}),
			tmuxSessionId: null,
			tmuxSessionName: null,
			tmuxWindowId: null,
			tmuxPaneId: null,
		});
		assert.equal(ref.hostKind, "herdr");
		assert.equal(ref.primaryId, "term_abc");
		assert.equal(ref.displayName, "research-herdr");
		assert.equal(ref.refs?.terminalId, "term_abc");
		assert.equal(ref.refs?.paneId, "w1:p2");
	});

	it("uses host-neutral missing-target errors for messaging", () => {
		const message = missingHostTargetMessage("sa_test");
		assert.match(message, /host target is missing/);
		assert.doesNotMatch(message, /tmux/);
	});
});
