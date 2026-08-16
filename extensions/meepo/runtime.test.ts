import assert from "node:assert/strict";
import { DatabaseSync } from "./sqlite.js";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	FULL_COORDINATOR_COMMAND_NAMES,
	FULL_COORDINATOR_TOOL_NAMES,
	coordinatorCommandNamesForConfig,
	coordinatorToolNamesForConfig,
	createCoreDefaultConfig,
	createFullDefaultConfig,
	loadMeepoConfig,
	type MeepoCapability,
	type MeepoConfig,
} from "./config.js";
import { countOrgRoleSeeds } from "./org-preset.js";
import { createCapabilityFilteredExtensionApi, createMeepoRuntime } from "./runtime.js";

function withTmuxHost(config: MeepoConfig): MeepoConfig {
	return {
		...config,
		runtime: {
			...config.runtime,
			processHost: "tmux",
		},
	};
}

function createRecordingPi(): { pi: ExtensionAPI } {
	const pi = {
		registerTool(_tool: { name: string }) {},
		registerCommand(_name: string) {},
		registerShortcut() {},
		on() {},
	} as unknown as ExtensionAPI;
	return { pi };
}

/** Simulate today's registrar: attempt every known tool/command/shortcut. */
function registerAllKnownSurface(pi: ExtensionAPI): void {
	for (const name of FULL_COORDINATOR_TOOL_NAMES) {
		pi.registerTool({ name } as Parameters<ExtensionAPI["registerTool"]>[0]);
	}
	// child-only
	pi.registerTool({ name: "subagent_publish" } as Parameters<ExtensionAPI["registerTool"]>[0]);
	for (const name of FULL_COORDINATOR_COMMAND_NAMES) {
		pi.registerCommand(name, { description: name, handler: async () => {} });
	}
	// five operator shortcuts (as in index today)
	for (let i = 0; i < 5; i++) {
		pi.registerShortcut("k" as never, { description: "x", handler: async () => {} });
	}
}

describe("loadMeepoConfig", () => {
	it("defaults to core preset (methodology-neutral platform)", () => {
		const config = loadMeepoConfig({ env: {} });
		assert.equal(config.preset, "core");
		assert.equal(config.version, 1);
		assert.equal(config.policies.noWait, "off");
		assert.equal(config.policies.hierarchy, "off");
		assert.equal(config.policies.taskLeases, "off");
		assert.ok(config.capabilities.includes("agents.core"));
		assert.ok(config.capabilities.includes("agents.attention"));
		assert.ok(!config.capabilities.includes("tasks.core"));
		assert.ok(!config.capabilities.includes("services"));
		assert.ok(!config.capabilities.includes("ui"));
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
	it("lists the full coordinator tool set for explicit full config", () => {
		const runtime = createMeepoRuntime({ loadOptions: { env: {}, preset: "full" } });
		const names = runtime.listCoordinatorToolNames();

		assert.deepEqual(names, [...FULL_COORDINATOR_TOOL_NAMES]);
		assert.equal(names.length, FULL_COORDINATOR_TOOL_NAMES.length);
		assert.ok(names.includes("service_start"));
		assert.ok(names.includes("tmux_service_start"), "legacy service alias remains registered");
		assert.equal(runtime.shouldRegisterTool("tmux_service_start"), true);

		for (const required of [
			"subagent_spawn",
			"subagent_message",
			"subagent_inbox",
			"task_create",
			"task_dispatch_ready",
			"task_subtree_control",
			"service_start",
			"service_reconcile",
		]) {
			assert.ok(names.includes(required), `missing tool ${required}`);
			assert.equal(runtime.shouldRegisterTool(required), true);
		}

		// Child-only publish is allowed through the filter when a child registers it,
		// but is not part of the coordinator plan list.
		assert.ok(!names.includes("subagent_publish"));
		assert.equal(runtime.shouldRegisterTool("subagent_publish"), true);
	});

	it("createFullDefaultConfig matches loadMeepoConfig({ preset: full }) tool plan", () => {
		const fromFactory = coordinatorToolNamesForConfig(createFullDefaultConfig());
		const fromLoad = coordinatorToolNamesForConfig(loadMeepoConfig({ env: {}, preset: "full" }));
		assert.deepEqual(fromFactory, fromLoad);
		assert.deepEqual(fromFactory, [...FULL_COORDINATOR_TOOL_NAMES]);
	});

	it("default loadMeepoConfig is core and thinner than full", () => {
		const coreNames = coordinatorToolNamesForConfig(loadMeepoConfig({ env: {} }));
		assert.ok(coreNames.includes("subagent_spawn"));
		assert.ok(!coreNames.includes("task_create"));
		assert.ok(coreNames.length < FULL_COORDINATOR_TOOL_NAMES.length);
	});

	it("core config plans a thinner agents-only surface", () => {
		const runtime = createMeepoRuntime({ config: createCoreDefaultConfig() });
		const names = runtime.listCoordinatorToolNames();
		assert.ok(names.includes("subagent_spawn"));
		assert.ok(names.includes("subagent_inbox"));
		assert.ok(!names.includes("task_create"));
		assert.ok(!names.includes("service_start"));
		assert.ok(!names.includes("tmux_service_start"));
		assert.ok(names.length < FULL_COORDINATOR_TOOL_NAMES.length);
	});
});

describe("capability-gated registration", () => {
	it("full config registers all coordinator tools, commands, and shortcuts", () => {
		const config = createFullDefaultConfig();
		const rec = createRecordingPi();
		const filter = createCapabilityFilteredExtensionApi(rec.pi, config);
		registerAllKnownSurface(filter.api);

		assert.deepEqual(
			filter.registeredTools.filter((n) => n !== "subagent_publish"),
			[...FULL_COORDINATOR_TOOL_NAMES],
		);
		assert.ok(filter.registeredTools.includes("subagent_publish"));
		assert.deepEqual(filter.registeredCommands, [...FULL_COORDINATOR_COMMAND_NAMES]);
		assert.equal(filter.registeredShortcutCount, 5);
	});

	it("core config registers agents tools/commands only — no tasks, services, or ui chrome", () => {
		const config = createCoreDefaultConfig();
		const rec = createRecordingPi();
		const filter = createCapabilityFilteredExtensionApi(rec.pi, config);
		registerAllKnownSurface(filter.api);

		const planned = coordinatorToolNamesForConfig(config);
		assert.deepEqual(
			filter.registeredTools.filter((n) => n !== "subagent_publish"),
			planned,
		);
		assert.ok(filter.registeredTools.includes("subagent_spawn"));
		assert.ok(filter.registeredTools.includes("subagent_inbox"));
		assert.ok(!filter.registeredTools.includes("task_create"));
		assert.ok(!filter.registeredTools.includes("task_dispatch_ready"));
		assert.ok(!filter.registeredTools.includes("service_start"));
		assert.ok(!filter.registeredTools.includes("tmux_service_start"));

		const plannedCommands = coordinatorCommandNamesForConfig(config);
		assert.deepEqual(filter.registeredCommands, plannedCommands);
		assert.ok(filter.registeredCommands.includes("agents"));
		assert.ok(filter.registeredCommands.includes("agent-attention"));
		assert.ok(!filter.registeredCommands.includes("task-board"));
		assert.ok(!filter.registeredCommands.includes("tasks"));
		assert.ok(!filter.registeredCommands.includes("services"));
		assert.equal(filter.registeredShortcutCount, 0);
	});

	it("supports capability independence: services without tasks", () => {
		const config = loadMeepoConfig({
			env: {},
			preset: "core",
			capabilities: ["agents.core", "services"] as MeepoCapability[],
		});
		const rec = createRecordingPi();
		const filter = createCapabilityFilteredExtensionApi(rec.pi, config);
		registerAllKnownSurface(filter.api);

		assert.ok(filter.registeredTools.includes("subagent_spawn"));
		assert.ok(filter.registeredTools.includes("service_start"));
		assert.ok(filter.registeredTools.includes("tmux_service_start"));
		assert.ok(!filter.registeredTools.includes("task_create"));
		assert.ok(!filter.registeredTools.includes("subagent_inbox")); // attention not enabled
		assert.ok(filter.registeredCommands.includes("services"));
		assert.ok(!filter.registeredCommands.includes("tasks"));
	});

	it("MeepoRuntime.start applies the filter when a registrar is provided", () => {
		const rec = createRecordingPi();
		const runtime = createMeepoRuntime({
			config: withTmuxHost(createCoreDefaultConfig()),
			registerCoordinatorTools: (pi) => {
				registerAllKnownSurface(pi);
			},
		});
		runtime.start(rec.pi);
		const snap = runtime.getLastRegistrationSnapshot();
		assert.ok(snap);
		assert.ok(snap!.tools.includes("subagent_spawn"));
		assert.ok(!snap!.tools.includes("task_create"));
		assert.ok(!snap!.tools.includes("service_start"));
		assert.equal(snap!.shortcutCount, 0);
	});

	it("full preset start seeds org roles when getDb is provided", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE agent_roles (
				role_key TEXT PRIMARY KEY, label TEXT, authority_rank INTEGER,
				default_visibility_scope TEXT, can_spawn_children INTEGER, can_admin_override INTEGER,
				metadata_json TEXT, created_at INTEGER, updated_at INTEGER
			);
			CREATE TABLE agent_role_edge_policies (
				id TEXT PRIMARY KEY, parent_role_key TEXT, child_role_key TEXT, edge_type TEXT,
				allow_spawn INTEGER, allow_parent_to_child_message INTEGER, allow_child_to_parent_message INTEGER,
				allow_parent_inspect_child INTEGER, allow_child_inspect_parent INTEGER, allow_parent_inspect_subtree INTEGER,
				metadata_json TEXT, created_at INTEGER, updated_at INTEGER
			);
		`);
		const rec = createRecordingPi();
		const runtime = createMeepoRuntime({
			config: withTmuxHost(createFullDefaultConfig()),
			getDb: () => db,
			registerCoordinatorTools: () => {},
		});
		runtime.start(rec.pi);
		assert.equal(runtime.didApplyOrgPreset(), true);
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto", "engineer"]), 3);
	});

	it("core preset start does not seed org roles", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(`
			CREATE TABLE agent_roles (
				role_key TEXT PRIMARY KEY, label TEXT, authority_rank INTEGER,
				default_visibility_scope TEXT, can_spawn_children INTEGER, can_admin_override INTEGER,
				metadata_json TEXT, created_at INTEGER, updated_at INTEGER
			);
			CREATE TABLE agent_role_edge_policies (
				id TEXT PRIMARY KEY, parent_role_key TEXT, child_role_key TEXT, edge_type TEXT,
				allow_spawn INTEGER, allow_parent_to_child_message INTEGER, allow_child_to_parent_message INTEGER,
				allow_parent_inspect_child INTEGER, allow_child_inspect_parent INTEGER, allow_parent_inspect_subtree INTEGER,
				metadata_json TEXT, created_at INTEGER, updated_at INTEGER
			);
		`);
		const rec = createRecordingPi();
		const runtime = createMeepoRuntime({
			config: withTmuxHost(createCoreDefaultConfig()),
			getDb: () => db,
			registerCoordinatorTools: () => {},
		});
		runtime.start(rec.pi);
		assert.equal(runtime.didApplyOrgPreset(), false);
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto"]), 0);
	});
});
