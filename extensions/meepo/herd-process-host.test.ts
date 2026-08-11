import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createHerdProcessHost,
	HERD_PROCESS_HOST_LIFECYCLE_READY,
	type HerdrCliResult,
} from "./herd-process-host.js";
import { createProcessHost } from "./process-host-factory.js";
import { resetProcessHostForTests } from "./process-host.js";

afterEach(() => {
	resetProcessHostForTests();
});

function ok(result: unknown): HerdrCliResult {
	return {
		status: 0,
		stdout: JSON.stringify({ id: "cli:test", result }),
		stderr: "",
	};
}

function err(code: string, message: string): HerdrCliResult {
	return {
		status: 1,
		stdout: JSON.stringify({ id: "cli:test", error: { code, message } }),
		stderr: "",
	};
}

describe("HerdProcessHost lifecycle (mocked CLI)", () => {
	it("marks lifecycle ready so auto can select herdr", () => {
		assert.equal(HERD_PROCESS_HOST_LIFECYCLE_READY, true);
		const host = createProcessHost({
			selection: "auto",
			probes: { herdrAvailable: () => true, tmuxAvailable: () => true },
		});
		assert.equal(host.hostKind, "herdr");
	});

	it("spawnWindow creates a dedicated tab then starts agent with --no-focus", async () => {
		const calls: string[][] = [];
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				calls.push(args);
				if (args[0] === "api" && args[1] === "snapshot") {
					return ok({
						snapshot: {
							panes: [],
							agents: [{ name: "existing-agent", terminal_id: "term_old", pane_id: "w4:p1" }],
						},
						type: "session_snapshot",
					});
				}
				if (args[0] === "pane" && args[1] === "current") {
					return ok({
						type: "pane_current",
						pane: {
							terminal_id: "term_primary",
							pane_id: "w4:p1",
							tab_id: "w4:t1",
							workspace_id: "w4",
						},
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					assert.ok(args.includes("--no-focus"));
					assert.equal(args[args.indexOf("--workspace") + 1], "w4");
					assert.equal(args[args.indexOf("--label") + 1], "Research herdr");
					return ok({
						type: "tab_created",
						tab: {
							tab_id: "w4:t9",
							workspace_id: "w4",
							label: "Research herdr",
						},
						root_pane: {
							pane_id: "w4:pRoot",
							terminal_id: "term_root",
							tab_id: "w4:t9",
							workspace_id: "w4",
						},
					});
				}
				if (args[0] === "agent" && args[1] === "start") {
					assert.equal(args[2], "research-herdr");
					assert.ok(args.includes("--no-focus"));
					assert.ok(args.includes("--tab"));
					assert.equal(args[args.indexOf("--tab") + 1], "w4:t9");
					assert.ok(!args.includes("--workspace"));
					assert.ok(!args.includes("--split"));
					assert.ok(args.includes("--cwd"));
					const dash = args.indexOf("--");
					assert.ok(dash > 0);
					assert.deepEqual(args.slice(dash + 1), ["bash", "-lc", "exec '/tmp/launch.sh'"]);
					return ok({
						type: "agent_started",
						argv: ["bash", "-lc", "exec '/tmp/launch.sh'"],
						agent: {
							name: "research-herdr",
							terminal_id: "term_child",
							pane_id: "w4:p9",
							tab_id: "w4:t9",
							workspace_id: "w4",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "close") {
					assert.equal(args[2], "w4:pRoot");
					return ok({ type: "ok" });
				}
				return err("unexpected", `unexpected args ${args.join(" ")}`);
			},
		});

		const target = await host.spawnWindow({
			title: "Research herdr",
			entityId: "sa_abc123xyz",
			launchCommand: "exec '/tmp/launch.sh'",
			pool: "agents",
			cwd: "/home/janhoon/projects/meepo",
		});

		assert.equal(target.hostKind, "herdr");
		assert.equal(target.primaryId, "term_child");
		assert.equal(target.displayName, "research-herdr");
		assert.equal(target.refs.terminalId, "term_child");
		assert.equal(target.refs.paneId, "w4:p9");
		assert.equal(target.refs.tabId, "w4:t9");
		assert.equal(target.refs.workspaceId, "w4");
		assert.ok(calls.some((c) => c[0] === "tab" && c[1] === "create"));
		assert.ok(calls.some((c) => c[0] === "agent" && c[1] === "start"));
		assert.ok(calls.some((c) => c[0] === "pane" && c[1] === "close" && c[2] === "w4:pRoot"));
	});

	it("spawnWindow prefixes services with svc- and retries on agent_name_taken", async () => {
		let startAttempts = 0;
		const startedNames: string[] = [];
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				if (args[0] === "api" && args[1] === "snapshot") {
					return ok({
						snapshot: { panes: [], agents: [] },
						type: "session_snapshot",
					});
				}
				if (args[0] === "pane" && args[1] === "current") {
					return ok({
						type: "pane_current",
						pane: { terminal_id: "term_p", pane_id: "w4:p1", workspace_id: "w4", tab_id: "w4:t1" },
					});
				}
				if (args[0] === "tab" && args[1] === "create") {
					return ok({
						type: "tab_created",
						tab: { tab_id: "w4:tSvc", workspace_id: "w4", label: "API server" },
						root_pane: { pane_id: "w4:pSvcRoot", tab_id: "w4:tSvc", workspace_id: "w4" },
					});
				}
				if (args[0] === "agent" && args[1] === "start") {
					startAttempts += 1;
					const name = args[2];
					startedNames.push(name);
					assert.ok(name.startsWith("svc-"), `expected svc- name, got ${name}`);
					assert.equal(args[args.indexOf("--tab") + 1], "w4:tSvc");
					if (startAttempts === 1) {
						return err("agent_name_taken", `agent name ${name} is already used`);
					}
					return ok({
						type: "agent_started",
						agent: {
							name,
							terminal_id: "term_svc_new",
							pane_id: "w4:p8",
							tab_id: "w4:tSvc",
							workspace_id: "w4",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "close") {
					assert.equal(args[2], "w4:pSvcRoot");
					return ok({ type: "ok" });
				}
				return err("unexpected", args.join(" "));
			},
		});

		const target = await host.spawnWindow({
			title: "API server",
			entityId: "svc_deadbeef",
			launchCommand: "exec '/tmp/svc.sh'",
			pool: "services",
			cwd: "/tmp",
		});
		assert.equal(startAttempts, 2);
		assert.equal(startedNames[0], "svc-api-server");
		assert.notEqual(startedNames[1], startedNames[0]);
		assert.equal(target.primaryId, "term_svc_new");
		assert.ok(target.displayName?.startsWith("svc-"));
	});

	it("focus / capture / stop / targetExists round-trip on terminal_id", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				if (args[0] === "api" && args[1] === "snapshot") {
					return ok({
						snapshot: {
							panes: [
								{
									terminal_id: "term_live",
									pane_id: "w4:p7",
									name: "child-one",
									workspace_id: "w4",
									tab_id: "w4:t1",
								},
							],
							agents: [
								{
									terminal_id: "term_live",
									pane_id: "w4:p7",
									name: "child-one",
									workspace_id: "w4",
									tab_id: "w4:t1",
								},
							],
						},
						type: "session_snapshot",
					});
				}
				if (args[0] === "agent" && args[1] === "focus") {
					assert.equal(args[2], "term_live");
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "read") {
					assert.equal(args[2], "term_live");
					assert.ok(args.includes("recent"));
					return ok({
						type: "pane_read",
						read: { text: "hello from pane", source: "recent", pane_id: "w4:p7" },
					});
				}
				if (args[0] === "pane" && args[1] === "close") {
					assert.equal(args[2], "w4:p7");
					return ok({ type: "ok" });
				}
				return err("unexpected", args.join(" "));
			},
		});

		const ref = {
			hostKind: "herdr" as const,
			primaryId: "term_live",
			displayName: "child-one",
			refs: {
				terminalId: "term_live",
				paneId: "w4:p7",
				agentName: "child-one",
				workspaceId: "w4",
				tabId: "w4:t1",
			},
		};

		assert.equal(await host.targetExists(ref), true);
		const focus = await host.focus(ref);
		assert.equal(focus.focused, true);
		const cap = await host.capture(ref, { lines: 50 });
		assert.equal(cap.content, "hello from pane");
		const stop = await host.stop(ref, { force: true });
		assert.equal(stop.stopped, true);
		assert.equal(stop.graceful, false);
		assert.match(stop.command, /herdr pane close/);
	});

	it("focus soft-fails when agent is missing", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: () => err("agent_not_found", "agent target gone not found"),
		});
		const result = await host.focus({ primaryId: "term_gone", displayName: "gone" });
		assert.equal(result.focused, false);
		assert.match(result.command, /herdr agent focus/);
		assert.match(result.reason ?? "", /not found/i);
	});

	it("force stop treats missing pane as stopped", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				if (args[0] === "pane" && args[1] === "close") {
					return err("pane_not_found", "pane w4:p9 not found");
				}
				return err("unexpected", args.join(" "));
			},
		});
		const result = await host.stop(
			{ primaryId: "term_x", refs: { terminalId: "term_x", paneId: "w4:p9" } },
			{ force: true },
		);
		assert.equal(result.stopped, true);
		assert.equal(result.graceful, false);
	});

	it("getCurrentTarget returns null when pane current fails", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: () => err("not_connected", "no server"),
		});
		assert.equal(await host.getCurrentTarget(), null);
	});

	it("notify maps kinds to herdr notification show sounds", async () => {
		const calls: string[][] = [];
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				calls.push(args);
				return ok({ shown: true });
			},
		});
		await host.notify({
			kind: "question",
			title: "Question: research-herdr",
			body: "Need API shape",
			rateKey: "sa_1",
		});
		await host.notify({
			kind: "blocker",
			title: "Blocked: research-herdr",
			body: "Waiting on credentials",
			rateKey: "sa_2",
		});
		await host.notify({
			kind: "complete",
			title: "Done: research-herdr",
			body: "Handoff ready",
			rateKey: "sa_3",
		});
		await host.notify({ kind: "info", title: "noise", rateKey: "sa_4" });

		assert.equal(calls.length, 3);
		assert.deepEqual(calls[0], [
			"notification",
			"show",
			"Question: research-herdr",
			"--sound",
			"request",
			"--body",
			"Need API shape",
		]);
		assert.equal(calls[1][4], "request");
		assert.equal(calls[2][4], "done");
	});

	it("notify rate-limits per agent+kind and complete-once", async () => {
		const calls: string[][] = [];
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				calls.push(args);
				return ok({ shown: true });
			},
		});
		await host.notify({ kind: "question", title: "Question: a", body: "first", rateKey: "sa_x" });
		await host.notify({ kind: "question", title: "Question: a", body: "second", rateKey: "sa_x" });
		await host.notify({ kind: "complete", title: "Done: a", rateKey: "sa_x" });
		await host.notify({ kind: "complete", title: "Done: a again", rateKey: "sa_x" });
		// Different kind still allowed within the window.
		await host.notify({ kind: "blocker", title: "Blocked: a", rateKey: "sa_x" });

		assert.equal(calls.length, 3);
		assert.equal(calls[0][2], "Question: a");
		assert.equal(calls[1][2], "Done: a");
		assert.equal(calls[2][2], "Blocked: a");
	});

	it("notify soft-fails when herdr CLI errors", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: () => err("not_connected", "no server"),
		});
		await assert.doesNotReject(() =>
			host.notify({ kind: "question", title: "Question: x", rateKey: "sa_y" }),
		);
	});
});
