import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	getActiveProfileLoadOptions,
	setActiveProfileLoadOptions,
} from "./profile-load-options.js";
import { mergeProfilesByName, normalizeBuiltinTools } from "./profile-tools.js";
import type { SubagentProfile } from "./types.js";

function stubProfile(name: string, filePath: string, description = name): SubagentProfile {
	return {
		name,
		description,
		systemPrompt: `You are ${name}`,
		tools: ["read", "bash"],
		model: null,
		filePath,
		roleKey: null,
		lease: null,
		canSpawn: null,
	};
}

afterEach(() => {
	setActiveProfileLoadOptions({ dirs: [], extraTools: [], allowUnknownTools: false });
});

describe("mergeProfilesByName", () => {
	it("later directory shadows earlier profile by name", () => {
		const packageLayer = [
			stubProfile("worker", "/pkg/worker.md", "package worker"),
			stubProfile("scout", "/pkg/scout.md"),
		];
		const projectLayer = [stubProfile("worker", "/project/worker.md", "project worker")];
		const merged = mergeProfilesByName([packageLayer, projectLayer]);
		const worker = merged.find((p) => p.name === "worker");
		assert.ok(worker);
		assert.equal(worker!.description, "project worker");
		assert.equal(worker!.filePath, "/project/worker.md");
		assert.ok(merged.find((p) => p.name === "scout"));
		assert.equal(merged.length, 2);
	});

	it("adds new profiles from later dirs", () => {
		const merged = mergeProfilesByName([
			[stubProfile("worker", "/pkg/worker.md")],
			[stubProfile("security-auditor", "/project/security-auditor.md")],
		]);
		assert.equal(merged.length, 2);
		assert.ok(merged.find((p) => p.name === "security-auditor"));
	});
});

describe("normalizeBuiltinTools allowlist", () => {
	it("rejects unknown tools by default", () => {
		assert.throws(() => normalizeBuiltinTools(["read", "my_custom_tool"]), /Unsupported child tool/);
	});

	it("allows extraTools from options", () => {
		const tools = normalizeBuiltinTools(["read", "my_custom_tool"], {
			extraTools: ["my_custom_tool"],
		});
		assert.deepEqual(tools, ["read", "my_custom_tool"]);
	});

	it("allows any tool when allowUnknownTools is true", () => {
		const tools = normalizeBuiltinTools(["read", "totally_custom"], {
			allowUnknownTools: true,
		});
		assert.deepEqual(tools, ["read", "totally_custom"]);
	});

	it("uses process-wide setActiveProfileLoadOptions extras", () => {
		setActiveProfileLoadOptions({ extraTools: ["fleet_inspect"], allowUnknownTools: false });
		assert.deepEqual(getActiveProfileLoadOptions().extraTools, ["fleet_inspect"]);
		const tools = normalizeBuiltinTools(["bash", "fleet_inspect"]);
		assert.deepEqual(tools, ["bash", "fleet_inspect"]);
	});
});
