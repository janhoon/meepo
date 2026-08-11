import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { resolveDownwardDeliveryMode } from "./child-status.js";
import type { ChildRuntimeEnvironment } from "./types.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeEnv(runDir: string, overrides: Partial<ChildRuntimeEnvironment> = {}): ChildRuntimeEnvironment {
	return {
		childId: "sa_test",
		runDir,
		profile: "worker",
		allowedTools: ["read"],
		taskId: null,
		parentAgentId: null,
		spawnSessionId: null,
		spawnSessionFile: null,
		transportKind: "rpc_bridge",
		bridgeStatusFile: join(runDir, "bridge-status.json"),
		...overrides,
	};
}

describe("resolveDownwardDeliveryMode", () => {
	it("does not throw ReferenceError when bridge-status is present (regression: readRpcBridgeStatus import)", () => {
		const runDir = mkdtempSync(join(tmpdir(), "meepo-child-status-"));
		tempDirs.push(runDir);
		writeFileSync(
			join(runDir, "bridge-status.json"),
			JSON.stringify({
				transportKind: "rpc_bridge",
				transportState: "live",
				updatedAt: Date.now(),
				lastError: null,
				socketPath: join(runDir, "bridge.sock"),
			}),
		);
		const result = resolveDownwardDeliveryMode(makeEnv(runDir));
		assert.equal(result.mode, "rpc_bridge");
		assert.equal(result.transportState, "live");
		assert.equal(result.reason, null);
	});

	it("falls back when bridge-status is missing without throwing", () => {
		const runDir = mkdtempSync(join(tmpdir(), "meepo-child-status-"));
		tempDirs.push(runDir);
		// Regression: missing imports previously threw ReferenceError("readRpcBridgeStatus is not defined").
		assert.doesNotThrow(() => resolveDownwardDeliveryMode(makeEnv(runDir)));
		const result = resolveDownwardDeliveryMode(makeEnv(runDir));
		assert.equal(result.mode, "poll_fallback");
		assert.equal(result.transportState, "fallback");
	});

	it("uses legacy mode when transport is not rpc_bridge", () => {
		const runDir = mkdtempSync(join(tmpdir(), "meepo-child-status-"));
		tempDirs.push(runDir);
		const result = resolveDownwardDeliveryMode(
			makeEnv(runDir, { transportKind: "legacy" as ChildRuntimeEnvironment["transportKind"] }),
		);
		assert.equal(result.mode, "poll_fallback");
		assert.equal(result.transportState, "legacy");
	});
});
