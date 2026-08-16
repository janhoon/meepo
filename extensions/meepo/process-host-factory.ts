/**
 * ProcessHost construction + freeze. Kept separate from process-host.ts types/probes
 * so adapter modules can import the port without circular init.
 */

import {
	type ProcessHost,
	type ResolveProcessHostInput,
	freezeProcessHost,
	getFrozenProcessHost,
	resolveProcessHostSelection,
} from "./process-host.js";
import { missingHerdrMessage, probeHerdr, unsupportedHerdrMessage } from "./herdr-compat.js";
import { createHerdProcessHost } from "./herd-process-host.js";
import { createTmuxProcessHost } from "./tmux-process-host.js";

/**
 * Build a ProcessHost for the resolved selection without freezing the singleton.
 * Explicit `herdr` + failed probe throws (no silent fallback).
 * Default selection is `herdr`. `auto` uses herdr only when the probe is ok.
 */
export function createProcessHost(input: ResolveProcessHostInput = {}): ProcessHost {
	const selection = resolveProcessHostSelection(input);
	const options = input.hostOptions ?? {};
	const herdrProbe = input.probes?.probeHerdr ?? probeHerdr;

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

	if (herdr.status === "ok") return createHerdProcessHost(options);
	return createTmuxProcessHost(options);
}

/** Resolve + freeze once. Subsequent calls return the same host. */
export function ensureProcessHost(input: ResolveProcessHostInput = {}): ProcessHost {
	const existing = getFrozenProcessHost();
	if (existing) return existing;
	return freezeProcessHost(createProcessHost(input));
}
