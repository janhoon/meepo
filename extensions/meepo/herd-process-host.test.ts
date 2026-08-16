import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	createHerdProcessHost,
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
	it("auto selects herdr when the version probe is ok", () => {
		const host = createProcessHost({
			selection: "auto",
			probes: {
				probeHerdr: () => ({ status: "ok", info: { version: "0.8.0", protocol: 20, raw: "herdr 0.8.0" } }),
			},
		});
		assert.equal(host.hostKind, "herdr");
	});

	it("spawnWindow creates a dedicated tab then pane-runs the launch script", async () => {
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
					assert.equal(args[args.indexOf("--cwd") + 1], "/home/janhoon/projects/meepo");
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
				if (args[0] === "pane" && args[1] === "get") {
					assert.equal(args[2], "w4:pRoot");
					return ok({
						type: "pane_info",
						pane: {
							pane_id: "w4:pRoot",
							terminal_id: "term_root",
							tab_id: "w4:t9",
							workspace_id: "w4",
							cwd: "/home/janhoon/projects/meepo",
							terminal_title: "janhoon@host:meepo",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "run") {
					assert.equal(args[2], "w4:pRoot");
					assert.deepEqual(args.slice(3), ["exec '/tmp/launch.sh'"]);
					assert.notEqual(args[3], "bash");
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "rename") {
					assert.equal(args[2], "w4:pRoot");
					assert.equal(args[3], "research-herdr");
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
		assert.equal(target.primaryId, "term_root");
		assert.equal(target.displayName, "research-herdr");
		assert.equal(target.refs.terminalId, "term_root");
		assert.equal(target.refs.paneId, "w4:pRoot");
		assert.equal(target.refs.tabId, "w4:t9");
		assert.equal(target.refs.workspaceId, "w4");
		assert.ok(calls.some((c) => c[0] === "tab" && c[1] === "create" && c.includes("--cwd")));
		assert.ok(calls.some((c) => c[0] === "pane" && c[1] === "run"));
		assert.ok(!calls.some((c) => c[0] === "agent" && c[1] === "start"));
	});

	it("spawnWindow prefixes services with svc- and runs the launch command in the tab pane", async () => {
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
					assert.equal(args[args.indexOf("--cwd") + 1], "/tmp");
					return ok({
						type: "tab_created",
						tab: { tab_id: "w4:tSvc", workspace_id: "w4", label: "API server" },
						root_pane: {
							pane_id: "w4:pSvcRoot",
							terminal_id: "term_svc_root",
							tab_id: "w4:tSvc",
							workspace_id: "w4",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "get") {
					return ok({
						type: "pane_info",
						pane: {
							pane_id: "w4:pSvcRoot",
							terminal_id: "term_svc_new",
							tab_id: "w4:tSvc",
							workspace_id: "w4",
							cwd: "/tmp",
							terminal_title: "janhoon@host:/tmp",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "run") {
					startAttempts += 1;
					assert.equal(args[2], "w4:pSvcRoot");
					startedNames.push("svc-api-server");
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "rename") {
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
		assert.equal(startAttempts, 1);
		assert.equal(startedNames[0], "svc-api-server");
		assert.equal(target.primaryId, "term_svc_new");
		assert.ok(target.displayName?.startsWith("svc-"));
	});

	it("spawnWindow retries agent rename on agent_name_taken", async () => {
		let renameAttempts = 0;
		const renamed: string[] = [];
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				if (args[0] === "api" && args[1] === "snapshot") {
					return ok({ snapshot: { panes: [], agents: [] }, type: "session_snapshot" });
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
						tab: { tab_id: "w4:t9", workspace_id: "w4", label: "Research" },
						root_pane: { pane_id: "w4:pRoot", terminal_id: "term_root", tab_id: "w4:t9", workspace_id: "w4" },
					});
				}
				if (args[0] === "pane" && args[1] === "get") {
					return ok({
						type: "pane_info",
						pane: {
							pane_id: "w4:pRoot",
							terminal_id: "term_root",
							tab_id: "w4:t9",
							workspace_id: "w4",
							cwd: "/tmp",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "run") {
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "rename") {
					renameAttempts += 1;
					const name = args[3];
					renamed.push(name);
					if (renameAttempts === 1) return err("agent_name_taken", `agent name ${name} is already used`);
					return ok({ type: "ok" });
				}
				return err("unexpected", args.join(" "));
			},
		});

		const target = await host.spawnWindow({
			title: "Research",
			entityId: "sa_abc123",
			launchCommand: "exec '/tmp/launch.sh'",
			pool: "agents",
			cwd: "/tmp",
		});
		assert.equal(renameAttempts, 2);
		assert.notEqual(renamed[1], renamed[0]);
		assert.ok(renamed.every((name) => name.length <= 32));
		assert.equal(target.displayName, renamed[1]);
		assert.equal(target.primaryId, "term_root");
	});

	it("spawnWindow keeps the pane when rename has no herdr occupant yet", async () => {
		const host = createHerdProcessHost({
			isAvailableProbe: () => true,
			runHerdr: (args) => {
				if (args[0] === "api" && args[1] === "snapshot") {
					return ok({ snapshot: { panes: [], agents: [] }, type: "session_snapshot" });
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
						tab: { tab_id: "w4:t9", workspace_id: "w4", label: "Research" },
						root_pane: { pane_id: "w4:pRoot", terminal_id: "term_root", tab_id: "w4:t9", workspace_id: "w4" },
					});
				}
				if (args[0] === "pane" && args[1] === "get") {
					return ok({
						type: "pane_info",
						pane: {
							pane_id: "w4:pRoot",
							terminal_id: "term_root",
							tab_id: "w4:t9",
							workspace_id: "w4",
							cwd: "/tmp",
						},
					});
				}
				if (args[0] === "pane" && args[1] === "run") return ok({ type: "ok" });
				if (args[0] === "agent" && args[1] === "rename") {
					return err("agent_not_found", "agent target w4:pRoot not found");
				}
				return err("unexpected", args.join(" "));
			},
		});

		const target = await host.spawnWindow({
			title: "Research",
			entityId: "sa_abc123",
			launchCommand: "exec '/tmp/launch.sh'",
			pool: "agents",
			cwd: "/tmp",
		});
		assert.equal(target.refs.paneId, "w4:pRoot");
		assert.equal(target.displayName, undefined);
		assert.equal(target.refs.agentName, undefined);
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
					assert.equal(args[2], "child-one");
					return ok({ type: "ok" });
				}
				if (args[0] === "agent" && args[1] === "read") {
					assert.equal(args[2], "child-one");
					assert.ok(args.includes("recent"));
					return ok({
						type: "agent_read",
						read: { text: "hello from pane", source: "recent" },
					});
				}
				if (args[0] === "agent" && args[1] === "get") {
					assert.equal(args[2], "child-one");
					return ok({
						agent: { name: "child-one", terminal_id: "term_live", pane_id: "w4:p7" },
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
			kind: "herdr" as const,
			primaryId: "term_live",
			displayName: "child-one",
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
			{ kind: "herdr", primaryId: "term_x", displayName: null },
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
