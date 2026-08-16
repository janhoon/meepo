import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { DatabaseSync } from "./sqlite.js";
import {
	type MeepoCapability,
	type MeepoConfig,
	coordinatorCommandNamesForConfig,
	coordinatorToolNamesForConfig,
	hasCapability,
	loadMeepoConfig,
	shouldRegisterCoordinatorCommand,
	shouldRegisterCoordinatorShortcut,
	shouldRegisterCoordinatorTool,
	type LoadMeepoConfigOptions,
} from "./config.js";
import { applyFullOrgPresetSeeds, shouldApplyFullOrgPreset } from "./org-preset.js";
import { registerFullMeepoProfileCompat } from "./profile-metadata.js";
import { setActiveProfileLoadOptions } from "./profile-load-options.js";
import type { ProcessHost } from "./process-host.js";
import { ensureProcessHost } from "./process-host-factory.js";

export type RegisterCoordinatorTools = (pi: ExtensionAPI, runtime: MeepoRuntime) => void;

export interface MeepoRuntimeOptions {
	config?: MeepoConfig;
	loadOptions?: LoadMeepoConfigOptions;
	/**
	 * Optional registration hook used by the extension entrypoint.
	 * Tests can omit this and only inspect the planned tool surface.
	 */
	registerCoordinatorTools?: RegisterCoordinatorTools;
	/**
	 * Optional DB accessor for preset seeders. Injected so unit tests need not open the real DB.
	 * When omitted and full org preset applies, start() skips seeding (callers that need seeds pass getMeepoDb).
	 */
	getDb?: () => DatabaseSync;
}

export interface RegistrationFilterResult {
	/** Pi-like API with capability-gated registerTool / registerCommand / registerShortcut. */
	api: ExtensionAPI;
	/** Tool names that passed the filter (in registration order). */
	registeredTools: string[];
	/** Command names that passed the filter (in registration order). */
	registeredCommands: string[];
	/** Mutable counter — use .count so increments remain visible after construction. */
	registeredShortcuts: { count: number };
	/** Convenience accessor kept for tests/callers. */
	get registeredShortcutCount(): number;
}

/**
 * Wrap an ExtensionAPI so registerTool/Command/Shortcut honor Meepo capabilities.
 * Lifecycle hooks (`on`) and other methods pass through unchanged.
 */
export function createCapabilityFilteredExtensionApi(
	pi: ExtensionAPI,
	config: MeepoConfig,
): RegistrationFilterResult {
	const registeredTools: string[] = [];
	const registeredCommands: string[] = [];
	const registeredShortcuts = { count: 0 };

	const api = new Proxy(pi, {
		get(target, prop, receiver) {
			if (prop === "registerTool") {
				return (tool: { name?: string } & Record<string, unknown>) => {
					const name = typeof tool?.name === "string" ? tool.name : "";
					if (!shouldRegisterCoordinatorTool(config, name)) return;
					registeredTools.push(name);
					return target.registerTool(tool as Parameters<ExtensionAPI["registerTool"]>[0]);
				};
			}
			if (prop === "registerCommand") {
				return (name: string, options: unknown) => {
					if (!shouldRegisterCoordinatorCommand(config, name)) return;
					registeredCommands.push(name);
					return target.registerCommand(
						name,
						options as Parameters<ExtensionAPI["registerCommand"]>[1],
					);
				};
			}
			if (prop === "registerShortcut") {
				return (key: unknown, options: unknown) => {
					if (!shouldRegisterCoordinatorShortcut(config)) return;
					registeredShortcuts.count += 1;
					return target.registerShortcut(
						key as Parameters<ExtensionAPI["registerShortcut"]>[0],
						options as Parameters<ExtensionAPI["registerShortcut"]>[1],
					);
				};
			}
			const value = Reflect.get(target, prop, receiver);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as ExtensionAPI;

	return {
		api,
		registeredTools,
		registeredCommands,
		registeredShortcuts,
		get registeredShortcutCount() {
			return registeredShortcuts.count;
		},
	};
}

/**
 * Deep module seam for Meepo: config resolution + capability-aware registration plan.
 *
 * Ticket #5: full-default config and tool catalog.
 * Ticket #6: capability-gated registration via filtered ExtensionAPI.
 */
export class MeepoRuntime {
	readonly config: MeepoConfig;
	private readonly registerCoordinatorTools?: RegisterCoordinatorTools;
	private readonly getDb?: () => DatabaseSync;
	private started = false;
	private lastFilter: RegistrationFilterResult | null = null;
	private orgPresetApplied = false;
	private processHost: ProcessHost | null = null;

	constructor(options: MeepoRuntimeOptions = {}) {
		this.config = options.config ?? loadMeepoConfig(options.loadOptions ?? {});
		this.registerCoordinatorTools = options.registerCoordinatorTools;
		this.getDb = options.getDb;
	}

	/** Frozen process host for this primary session (set during start()). */
	getProcessHost(): ProcessHost {
		if (!this.processHost) {
			throw new Error("ProcessHost not frozen; call MeepoRuntime.start() first.");
		}
		return this.processHost;
	}

	/** Planned coordinator tool names for the active config (no side effects). */
	listCoordinatorToolNames(): string[] {
		return coordinatorToolNamesForConfig(this.config);
	}

	/** Planned slash command names for the active config (no side effects). */
	listCoordinatorCommandNames(): string[] {
		return coordinatorCommandNamesForConfig(this.config);
	}

	shouldRegisterTool(toolName: string): boolean {
		return shouldRegisterCoordinatorTool(this.config, toolName);
	}

	shouldRegisterCommand(commandName: string): boolean {
		return shouldRegisterCoordinatorCommand(this.config, commandName);
	}

	hasCapability(capability: MeepoCapability): boolean {
		return hasCapability(this.config, capability);
	}

	/** Snapshot from the last start() filtered registration, if any. */
	getLastRegistrationSnapshot(): {
		tools: string[];
		commands: string[];
		shortcutCount: number;
	} | null {
		if (!this.lastFilter) return null;
		return {
			tools: [...this.lastFilter.registeredTools],
			commands: [...this.lastFilter.registeredCommands],
			shortcutCount: this.lastFilter.registeredShortcuts.count,
		};
	}

	/** Whether full-org seeds were applied during start(). */
	didApplyOrgPreset(): boolean {
		return this.orgPresetApplied;
	}

	/**
	 * Wire the extension into Pi. Registration is filtered by capabilities.
	 * Full preset optionally seeds org roles/edges via getDb().
	 * Child-only tools (subagent_publish) still pass the filter when registered.
	 */
	start(pi: ExtensionAPI): void {
		if (this.started) {
			throw new Error("MeepoRuntime.start() called more than once");
		}
		this.started = true;
		// Freeze process host once for this primary session (env > config > auto).
		this.processHost = ensureProcessHost({
			env: process.env,
			configSelection: this.config.runtime.processHost,
			hostOptions: {
				agentDetachedSessionName: this.config.runtime.detachedSessionName,
				serviceDetachedSessionName: this.config.runtime.serviceDetachedSessionName,
			},
		});
		setActiveProfileLoadOptions({
			dirs: this.config.profiles.dirs,
			extraTools: this.config.profiles.extraTools,
			allowUnknownTools: this.config.profiles.allowUnknownTools,
		});
		// Full preset registers name-compat fallbacks + org seeds (doctrine pack).
		if (this.config.preset === "full") {
			registerFullMeepoProfileCompat();
		}
		if (shouldApplyFullOrgPreset(this.config) && this.getDb) {
			applyFullOrgPresetSeeds(this.getDb());
			this.orgPresetApplied = true;
		}
		const filter = createCapabilityFilteredExtensionApi(pi, this.config);
		this.lastFilter = filter;
		if (this.registerCoordinatorTools) {
			this.registerCoordinatorTools(filter.api, this);
		}
	}
}

export function createMeepoRuntime(options: MeepoRuntimeOptions = {}): MeepoRuntime {
	return new MeepoRuntime(options);
}
