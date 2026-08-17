/**
 * Spawn seam: a Child exists only after HostTarget succeeds.
 * Hierarchy off means no org/edges. Failed host leaves no registry row.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { bootstrapMeepoDatabase } from "./db.js";
import { getAgent, getAgentOrg, listActiveAgentEdges } from "./registry.js";
import type { ProcessHost, HostTarget } from "./process-host.js";
import { DatabaseSync } from "./sqlite.js";
import { spawnSubagent } from "./spawn.js";
import type { SubagentProfile } from "./types.js";

const profile: SubagentProfile = {
	name: "worker",
	description: "test worker",
	systemPrompt: "do the task",
	tools: ["read", "bash"],
	model: null,
	filePath: "/tmp/worker.md",
	roleKey: null,
	lease: "exclusive",
	canSpawn: null,
};

function mockHost(options: { fail?: boolean; stopped?: HostTarget[] } = {}): ProcessHost {
	const stopped = options.stopped ?? [];
	return {
		hostKind: "tmux",
		isAvailable: async () => true,
		spawnWindow: async () => {
			if (options.fail) throw new Error("host spawn failed");
			return {
				hostKind: "tmux",
				primaryId: "%1",
				displayName: "child-one",
				refs: { paneId: "%1" },
			};
		},
		getCurrentTarget: async () => null,
		focus: async () => ({ focused: true, command: "tmux select-window" }),
		stop: async (target) => {
			stopped.push(target);
			return { stopped: true, graceful: false, command: "tmux kill-pane" };
		},
		capture: async () => ({ content: "", command: "tmux capture-pane" }),
		listInventory: async () => ({ primaryIds: new Set<string>(), displayNames: new Set<string>() }),
		targetExists: async () => true,
		notify: async () => {},
	};
}

function openTestDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	bootstrapMeepoDatabase(db);
	return db;
}

describe("spawnSubagent", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not create a Child or org when hierarchy is off and host spawn fails", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		await assert.rejects(
			() =>
				spawnSubagent(
					{
						title: "failed child",
						task: "do work",
						profile,
						spawnCwd: process.cwd(),
						model: null,
						tools: ["read"],
						priority: null,
						taskId: null,
						parentAgentId: null,
						hierarchyMode: "off",
						spawnSessionId: null,
						spawnSessionFile: null,
					},
					{ db, host: mockHost({ fail: true }), runsDir },
				),
			/host spawn failed/,
		);
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n), 0);
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM agent_orgs").get() as { n: number }).n), 0);
	});

	it("creates a Child with a HostTarget and no org when hierarchy is off", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		const result = await spawnSubagent(
			{
				agentId: "sa_core_child",
				title: "core child",
				task: "do work",
				profile,
				spawnCwd: process.cwd(),
				model: null,
				tools: ["read"],
				priority: null,
				taskId: null,
				parentAgentId: null,
				hierarchyMode: "off",
				spawnSessionId: "sess-1",
				spawnSessionFile: "/tmp/session.jsonl",
			},
			{ db, host: mockHost(), runsDir },
		);
		assert.equal(result.childId, "sa_core_child");
		assert.equal(result.host.primaryId, "%1");
		const child = getAgent(db, result.childId);
		assert.ok(child);
		assert.equal(child.orgId, null);
		assert.equal(child.host?.primaryId, "%1");
		assert.equal(child.state, "launching");
		assert.equal(listActiveAgentEdges(db, { childAgentId: result.childId }).length, 0);
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM agent_orgs").get() as { n: number }).n), 0);
	});

	it("advisory parent spawn writes a Child even without a role-edge policy", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		const parent = await spawnSubagent(
			{
				agentId: "sa_parent_adv",
				title: "parent",
				task: "parent work",
				profile,
				spawnCwd: process.cwd(),
				model: null,
				tools: ["read"],
				priority: null,
				taskId: null,
				parentAgentId: null,
				hierarchyMode: "advisory",
				spawnSessionId: "sess-parent",
				spawnSessionFile: "/tmp/session.jsonl",
			},
			{ db, host: mockHost(), runsDir },
		);
		const child = await spawnSubagent(
			{
				title: "child",
				task: "child work",
				profile,
				spawnCwd: process.cwd(),
				model: null,
				tools: ["read"],
				priority: null,
				taskId: null,
				parentAgentId: parent.childId,
				hierarchyMode: "advisory",
				spawnSessionId: "sess-parent",
				spawnSessionFile: "/tmp/session.jsonl",
			},
			{ db, host: mockHost(), runsDir },
		);
		assert.ok(getAgent(db, child.childId));
		assert.equal(listActiveAgentEdges(db, { childAgentId: child.childId }).length, 1);
	});

	it("creates an org only when hierarchy is not off", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		const result = await spawnSubagent(
			{
				title: "advisory child",
				task: "do work",
				profile,
				spawnCwd: process.cwd(),
				model: null,
				tools: ["read"],
				priority: null,
				taskId: null,
				parentAgentId: null,
				hierarchyMode: "advisory",
				spawnSessionId: "sess-adv",
				spawnSessionFile: "/tmp/session.jsonl",
			},
			{ db, host: mockHost(), runsDir },
		);
		const child = getAgent(db, result.childId);
		assert.ok(child?.orgId);
		assert.ok(getAgentOrg(db, child.orgId));
	});

	it("defaults hierarchyMode to off", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		const result = await spawnSubagent(
			{
				title: "default off",
				task: "do work",
				profile,
				spawnCwd: process.cwd(),
				model: null,
				tools: ["read"],
				priority: null,
				taskId: null,
				parentAgentId: null,
				spawnSessionId: null,
				spawnSessionFile: null,
			},
			{ db, host: mockHost(), runsDir },
		);
		assert.equal(getAgent(db, result.childId)?.orgId, null);
		assert.equal(getAgentOrg(db, "missing"), null);
	});

	it("stops the host if registry persist fails after spawn", async () => {
		const db = openTestDb();
		const runsDir = mkdtempSync(join(tmpdir(), "meepo-spawn-"));
		dirs.push(runsDir);
		const stopped: HostTarget[] = [];
		db.prepare("DROP TABLE artifacts").run();
		await assert.rejects(
			() =>
				spawnSubagent(
					{
						title: "persist fail",
						task: "do work",
						profile,
						spawnCwd: process.cwd(),
						model: null,
						tools: ["read"],
						priority: null,
						taskId: null,
						parentAgentId: null,
						hierarchyMode: "off",
						spawnSessionId: null,
						spawnSessionFile: null,
					},
					{ db, host: mockHost({ stopped }), runsDir },
				),
			/no such table: artifacts/,
		);
		assert.equal(stopped.length, 1);
		assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n), 0);
	});
});
