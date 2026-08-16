import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadMeepoConfig } from "./config.js";
import {
	createProcessHost,
	ensureProcessHost,
} from "./process-host-factory.js";
import {
	hostFieldsFromTarget,
	hostTargetRefFromLegacy,
	parseProcessHostSelection,
	resetProcessHostForTests,
	resolveProcessHostSelection,
	type HostTarget,
} from "./process-host.js";
import { createMeepoRuntime } from "./runtime.js";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

afterEach(() => {
	resetProcessHostForTests();
});

describe("process host selection", () => {
	it("parses selection tokens", () => {
		assert.equal(parseProcessHostSelection("auto"), "auto");
		assert.equal(parseProcessHostSelection("TMUX"), "tmux");
		assert.equal(parseProcessHostSelection("herdr"), "herdr");
		assert.equal(parseProcessHostSelection("nope"), undefined);
	});

	it("precedence: explicit selection > env > config > auto", () => {
		assert.equal(
			resolveProcessHostSelection({
				selection: "tmux",
				env: { MEEPO_PROCESS_HOST: "herdr" },
				configSelection: "auto",
			}),
			"tmux",
		);
		assert.equal(
			resolveProcessHostSelection({
				env: { MEEPO_PROCESS_HOST: "herdr" },
				configSelection: "tmux",
			}),
			"herdr",
		);
		assert.equal(
			resolveProcessHostSelection({
				env: {},
				configSelection: "tmux",
			}),
			"tmux",
		);
		assert.equal(resolveProcessHostSelection({ env: {} }), "herdr");
	});

	it("loadMeepoConfig reads MEEPO_PROCESS_HOST into runtime.processHost", () => {
		const config = loadMeepoConfig({ env: { MEEPO_PROCESS_HOST: "tmux" } });
		assert.equal(config.runtime.processHost, "tmux");
		assert.equal(config.runtime.serviceDetachedSessionName, "pi-services");
		const defaulted = loadMeepoConfig({ env: {} });
		assert.equal(defaulted.runtime.processHost, "herdr");
	});

	it("core and full presets default processHost to herdr", () => {
		assert.equal(loadMeepoConfig({ env: {}, preset: "core" }).runtime.processHost, "herdr");
		assert.equal(loadMeepoConfig({ env: {}, preset: "full" }).runtime.processHost, "herdr");
	});

	const okHerdr = {
		probeHerdr: () => ({ status: "ok" as const, info: { version: "0.8.0", protocol: 20, raw: "herdr 0.8.0" } }),
	};
	const missingHerdr = {
		probeHerdr: () => ({ status: "missing" as const }),
	};

	it("auto prefers herdr when the probe is ok", () => {
		const host = createProcessHost({
			selection: "auto",
			probes: okHerdr,
		});
		assert.equal(host.hostKind, "herdr");
	});

	it("auto falls back to tmux when herdr probe fails", () => {
		const host = createProcessHost({
			selection: "auto",
			probes: missingHerdr,
		});
		assert.equal(host.hostKind, "tmux");
	});

	it("explicit tmux never requires herdr", () => {
		const host = createProcessHost({
			selection: "tmux",
			probes: missingHerdr,
		});
		assert.equal(host.hostKind, "tmux");
	});

	it("explicit herdr throws when probe fails", () => {
		assert.throws(
			() =>
				createProcessHost({
					selection: "herdr",
					probes: missingHerdr,
				}),
			/herdr is not available/,
		);
	});

	it("explicit herdr throws unsupported from the same probe result", () => {
		assert.throws(
			() =>
				createProcessHost({
					selection: "herdr",
					probes: {
						probeHerdr: () => ({
							status: "unsupported",
							info: { version: "0.7.4", protocol: 16, raw: "herdr 0.7.4" },
						}),
						tmuxAvailable: () => true,
					},
				}),
			/Unsupported herdr 0\.7\.4/,
		);
	});

	it("explicit herdr returns HerdProcessHost when probe succeeds", () => {
		const host = createProcessHost({
			selection: "herdr",
			probes: okHerdr,
		});
		assert.equal(host.hostKind, "herdr");
	});

	it("freezes host once per session via ensureProcessHost", () => {
		const first = ensureProcessHost({
			selection: "tmux",
			probes: missingHerdr,
		});
		const second = ensureProcessHost({
			selection: "tmux",
			probes: okHerdr,
		});
		assert.equal(first, second);
		assert.equal(first.hostKind, "tmux");
	});
});

describe("host target mapping", () => {
	it("hostFieldsFromTarget dual-writes legacy tmux columns", () => {
		const target: HostTarget = {
			hostKind: "tmux",
			primaryId: "%12",
			displayName: "research-foo-abcdef",
			refs: {
				sessionId: "$1",
				sessionName: "pi-subagents",
				windowId: "@3",
				paneId: "%12",
			},
		};
		const fields = hostFieldsFromTarget(target);
		assert.equal(fields.hostKind, "tmux");
		assert.equal(fields.hostPrimaryId, "%12");
		assert.equal(fields.tmuxPaneId, "%12");
		assert.equal(fields.tmuxSessionName, "pi-subagents");
		assert.ok(fields.hostTargetJson.includes("paneId"));
	});

	it("hostTargetRefFromLegacy prefers host_* then falls back to tmux_*", () => {
		const fromHost = hostTargetRefFromLegacy({
			hostKind: "tmux",
			hostPrimaryId: "%99",
			hostDisplayName: "named",
			hostTargetJson: JSON.stringify({ sessionId: "$9", paneId: "%99" }),
		});
		assert.equal(fromHost.primaryId, "%99");
		assert.equal(fromHost.displayName, "named");
		assert.equal(fromHost.refs?.paneId, "%99");

		const fromLegacy = hostTargetRefFromLegacy({
			tmuxSessionId: "$1",
			tmuxSessionName: "main",
			tmuxWindowId: "@2",
			tmuxPaneId: "%3",
		});
		assert.equal(fromLegacy.hostKind, "tmux");
		assert.equal(fromLegacy.primaryId, "%3");
		assert.equal(fromLegacy.refs?.sessionName, "main");
	});
});

describe("MeepoRuntime freezes process host on start", () => {
	it("start() freezes ProcessHost from config", () => {
		const { pi } = {
			pi: {
				registerTool() {},
				registerCommand() {},
				registerShortcut() {},
				on() {},
			} as unknown as ExtensionAPI,
		};
		const runtime = createMeepoRuntime({
			config: loadMeepoConfig({
				env: {},
				runtime: { processHost: "tmux" },
			}),
		});
		runtime.start(pi);
		assert.equal(runtime.getProcessHost().hostKind, "tmux");
	});
});
