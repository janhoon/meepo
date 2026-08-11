import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createCoreDefaultConfig,
	loadMeepoConfig,
	shouldRegisterCoordinatorCommand,
	type MeepoCapability,
} from "./config.js";
import {
	isSubagentProfileCommandName,
	profileNameFromSubagentCommand,
	subagentCommandNameForProfile,
	titleFromSubagentTaskArgs,
} from "./subagent-commands.js";

describe("subagent slash command naming", () => {
	it("builds skill-style command names", () => {
		assert.equal(subagentCommandNameForProfile("thermo-nuclear-reviewer"), "subagent:thermo-nuclear-reviewer");
		assert.equal(subagentCommandNameForProfile(" worker "), "subagent:worker");
	});

	it("parses profile names from command names", () => {
		assert.equal(isSubagentProfileCommandName("subagent:scout"), true);
		assert.equal(isSubagentProfileCommandName("agents"), false);
		assert.equal(profileNameFromSubagentCommand("subagent:scout"), "scout");
		assert.equal(profileNameFromSubagentCommand("subagent:"), null);
		assert.equal(profileNameFromSubagentCommand("agents"), null);
	});

	it("derives a short title from task args", () => {
		assert.equal(titleFromSubagentTaskArgs("worker", "Fix auth refresh"), "Fix auth refresh");
		assert.equal(
			titleFromSubagentTaskArgs("worker", "\n\n  First real line\nsecond"),
			"First real line",
		);
		assert.equal(titleFromSubagentTaskArgs("worker", ""), "worker");
		const long = "x".repeat(100);
		const title = titleFromSubagentTaskArgs("worker", long);
		assert.ok(title.endsWith("…"));
		assert.ok(title.length <= 72);
	});
});

describe("subagent slash command capability gate", () => {
	it("allows /subagent:* when agents.core is enabled (core preset)", () => {
		const config = createCoreDefaultConfig();
		assert.equal(shouldRegisterCoordinatorCommand(config, "subagent:worker"), true);
		assert.equal(shouldRegisterCoordinatorCommand(config, "subagent:thermo-nuclear-reviewer"), true);
	});

	it("denies /subagent:* when agents.core is absent", () => {
		const config = loadMeepoConfig({
			env: {},
			preset: "core",
			capabilities: ["services"] as MeepoCapability[],
		});
		assert.equal(shouldRegisterCoordinatorCommand(config, "subagent:worker"), false);
		assert.equal(shouldRegisterCoordinatorCommand(config, "services"), true);
	});
});
