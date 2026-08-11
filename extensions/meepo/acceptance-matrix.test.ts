/**
 * Consolidated PRD acceptance matrix for MeepoRuntime (issue #14 / parent #4).
 * No tmux / live Pi required. Failures name the matrix case.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	FULL_COORDINATOR_TOOL_NAMES,
	coordinatorToolNamesForConfig,
	createCoreDefaultConfig,
	createFullDefaultConfig,
	loadMeepoConfig,
	type MeepoCapability,
} from "./config.js";
import { evaluateHierarchySpawn } from "./hierarchy-policy.js";
import {
	applyNoWaitSystemPrompt,
	noWaitBashBlockReason,
} from "./no-wait-policy.js";
import {
	applyFullOrgPresetSeeds,
	countOrgRoleSeeds,
	shouldApplyFullOrgPreset,
} from "./org-preset.js";
import {
	clearProfileCompatRegistry,
	registerFullMeepoProfileCompat,
	resolveProfileLeaseKind,
	resolveProfileRoleKey,
} from "./profile-metadata.js";
import { setActiveProfileLoadOptions } from "./profile-load-options.js";
import { mergeProfilesByName, normalizeBuiltinTools } from "./profile-tools.js";
import { createCapabilityFilteredExtensionApi, createMeepoRuntime } from "./runtime.js";
import type { SubagentProfile } from "./types.js";

function caseName(name: string): string {
	return name;
}

function recordingPi(): ExtensionAPI {
	return {
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		on() {},
	} as unknown as ExtensionAPI;
}

function registerAllTools(pi: ExtensionAPI): void {
	for (const name of FULL_COORDINATOR_TOOL_NAMES) {
		pi.registerTool({ name } as Parameters<ExtensionAPI["registerTool"]>[0]);
	}
}

function stubProfile(name: string, filePath: string): SubagentProfile {
	return {
		name,
		description: name,
		systemPrompt: name,
		tools: ["read"],
		model: null,
		filePath,
		roleKey: null,
		lease: null,
		canSpawn: null,
	};
}

afterEach(() => {
	clearProfileCompatRegistry();
	setActiveProfileLoadOptions({ dirs: [], extraTools: [], allowUnknownTools: false });
});

describe("acceptance matrix: full preset", () => {
	it(caseName("full preset: tool surface + enforce policies + org seeder eligibility"), () => {
		const config = loadMeepoConfig({ env: {}, preset: "full" });
		assert.equal(config.preset, "full", "full preset");
		assert.deepEqual(
			coordinatorToolNamesForConfig(config),
			[...FULL_COORDINATOR_TOOL_NAMES],
			"full default tool catalog",
		);
		assert.equal(config.policies.noWait, "enforce", "full noWait enforce");
		assert.equal(config.policies.hierarchy, "enforce", "full hierarchy enforce");
		assert.equal(shouldApplyFullOrgPreset(config), true, "full applies org preset");

		const filter = createCapabilityFilteredExtensionApi(recordingPi(), config);
		registerAllTools(filter.api);
		assert.equal(
			filter.registeredTools.length,
			FULL_COORDINATOR_TOOL_NAMES.length,
			"full registers all coordinator tools",
		);
	});
});

describe("acceptance matrix: core consumer", () => {
	it(caseName("core: thinner agents-only surface + soft policies + no org seed"), () => {
		const config = createCoreDefaultConfig();
		const names = coordinatorToolNamesForConfig(config);
		assert.ok(names.includes("subagent_spawn"), "core has spawn");
		assert.ok(names.includes("subagent_inbox"), "core has inbox");
		assert.ok(!names.includes("task_create"), "core omits tasks");
		assert.ok(!names.includes("service_start"), "core omits services");
		assert.equal(config.policies.noWait, "off", "core noWait off");
		assert.equal(config.policies.hierarchy, "off", "core hierarchy off");
		assert.equal(shouldApplyFullOrgPreset(config), false, "core skips org preset");

		const filter = createCapabilityFilteredExtensionApi(recordingPi(), config);
		registerAllTools(filter.api);
		assert.ok(!filter.registeredTools.includes("task_create"), "core filter drops tasks");
		assert.ok(!filter.registeredTools.includes("service_start"), "core filter drops services");
	});
});

describe("acceptance matrix: profile metadata", () => {
	it(caseName("custom profile lease=review without name-list membership"), () => {
		clearProfileCompatRegistry();
		assert.equal(resolveProfileLeaseKind("security-auditor", "review"), "review");
		assert.equal(resolveProfileRoleKey("security-auditor", "reviewer"), "reviewer");
	});

	it(caseName("full compat restores principal-engineer review + role alias"), () => {
		registerFullMeepoProfileCompat();
		assert.equal(resolveProfileLeaseKind("principal-engineer", null), "review");
		assert.equal(resolveProfileRoleKey("principal-engineer", null), "reviewer");
	});
});

describe("acceptance matrix: hierarchy modes", () => {
	const base = {
		parentAgentId: "sa_p",
		parentRoleKey: "cto",
		childRoleKey: "engineer",
		edgePolicy: null as null,
	};

	it(caseName("hierarchy off allows missing edge"), () => {
		assert.equal(evaluateHierarchySpawn({ ...base, mode: "off" }).outcome, "allow");
	});

	it(caseName("hierarchy advisory allows missing edge with note"), () => {
		const d = evaluateHierarchySpawn({ ...base, mode: "advisory" });
		assert.equal(d.outcome, "advisory");
	});

	it(caseName("hierarchy enforce denies missing edge"), () => {
		assert.equal(evaluateHierarchySpawn({ ...base, mode: "enforce" }).outcome, "deny");
	});
});

describe("acceptance matrix: no-wait modes", () => {
	const prompt = "Base system prompt.";
	const sleep = "sleep 2";

	it(caseName("noWait off: no inject, no block"), () => {
		assert.equal(applyNoWaitSystemPrompt(prompt, "off"), prompt);
		assert.equal(noWaitBashBlockReason(sleep, "off"), null);
	});

	it(caseName("noWait prompt: inject, no block"), () => {
		assert.ok(applyNoWaitSystemPrompt(prompt, "prompt").includes("## Meepo no-wait"));
		assert.equal(noWaitBashBlockReason(sleep, "prompt"), null);
	});

	it(caseName("noWait enforce: inject + block"), () => {
		assert.ok(applyNoWaitSystemPrompt(prompt, "enforce").includes("## Meepo no-wait"));
		assert.ok(noWaitBashBlockReason(sleep, "enforce"));
	});
});

describe("acceptance matrix: capability independence", () => {
	it(caseName("services without tasks"), () => {
		const config = loadMeepoConfig({
			env: {},
			preset: "core",
			capabilities: ["agents.core", "services"] as MeepoCapability[],
		});
		const names = coordinatorToolNamesForConfig(config);
		assert.ok(names.includes("subagent_spawn"));
		assert.ok(names.includes("tmux_service_start"));
		assert.ok(!names.includes("task_create"));
	});
});

describe("acceptance matrix: profile dir merge + tool allowlist", () => {
	it(caseName("later consumer dir shadows earlier profile by name"), () => {
		const merged = mergeProfilesByName([
			[stubProfile("worker", "/base/worker.md")],
			[{ ...stubProfile("worker", "/proj/worker.md"), description: "project override" }],
		]);
		assert.equal(merged.find((p) => p.name === "worker")?.description, "project override");
	});

	it(caseName("extraTools allow custom child tools"), () => {
		const tools = normalizeBuiltinTools(["read", "fleet_inspect"], {
			extraTools: ["fleet_inspect"],
		});
		assert.deepEqual(tools, ["read", "fleet_inspect"]);
	});
});

describe("acceptance matrix: runtime start paths", () => {
	it(caseName("full start seeds org roles when getDb provided"), () => {
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
		const runtime = createMeepoRuntime({
			config: createFullDefaultConfig(),
			getDb: () => db,
			registerCoordinatorTools: () => {},
		});
		runtime.start(recordingPi());
		assert.equal(runtime.didApplyOrgPreset(), true);
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto", "engineer"]), 3);
		applyFullOrgPresetSeeds(db); // idempotent
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto", "engineer"]), 3);
	});

	it(caseName("core start does not seed org roles"), () => {
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
		const runtime = createMeepoRuntime({
			config: createCoreDefaultConfig(),
			getDb: () => db,
			registerCoordinatorTools: () => {},
		});
		runtime.start(recordingPi());
		assert.equal(runtime.didApplyOrgPreset(), false);
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto"]), 0);
	});
});
