import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getChildRuntimeEnvironment } from "./child-runtime.js";

describe("getChildRuntimeEnvironment", () => {
	it("prefers MEEPO_* over leftover PI_TMUX_AGENTS_*", () => {
		const previous = {
			MEEPO_CHILD: process.env.MEEPO_CHILD,
			MEEPO_CHILD_ID: process.env.MEEPO_CHILD_ID,
			MEEPO_RUN_DIR: process.env.MEEPO_RUN_DIR,
			MEEPO_PROFILE: process.env.MEEPO_PROFILE,
			PI_TMUX_AGENTS_CHILD: process.env.PI_TMUX_AGENTS_CHILD,
			PI_TMUX_AGENTS_CHILD_ID: process.env.PI_TMUX_AGENTS_CHILD_ID,
			PI_TMUX_AGENTS_RUN_DIR: process.env.PI_TMUX_AGENTS_RUN_DIR,
			PI_TMUX_AGENTS_PROFILE: process.env.PI_TMUX_AGENTS_PROFILE,
		};
		process.env.MEEPO_CHILD = "1";
		process.env.MEEPO_CHILD_ID = "sa_new";
		process.env.MEEPO_RUN_DIR = "/tmp/new";
		process.env.MEEPO_PROFILE = "worker";
		process.env.PI_TMUX_AGENTS_CHILD = "1";
		process.env.PI_TMUX_AGENTS_CHILD_ID = "sa_old";
		process.env.PI_TMUX_AGENTS_RUN_DIR = "/tmp/old";
		process.env.PI_TMUX_AGENTS_PROFILE = "legacy";
		try {
			const env = getChildRuntimeEnvironment();
			assert.equal(env?.childId, "sa_new");
			assert.equal(env?.runDir, "/tmp/new");
			assert.equal(env?.profile, "worker");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("still reads leftover PI_TMUX_AGENTS_* when MEEPO_* is absent", () => {
		const previous = {
			MEEPO_CHILD: process.env.MEEPO_CHILD,
			MEEPO_CHILD_ID: process.env.MEEPO_CHILD_ID,
			MEEPO_RUN_DIR: process.env.MEEPO_RUN_DIR,
			MEEPO_PROFILE: process.env.MEEPO_PROFILE,
			PI_TMUX_AGENTS_CHILD: process.env.PI_TMUX_AGENTS_CHILD,
			PI_TMUX_AGENTS_CHILD_ID: process.env.PI_TMUX_AGENTS_CHILD_ID,
			PI_TMUX_AGENTS_RUN_DIR: process.env.PI_TMUX_AGENTS_RUN_DIR,
			PI_TMUX_AGENTS_PROFILE: process.env.PI_TMUX_AGENTS_PROFILE,
		};
		delete process.env.MEEPO_CHILD;
		delete process.env.MEEPO_CHILD_ID;
		delete process.env.MEEPO_RUN_DIR;
		delete process.env.MEEPO_PROFILE;
		process.env.PI_TMUX_AGENTS_CHILD = "1";
		process.env.PI_TMUX_AGENTS_CHILD_ID = "sa_old";
		process.env.PI_TMUX_AGENTS_RUN_DIR = "/tmp/old";
		process.env.PI_TMUX_AGENTS_PROFILE = "legacy";
		try {
			const env = getChildRuntimeEnvironment();
			assert.equal(env?.childId, "sa_old");
			assert.equal(env?.profile, "legacy");
		} finally {
			for (const [key, value] of Object.entries(previous)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});
});
