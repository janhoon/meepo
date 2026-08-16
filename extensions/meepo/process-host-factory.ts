/**
 * ProcessHost construction + freeze. Kept separate from process-host.ts types/probes
 * so adapter modules can import the port without circular init.
 */

import {
	type ProcessHost,
	type ResolveProcessHostInput,
	freezeProcessHost,
	getFrozenProcessHost,
	probeHerdrAvailable,
	probeTmuxAvailable,
	resolveProcessHostSelection,
} from "./process-host.js";
import { createHerdProcessHost, HERD_PROCESS_HOST_LIFECYCLE_READY } from "./herd-process-host.js";
import { createTmuxProcessHost } from "./tmux-process-host.js";

/**
 * Build a ProcessHost for the resolved selection without freezing the singleton.
 * Explicit `herdr` + failed probe throws (no silent fallback).
 * Default selection is `herdr`. `auto` prefers herdr when lifecycle-ready and probe succeeds; else tmux.
 */
export function createProcessHost(input: ResolveProcessHostInput = {}): ProcessHost {
	const selection = resolveProcessHostSelection(input);
	const herdrOk = input.probes?.herdrAvailable ?? probeHerdrAvailable;
	const tmuxOk = input.probes?.tmuxAvailable ?? probeTmuxAvailable;
	const options = input.hostOptions ?? {};

	if (selection === "tmux") {
		return createTmuxProcessHost(options);
	}
	if (selection === "herdr") {
		if (!herdrOk()) {
			throw new Error(
				"MEEPO_PROCESS_HOST=herdr (or runtime.processHost=herdr) but herdr is not available on PATH / failed probe.",
			);
		}
		return createHerdProcessHost(options);
	}
	// auto — prefer herdr when binary works *and* lifecycle adapter is ready.
	if (herdrOk() && HERD_PROCESS_HOST_LIFECYCLE_READY) {
		return createHerdProcessHost(options);
	}
	if (!tmuxOk()) {
		// Still return tmux host; spawn will throw with a clear missing-binary error.
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
