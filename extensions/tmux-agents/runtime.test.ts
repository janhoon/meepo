import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FULL_COORDINATOR_TOOL_NAMES,
	coordinatorToolNamesForConfig,
	createCoreDefaultConfig,
	createFullDefaultConfig,
	loadMeepoConfig,
} from "./config.js";
import { createMeepoRuntime } from "./runtime.js";

describe("loadMeepoConfig", () => {
	it("defaults to full preset with all coordinator capabilities (operator compatibility)", () => {
		const config = loadMeepoConfig({ env: {} });
		assert.equal(config.preset, "full");
		assert.equal(config.version, 1);
		assert.equal(config.policies.noWait, "enforce");
		assert.equal(config.policies.hierarchy, "enforce");
		assert.equal(config.policies.taskLeases, "on");
		assert.ok(config.capabilities.includes("agents.core"));
		assert.ok(config.capabilities.includes("tasks.core"));
		assert.ok(config.capabilities.includes("tasks.graph"));
		assert.ok(config.capabilities.includes("services"));
		assert.ok(config.capabilities.includes("ui"));
	});

	it("respects MEEPO_PRESET=core from env when options.preset is omitted", () => {
		const config = loadMeepoConfig({ env: { MEEPO_PRESET: "core" } });
		assert.equal(config.preset, "core");
		assert.equal(config.policies.noWait, "off");
		assert.equal(config.policies.hierarchy, "off");
		assert.ok(config.capabilities.includes("agents.core"));
		assert.ok(!config.capabilities.includes("tasks.core"));
		assert.ok(!config.capabilities.includes("services"));
	});
});

describe("MeepoRuntime full-default tool surface", () => {
	it("lists the full coordinator tool set for default/full config", () => {
		const runtime = createMeepoRuntime({ loadOptions: { env: {} } });
		const names = runtime.listCoordinatorToolNames();

		assert.deepEqual(names, [...FULL_COORDINATOR_TOOL_NAMES]);
		assert.equal(names.length, FULL_COORDINATOR_TOOL_NAMES.length);

		// Spot-check families operators rely on today
		for (const required of [
			"subagent_spawn",
			"subagent_message",
			"subagent_inbox",
			"task_create",
			"task_dispatch_ready",
			"task_subtree_control",
			"tmux_service_start",
			"tmux_service_reconcile",
		]) {
			assert.ok(names.includes(required), `missing tool ${required}`);
			assert.equal(runtime.shouldRegisterTool(required), true);
		}

		// Child-only publish is not a coordinator registration plan entry
		assert.equal(runtime.shouldRegisterTool("subagent_publish"), false);
	});

	it("createFullDefaultConfig matches loadMeepoConfig() tool plan", () => {
		const fromFactory = coordinatorToolNamesForConfig(createFullDefaultConfig());
		const fromLoad = coordinatorToolNamesForConfig(loadMeepoConfig({ env: {} }));
		assert.deepEqual(fromFactory, fromLoad);
		assert.deepEqual(fromFactory, [...FULL_COORDINATOR_TOOL_NAMES]);
	});

	it("core config plans a thinner agents-only surface (catalog readiness for later tickets)", () => {
		const runtime = createMeepoRuntime({ config: createCoreDefaultConfig() });
		const names = runtime.listCoordinatorToolNames();
		assert.ok(names.includes("subagent_spawn"));
		assert.ok(names.includes("subagent_inbox"));
		assert.ok(!names.includes("task_create"));
		assert.ok(!names.includes("tmux_service_start"));
		assert.ok(names.length < FULL_COORDINATOR_TOOL_NAMES.length);
	});
});
