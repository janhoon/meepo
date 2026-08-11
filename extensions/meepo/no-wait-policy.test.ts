import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCoreDefaultConfig, createFullDefaultConfig, loadMeepoConfig } from "./config.js";
import {
	COORDINATION_NO_WAIT_PROMPT,
	applyNoWaitSystemPrompt,
	classifyNoWaitBashCommand,
	noWaitBashBlockReason,
} from "./no-wait-policy.js";

describe("no-wait policy modes", () => {
	const basePrompt = "You are a helpful assistant.";
	const sleepCmd = "sleep 5";
	const okCmd = "rg -n pattern src";

	it("full/default config uses enforce", () => {
		assert.equal(loadMeepoConfig({ env: {}, preset: "full" }).policies.noWait, "enforce");
		assert.equal(loadMeepoConfig({ env: {} }).policies.noWait, "off");
		assert.equal(createFullDefaultConfig().policies.noWait, "enforce");
	});

	it("core config uses off", () => {
		assert.equal(createCoreDefaultConfig().policies.noWait, "off");
	});

	it("off: no system-prompt injection and no bash blocking", () => {
		const next = applyNoWaitSystemPrompt(basePrompt, "off");
		assert.equal(next, basePrompt);
		assert.ok(!next.includes("## Meepo no-wait coordination policy"));
		assert.equal(noWaitBashBlockReason(sleepCmd, "off"), null);
		assert.ok(classifyNoWaitBashCommand(sleepCmd), "classifier still detects sleep when used for enforce");
	});

	it("prompt: injects guidance but does not block sleep/polling bash", () => {
		const next = applyNoWaitSystemPrompt(basePrompt, "prompt");
		assert.ok(next.includes("## Meepo no-wait coordination policy"));
		assert.ok(next.includes(COORDINATION_NO_WAIT_PROMPT.split("\n")[1]!));
		assert.equal(noWaitBashBlockReason(sleepCmd, "prompt"), null);
		assert.equal(noWaitBashBlockReason("watch -n1 date", "prompt"), null);
	});

	it("enforce: injects guidance and blocks classified wait/polling bash", () => {
		const next = applyNoWaitSystemPrompt(basePrompt, "enforce");
		assert.ok(next.includes("## Meepo no-wait coordination policy"));
		const block = noWaitBashBlockReason(sleepCmd, "enforce");
		assert.ok(block);
		assert.match(block!, /sleep/i);
		assert.equal(noWaitBashBlockReason(okCmd, "enforce"), null);
	});

	it("idempotent prompt injection under prompt/enforce", () => {
		const once = applyNoWaitSystemPrompt(basePrompt, "enforce");
		const twice = applyNoWaitSystemPrompt(once, "enforce");
		assert.equal(once, twice);
	});
});
