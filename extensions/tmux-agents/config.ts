/**
 * MeepoRuntime configuration.
 *
 * Defaults preserve full Meepo operator behavior (all capabilities + enforce policies).
 * Later tickets gate registration and policy modes from this object; this ticket only
 * establishes the load surface and full-default tool catalog.
 */

export const MEEPO_CONFIG_VERSION = 1 as const;

/** Product areas that control tool/command registration. */
export const MEEPO_CAPABILITIES = [
	"agents.core",
	"agents.attention",
	"tasks.core",
	"tasks.graph",
	"tasks.ops",
	"services",
	"ui",
] as const;

export type MeepoCapability = (typeof MEEPO_CAPABILITIES)[number];

export const MEEPO_PRESETS = ["full", "core"] as const;
export type MeepoPreset = (typeof MEEPO_PRESETS)[number];

export const NO_WAIT_POLICY_MODES = ["off", "prompt", "enforce"] as const;
export type NoWaitPolicyMode = (typeof NO_WAIT_POLICY_MODES)[number];

export const HIERARCHY_POLICY_MODES = ["off", "advisory", "enforce"] as const;
export type HierarchyPolicyMode = (typeof HIERARCHY_POLICY_MODES)[number];

export const TASK_LEASE_POLICY_MODES = ["off", "on"] as const;
export type TaskLeasePolicyMode = (typeof TASK_LEASE_POLICY_MODES)[number];

export interface MeepoPoliciesConfig {
	/** Coordination no-wait: off | prompt-only | inject+block (current default). */
	noWait: NoWaitPolicyMode;
	/** Optional search guidance string; null means no extra guidance from Meepo. */
	searchGuidance: string | null;
	/** Org edge spawn policy: off | advisory | enforce (current default). */
	hierarchy: HierarchyPolicyMode;
	/** When on, task exclusive/review leases are enforced from profile metadata. */
	taskLeases: TaskLeasePolicyMode;
}

export interface MeepoProfilesConfig {
	/**
	 * Ordered profile directories. Later entries shadow earlier ones by profile name.
	 * Empty means "package default resolution" (existing getProfilesDir behavior).
	 */
	dirs: string[];
	/** When true, child tool lists may include names outside the closed builtin set. */
	allowUnknownTools: boolean;
	/** Extra tool names always allowed for children when not using open mode alone. */
	extraTools: string[];
}

export interface MeepoRuntimePathsConfig {
	/** Optional override for agent dir / DB / runs roots. Null = Pi getAgentDir defaults. */
	agentDir: string | null;
	/** Detached tmux session name when primary is not inside tmux. */
	detachedSessionName: string;
}

export interface MeepoConfig {
	version: typeof MEEPO_CONFIG_VERSION;
	/** Named bundle. full = today's Meepo; core = platform-only (later tickets). */
	preset: MeepoPreset;
	capabilities: MeepoCapability[];
	policies: MeepoPoliciesConfig;
	profiles: MeepoProfilesConfig;
	runtime: MeepoRuntimePathsConfig;
}

/** Coordinator-facing tools registered today under full Meepo (excludes child-only subagent_publish). */
export const FULL_COORDINATOR_TOOL_NAMES = [
	// agents.core
	"subagent_spawn",
	"subagent_focus",
	"subagent_stop",
	"subagent_message",
	"subagent_capture",
	"subagent_reconcile",
	"subagent_list",
	"subagent_get",
	"subagent_cleanup",
	// agents.attention
	"subagent_inbox",
	"subagent_attention",
	// tasks.core
	"task_create",
	"task_list",
	"task_get",
	"task_update",
	"task_move",
	"task_note",
	// tasks.ops
	"task_link_agent",
	"task_unlink_agent",
	"task_attention",
	"task_reconcile",
	// tasks.graph
	"task_link",
	"task_unlink",
	"task_links",
	"task_ready",
	"task_dispatch_ready",
	"task_subtree_control",
	// services
	"tmux_service_start",
	"tmux_service_list",
	"tmux_service_get",
	"tmux_service_focus",
	"tmux_service_stop",
	"tmux_service_capture",
	"tmux_service_reconcile",
] as const;

export type FullCoordinatorToolName = (typeof FULL_COORDINATOR_TOOL_NAMES)[number];

/** Map each coordinator tool to the capability that enables it. */
export const TOOL_CAPABILITY: Record<FullCoordinatorToolName, MeepoCapability> = {
	subagent_spawn: "agents.core",
	subagent_focus: "agents.core",
	subagent_stop: "agents.core",
	subagent_message: "agents.core",
	subagent_capture: "agents.core",
	subagent_reconcile: "agents.core",
	subagent_list: "agents.core",
	subagent_get: "agents.core",
	subagent_cleanup: "agents.core",
	subagent_inbox: "agents.attention",
	subagent_attention: "agents.attention",
	task_create: "tasks.core",
	task_list: "tasks.core",
	task_get: "tasks.core",
	task_update: "tasks.core",
	task_move: "tasks.core",
	task_note: "tasks.core",
	task_link_agent: "tasks.ops",
	task_unlink_agent: "tasks.ops",
	task_attention: "tasks.ops",
	task_reconcile: "tasks.ops",
	task_link: "tasks.graph",
	task_unlink: "tasks.graph",
	task_links: "tasks.graph",
	task_ready: "tasks.graph",
	task_dispatch_ready: "tasks.graph",
	task_subtree_control: "tasks.graph",
	tmux_service_start: "services",
	tmux_service_list: "services",
	tmux_service_get: "services",
	tmux_service_focus: "services",
	tmux_service_stop: "services",
	tmux_service_capture: "services",
	tmux_service_reconcile: "services",
};

const ALL_CAPABILITIES: MeepoCapability[] = [...MEEPO_CAPABILITIES];

const CORE_CAPABILITIES: MeepoCapability[] = ["agents.core", "agents.attention"];

export function createFullDefaultConfig(): MeepoConfig {
	return {
		version: MEEPO_CONFIG_VERSION,
		preset: "full",
		capabilities: [...ALL_CAPABILITIES],
		policies: {
			noWait: "enforce",
			searchGuidance: "rg-only",
			hierarchy: "enforce",
			taskLeases: "on",
		},
		profiles: {
			dirs: [],
			allowUnknownTools: false,
			extraTools: [],
		},
		runtime: {
			agentDir: null,
			detachedSessionName: "pi-subagents",
		},
	};
}

export function createCoreDefaultConfig(): MeepoConfig {
	return {
		version: MEEPO_CONFIG_VERSION,
		preset: "core",
		capabilities: [...CORE_CAPABILITIES],
		policies: {
			noWait: "off",
			searchGuidance: null,
			hierarchy: "off",
			taskLeases: "off",
		},
		profiles: {
			dirs: [],
			allowUnknownTools: false,
			extraTools: [],
		},
		runtime: {
			agentDir: null,
			detachedSessionName: "pi-subagents",
		},
	};
}

export interface LoadMeepoConfigOptions {
	/** Explicit preset override. */
	preset?: MeepoPreset;
	/** Shallow capability override (replaces preset capabilities when provided). */
	capabilities?: MeepoCapability[];
	/** Deep-partial policy overrides. */
	policies?: Partial<MeepoPoliciesConfig>;
	/** Deep-partial profile overrides. */
	profiles?: Partial<MeepoProfilesConfig>;
	/** Deep-partial runtime path overrides. */
	runtime?: Partial<MeepoRuntimePathsConfig>;
	/**
	 * Optional env map (defaults to process.env). Recognized:
	 * - MEEPO_PRESET=full|core
	 */
	env?: NodeJS.ProcessEnv;
}

function resolvePresetBase(preset: MeepoPreset): MeepoConfig {
	return preset === "core" ? createCoreDefaultConfig() : createFullDefaultConfig();
}

/**
 * Load Meepo config.
 * Precedence: full/core base from preset → option overrides → MEEPO_PRESET env (when options.preset omitted).
 * Unconfigured installs resolve to **full** (operator compatibility).
 */
export function loadMeepoConfig(options: LoadMeepoConfigOptions = {}): MeepoConfig {
	const env = options.env ?? process.env;
	const envPreset = env.MEEPO_PRESET?.trim();
	const presetFromEnv =
		envPreset === "core" || envPreset === "full" ? (envPreset as MeepoPreset) : undefined;
	const preset = options.preset ?? presetFromEnv ?? "full";
	const base = resolvePresetBase(preset);

	return {
		version: MEEPO_CONFIG_VERSION,
		preset,
		capabilities: options.capabilities ? [...options.capabilities] : [...base.capabilities],
		policies: {
			...base.policies,
			...options.policies,
		},
		profiles: {
			...base.profiles,
			...options.profiles,
			dirs: options.profiles?.dirs ? [...options.profiles.dirs] : [...base.profiles.dirs],
			extraTools: options.profiles?.extraTools
				? [...options.profiles.extraTools]
				: [...base.profiles.extraTools],
		},
		runtime: {
			...base.runtime,
			...options.runtime,
		},
	};
}

export function hasCapability(config: MeepoConfig, capability: MeepoCapability): boolean {
	return config.capabilities.includes(capability);
}

/** Coordinator tools that should register for this config (order matches FULL_COORDINATOR_TOOL_NAMES). */
export function coordinatorToolNamesForConfig(config: MeepoConfig): string[] {
	const enabled = new Set(config.capabilities);
	return FULL_COORDINATOR_TOOL_NAMES.filter((name) => enabled.has(TOOL_CAPABILITY[name]));
}
