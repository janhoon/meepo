import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { getMeepoRuntimePaths, touchAttentionWakeFile } from "./paths.js";

describe("attention wake file", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("touchAttentionWakeFile appends a wake line", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "meepo-wake-"));
		dirs.push(agentDir);
		touchAttentionWakeFile(agentDir);
		const { attentionWakeFile } = getMeepoRuntimePaths(agentDir);
		const body = readFileSync(attentionWakeFile, "utf8");
		assert.match(body, /\d+\n/);
	});
});
