import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	type MeepoCapability,
	type MeepoConfig,
	coordinatorToolNamesForConfig,
	hasCapability,
	loadMeepoConfig,
	type LoadMeepoConfigOptions,
} from "./config.js";

export type RegisterCoordinatorTools = (pi: ExtensionAPI, runtime: MeepoRuntime) => void;

export interface MeepoRuntimeOptions {
	config?: MeepoConfig;
	loadOptions?: LoadMeepoConfigOptions;
	/**
	 * Optional registration hook used by the extension entrypoint.
	 * Tests can omit this and only inspect the planned tool surface.
	 */
	registerCoordinatorTools?: RegisterCoordinatorTools;
}

/**
 * Deep module seam for Meepo: config resolution + capability-aware registration plan.
 *
 * Ticket #5: full-default config and tool catalog are the contract.
 * Actual Pi registration is injected so unit tests need no ExtensionAPI mock surface.
 */
export class MeepoRuntime {
	readonly config: MeepoConfig;
	private readonly registerCoordinatorTools?: RegisterCoordinatorTools;
	private started = false;

	constructor(options: MeepoRuntimeOptions = {}) {
		this.config =
			options.config ??
			loadMeepoConfig(options.loadOptions ?? {});
		this.registerCoordinatorTools = options.registerCoordinatorTools;
	}

	/** Planned coordinator tool names for the active config (no side effects). */
	listCoordinatorToolNames(): string[] {
		return coordinatorToolNamesForConfig(this.config);
	}

	shouldRegisterTool(toolName: string): boolean {
		return this.listCoordinatorToolNames().includes(toolName);
	}

	hasCapability(capability: MeepoCapability): boolean {
		return hasCapability(this.config, capability);
	}

	/**
	 * Wire the extension into Pi. Child vs coordinator registration remains the caller's concern;
	 * this method only runs the injected coordinator registrar when provided.
	 */
	start(pi: ExtensionAPI): void {
		if (this.started) {
			throw new Error("MeepoRuntime.start() called more than once");
		}
		this.started = true;
		if (this.registerCoordinatorTools) {
			this.registerCoordinatorTools(pi, this);
		}
	}
}

export function createMeepoRuntime(options: MeepoRuntimeOptions = {}): MeepoRuntime {
	return new MeepoRuntime(options);
}
