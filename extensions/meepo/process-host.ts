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
import type { HerdrProbe } from "./herdr-compat.js";
import { shellQuote } from "./text-util.js";

export type HostKind = "tmux" | "herdr";
export type ProcessHostSelection = "auto" | HostKind;

export type HostTargetRefs = {
	sessionId?: string;
	sessionName?: string;
	windowId?: string;
	paneId?: string;
	terminalId?: string;
	workspaceId?: string;
	tabId?: string;
	agentName?: string;
};

export interface HostTarget {
	hostKind: HostKind;
	/** Stable id: tmux pane (prefer) or composite; herdr terminal_id */
	primaryId: string;
	/** Host-facing name when present (herdr agent name; optional tmux window label) */
	displayName?: string;
	refs: HostTargetRefs;
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
	/**
	 * Rate-limit key (typically Meepo agent id).
	 * herdr: max 1 per key+kind per 30s; complete once per key per host lifetime.
	 * When omitted, every call is delivered (still subject to info-off policy).
	 */
	rateKey?: string;
}

export interface ProcessHost {
	readonly hostKind: HostKind;

	isAvailable(): Promise<boolean>;
	spawnWindow(input: HostSpawnWindowInput): Promise<HostTarget>;
	getCurrentTarget(): Promise<HostTarget | null>;
	focus(target: HostTarget): Promise<HostFocusResult>;
	stop(target: HostTarget, options?: { force?: boolean }): Promise<HostStopResult>;
	capture(target: HostTarget, options?: { lines?: number }): Promise<HostCaptureResult>;
	listInventory(): Promise<HostInventory>;
	targetExists(target: HostTarget, inventory?: HostInventory): Promise<boolean>;
	/** Required. TmuxProcessHost no-ops. HerdProcessHost → notification show + sound map. */
	notify(input: HostNotifyInput): Promise<void>;
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
		tmuxAvailable?: () => boolean;
		probeHerdr?: () => HerdrProbe;
	};
}

let frozenHost: ProcessHost | null = null;

export function commandExists(command: string): boolean {
	const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
		stdio: "ignore",
	});
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
	return "herdr";
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
	return config.runtime.processHost ?? "herdr";
}

export function parseHostKind(value: string | null | undefined): HostKind | undefined {
	return value === "herdr" || value === "tmux" ? value : undefined;
}

export function formatHost(host: HostTarget | null | undefined): string {
	if (!host?.primaryId && !host?.displayName) return "-";
	const name = host.displayName ?? host.primaryId;
	return `${host.hostKind} ${name}`;
}

/** Persistable host_* columns from a live HostTarget. */
export function persistHostFields(target: HostTarget): {
	hostKind: HostKind;
	hostPrimaryId: string;
	hostDisplayName: string | null;
	hostTargetJson: string;
} {
	return {
		hostKind: target.hostKind,
		hostPrimaryId: target.primaryId,
		hostDisplayName: target.displayName ?? null,
		hostTargetJson: JSON.stringify(target.refs ?? {}),
	};
}

function parseHostTargetRefs(json: string | null | undefined): HostTargetRefs | null {
	if (!json) return null;
	try {
		const parsed = JSON.parse(json) as unknown;
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		return parsed as HostTargetRefs;
	} catch {
		return null;
	}
}

/** Best-effort refs for leftover rows that never stored host_target_json. */
function inferLegacyRefs(kind: HostKind, primaryId: string, displayName: string | null | undefined): HostTargetRefs {
	if (kind === "herdr") {
		return { terminalId: primaryId, ...(displayName ? { agentName: displayName } : {}) };
	}
	const refs: HostTargetRefs = {};
	if (primaryId.startsWith("$")) refs.sessionId = primaryId;
	if (displayName) refs.sessionName = displayName;
	if (primaryId.startsWith("@")) refs.windowId = primaryId;
	if (primaryId.startsWith("%")) refs.paneId = primaryId;
	return refs;
}

export function hostFromRecord(input: {
	host?: HostTarget | null;
	hostKind?: HostKind | string | null;
	hostPrimaryId?: string | null;
	hostDisplayName?: string | null;
	hostTargetJson?: string | null;
}): HostTarget | null {
	if (input.host?.hostKind && input.host.primaryId) return input.host;
	const kind = parseHostKind(input.hostKind);
	const primaryId = input.hostPrimaryId;
	if (!kind || !primaryId) return null;
	return {
		hostKind: kind,
		primaryId,
		displayName: input.hostDisplayName ?? undefined,
		refs: parseHostTargetRefs(input.hostTargetJson) ?? inferLegacyRefs(kind, primaryId, input.hostDisplayName),
	};
}
