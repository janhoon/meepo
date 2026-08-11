import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { createMeepoRuntime } from "./runtime.js";
import { registerMeepoCoordinatorTools } from "./coordinator.js";

/**
 * Pi extension entrypoint. Boots MeepoRuntime (core-default config) and registers
 * the capability-filtered coordinator/child surface.
 */
export default function meepoExtension(pi: ExtensionAPI): void {
	const runtime = createMeepoRuntime({
		registerCoordinatorTools: registerMeepoCoordinatorTools,
		// Full preset seeds org role/edge doctrine; core skips (hierarchy off).
		getDb: () => getMeepoDb(),
	});
	runtime.start(pi);
}

/** @deprecated Use default export meepoExtension. */
export { meepoExtension as tmuxAgentsExtension };
