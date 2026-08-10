/**
 * ProcessHost port: host-neutral process placement for Meepo coordinators.
 *
 * Contract source: wayfinder ticket #18 (ProcessHost port + selection rules).
 * Selection freezes once per primary MeepoRuntime session.
 *
 * Adapter factories live in process-host-factory.ts to avoid circular imports.
 */

import { spawnSync } from "node:child_process";
import type { MeepoConfig } from "./config.js";

export type HostKind = "tmux" | "herdr";
export type ProcessHostSelection = "auto" | HostKind;

export interface HostTarget {
	hostKind: HostKind;
	/** Stable id: tmux pane (prefer) or composite; herdr terminal_id */
	primaryId: string;
	/** Host-facing name when present (herdr agent name; optional tmux window label) */
	displayName?: string;
	refs: {
		// tmux
		sessionId?: string;
		sessionName?: string;
		windowId?: string;
		paneId?: string;
		// herdr
		terminalId?: string;
		workspaceId?: string;
		tabId?: string;
		/** herdr pane_id — may recycle; do not use alone for equality */
		paneId?: string;
		agentName?: string;
	};
}

export interface HostTargetRef {
	hostKind?: HostKind;
	primaryId?: string;
	displayName?: string;
	refs?: HostTarget["refs"];
}

export interface HostInventory {
	/** Backend-specific membership sets used by targetExists / reconcile */
	primaryIds: Set<string>;
	displayNames: Set<string>;
	/** Optional raw host sets for adapters (tmux sessions/windows/panes, herdr snapshot ids) */
	raw?: Record<string, Set<string>>;
}

export interface HostSpawnWindowInput {
	title: string;
	entityId: string;
	launchCommand: string;
	pool: "agents" | "services";
	detachedSessionName?: string;
	cwd?: string;
	env?: Record<string, string>;
}

export interface HostFocusResult {
	focused: boolean;
	command: string;
	reason?: string;
}

export interface HostStopResult {
	stopped: boolean;
	graceful: boolean;
	command: string;
	reason?: string;
}

export interface HostCaptureResult {
	content: string;
	command: string;
}

export interface HostNotifyInput {
	title: string;
	body?: string;
	kind: "question" | "blocker" | "complete" | "info";
}

export interface ProcessHost {
	readonly hostKind: HostKind;

	isAvailable(): Promise<boolean>;
	spawnWindow(input: HostSpawnWindowInput): Promise<HostTarget>;
	getCurrentTarget(): Promise<HostTarget | null>;
	focus(target: HostTargetRef): Promise<HostFocusResult>;
	stop(target: HostTargetRef, options?: { force?: boolean }): Promise<HostStopResult>;
	capture(target: HostTargetRef, options?: { lines?: number }): Promise<HostCaptureResult>;
	listInventory(): Promise<HostInventory>;
	targetExists(target: HostTargetRef, inventory?: HostInventory): Promise<boolean>;
	/** Optional; TmuxProcessHost no-ops. HerdProcessHost → notification show + sound map. */
	notify?(input: HostNotifyInput): Promise<void>;
}

export interface ProcessHostOptions {
	/** Default detached session for agent pool (tmux). */
	agentDetachedSessionName?: string;
	/** Default detached session for service pool (tmux). */
	serviceDetachedSessionName?: string;
}

export interface ResolveProcessHostInput {
	/** Explicit selection override (highest after env in loadConfig; here for tests). */
	selection?: ProcessHostSelection;
	/** Env map; defaults to process.env. Recognizes MEEPO_PROCESS_HOST. */
	env?: NodeJS.ProcessEnv;
	/** Config runtime.processHost when env unset. */
	configSelection?: ProcessHostSelection;
	/** Host construction options. */
	hostOptions?: ProcessHostOptions;
	/** Injectable probes for unit tests. */
	probes?: {
		herdrAvailable?: () => boolean;
		tmuxAvailable?: () => boolean;
	};
}

let frozenHost: ProcessHost | null = null;

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function commandExists(command: string): boolean {
	const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
		stdio: "ignore",
	});
	return result.status === 0;
}

/** Cheap herdr probe: binary on PATH and `--version` succeeds. */
export function probeHerdrAvailable(): boolean {
	if (!commandExists("herdr")) return false;
	const result = spawnSync("herdr", ["--version"], { encoding: "utf8", timeout: 3000 });
	return result.status === 0;
}

export function probeTmuxAvailable(): boolean {
	return commandExists("tmux");
}

export function parseProcessHostSelection(value: string | undefined | null): ProcessHostSelection | undefined {
	const trimmed = value?.trim().toLowerCase();
	if (trimmed === "auto" || trimmed === "tmux" || trimmed === "herdr") return trimmed;
	return undefined;
}

/**
 * Resolve which backend to use (does not freeze).
 * Precedence: explicit input.selection → env MEEPO_PROCESS_HOST → configSelection → auto.
 */
export function resolveProcessHostSelection(input: ResolveProcessHostInput = {}): ProcessHostSelection {
	if (input.selection) return input.selection;
	const env = input.env ?? process.env;
	const fromEnv = parseProcessHostSelection(env.MEEPO_PROCESS_HOST);
	if (fromEnv) return fromEnv;
	if (input.configSelection) return input.configSelection;
	return "auto";
}

/** Freeze host for this primary session. Throws if already frozen with a different kind (restart required). */
export function freezeProcessHost(host: ProcessHost): ProcessHost {
	if (frozenHost && frozenHost.hostKind !== host.hostKind) {
		throw new Error(
			`ProcessHost already frozen as ${frozenHost.hostKind}; cannot re-freeze as ${host.hostKind}. Restart the primary session to switch backends.`,
		);
	}
	frozenHost = host;
	return frozenHost;
}

/** Active frozen host, if any. */
export function getFrozenProcessHost(): ProcessHost | null {
	return frozenHost;
}

/**
 * Active frozen host. Call ensureProcessHost() from process-host-factory at runtime start.
 * Throws if the host was never frozen (programming error / tests that forgot ensure).
 */
export function getProcessHost(): ProcessHost {
	if (!frozenHost) {
		throw new Error(
			"ProcessHost is not frozen yet. Call ensureProcessHost() during MeepoRuntime.start().",
		);
	}
	return frozenHost;
}

/** Test helper: clear freeze between unit tests. */
export function resetProcessHostForTests(): void {
	frozenHost = null;
}

export function processHostSelectionFromConfig(config: MeepoConfig): ProcessHostSelection {
	return config.runtime.processHost ?? "auto";
}

/** Map registry-ish tmux columns + optional host_* into a HostTargetRef. */
export function hostTargetRefFromLegacy(input: {
	hostKind?: HostKind | string | null;
	hostPrimaryId?: string | null;
	hostDisplayName?: string | null;
	hostTargetJson?: string | null;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
}): HostTargetRef {
	let refs: HostTarget["refs"] = {};
	if (input.hostTargetJson) {
		try {
			refs = { ...JSON.parse(input.hostTargetJson) };
		} catch {
			refs = {};
		}
	}
	if (input.tmuxSessionId) refs.sessionId = input.tmuxSessionId;
	if (input.tmuxSessionName) refs.sessionName = input.tmuxSessionName;
	if (input.tmuxWindowId) refs.windowId = input.tmuxWindowId;
	if (input.tmuxPaneId) refs.paneId = input.tmuxPaneId;

	const hostKind =
		input.hostKind === "herdr" || input.hostKind === "tmux"
			? input.hostKind
			: refs.terminalId
				? "herdr"
				: "tmux";

	const primaryId =
		input.hostPrimaryId ||
		(hostKind === "herdr" ? refs.terminalId : refs.paneId || refs.windowId || refs.sessionId) ||
		undefined;

	return {
		hostKind,
		primaryId: primaryId ?? undefined,
		displayName: input.hostDisplayName ?? refs.agentName ?? undefined,
		refs,
	};
}

/** Persistable host fields from a HostTarget (dual-write with legacy tmux_*). */
export function hostFieldsFromTarget(target: HostTarget): {
	hostKind: HostKind;
	hostPrimaryId: string;
	hostDisplayName: string | null;
	hostTargetJson: string;
	tmuxSessionId: string | null;
	tmuxSessionName: string | null;
	tmuxWindowId: string | null;
	tmuxPaneId: string | null;
} {
	return {
		hostKind: target.hostKind,
		hostPrimaryId: target.primaryId,
		hostDisplayName: target.displayName ?? null,
		hostTargetJson: JSON.stringify(target.refs ?? {}),
		tmuxSessionId: target.refs.sessionId ?? null,
		tmuxSessionName: target.refs.sessionName ?? null,
		tmuxWindowId: target.refs.windowId ?? null,
		tmuxPaneId: target.refs.paneId ?? null,
	};
}
