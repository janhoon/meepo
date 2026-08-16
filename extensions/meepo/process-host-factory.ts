/**
 * ProcessHost construction + freeze. Kept separate from process-host.ts types/probes
 * so adapter modules can import the port without circular init.
 */

import {
	type ProcessHost,
	type ResolveProcessHostInput,
	freezeProcessHost,
	getFrozenProcessHost,
	probeTmuxAvailable,
	resolveProcessHostSelection,
} from "./process-host.js";
import {
	type HerdrProbe,
	missingHerdrMessage,
	probeHerdr,
	unsupportedHerdrMessage,
} from "./herdr-compat.js";
import { createHerdProcessHost, HERD_PROCESS_HOST_LIFECYCLE_READY } from "./herd-process-host.js";
import { createTmuxProcessHost } from "./tmux-process-host.js";

function resolveHerdrProbe(input: ResolveProcessHostInput): () => HerdrProbe {
	if (input.probes?.probeHerdr) return input.probes.probeHerdr;
	if (input.probes?.herdrAvailable) {
		return () =>
			input.probes!.herdrAvailable!()
				? { status: "ok", info: { version: "0.8.0", protocol: 20, raw: "test" } }
				: { status: "missing" };
	}
	return () => probeHerdr();
}

/**
 * Build a ProcessHost for the resolved selection without freezing the singleton.
 * Explicit `herdr` + failed probe throws (no silent fallback).
 * Default selection is `herdr`. `auto` prefers herdr when lifecycle-ready and probe is ok; else tmux.
 */
export function createProcessHost(input: ResolveProcessHostInput = {}): ProcessHost {
	const selection = resolveProcessHostSelection(input);
	const tmuxOk = input.probes?.tmuxAvailable ?? probeTmuxAvailable;
	const options = input.hostOptions ?? {};
	const herdrProbe = resolveHerdrProbe(input);

	if (selection === "tmux") {
		return createTmuxProcessHost(options);
	}

	const herdr = herdrProbe();
	if (selection === "herdr") {
		switch (herdr.status) {
			case "ok":
				return createHerdProcessHost(options);
			case "unsupported":
				throw new Error(unsupportedHerdrMessage(herdr.info));
			case "missing":
				throw new Error(missingHerdrMessage());
		}
	}

	if (herdr.status === "ok" && HERD_PROCESS_HOST_LIFECYCLE_READY) {
		return createHerdProcessHost(options);
	}
	if (!tmuxOk()) {
		return createTmuxProcessHost(options);
	}
	return createTmuxProcessHost(options);
}

/** Resolve + freeze once. Subsequent calls return the same host. */
export function ensureProcessHost(input: ResolveProcessHostInput = {}): ProcessHost {
	const existing = getFrozenProcessHost();
	if (existing) return existing;
	return freezeProcessHost(createProcessHost(input));
}
