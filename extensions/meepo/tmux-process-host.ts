/**
 * TmuxProcessHost — ProcessHost adapter over the existing tmux CLI surface.
 */

import { spawnSync } from "node:child_process";
import {
	type HostCaptureResult,
	type HostFocusResult,
	type HostInventory,
	type HostNotifyInput,
	type HostSpawnWindowInput,
	type HostStopResult,
	type HostTarget,
	type HostTargetRef,
	type ProcessHost,
	type ProcessHostOptions,
	commandExists,
} from "./process-host.js";
import {
	captureTmuxTarget,
	focusTmuxTarget,
	getTmuxInventory,
	stopTmuxTarget,
	tmuxTargetExists,
	type TmuxTargetInput,
} from "./tmux.js";

const TMUX_OUTPUT_FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}";
const DEFAULT_AGENT_SESSION = "pi-subagents";
const DEFAULT_SERVICE_SESSION = "pi-services";

function runTmux(args: string[]): string {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `tmux ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
}

function parseTmuxIds(output: string): {
	sessionId: string;
	sessionName: string;
	windowId: string;
	paneId: string;
} {
	const [sessionId, sessionName, windowId, paneId] = output.trim().split("\t");
	if (!sessionId || !sessionName || !windowId || !paneId) {
		throw new Error(`Unexpected tmux target output: ${JSON.stringify(output)}`);
	}
	return { sessionId, sessionName, windowId, paneId };
}

function toHostTarget(ids: {
	sessionId: string;
	sessionName: string;
	windowId: string;
	paneId: string;
}, displayName?: string): HostTarget {
	return {
		hostKind: "tmux",
		// Prefer pane id as durable primary (matches targetExists preference).
		primaryId: ids.paneId,
		displayName,
		refs: {
			sessionId: ids.sessionId,
			sessionName: ids.sessionName,
			windowId: ids.windowId,
			paneId: ids.paneId,
		},
	};
}

function sanitizeWindowName(title: string, entityId: string): string {
	const safeTitle = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	const base = safeTitle || "agent";
	return `${base.slice(0, 24)}-${entityId.slice(-6)}`;
}

function refToTmuxInput(target: HostTargetRef): TmuxTargetInput {
	const refs = target.refs ?? {};
	return {
		sessionId: refs.sessionId ?? null,
		sessionName: refs.sessionName ?? null,
		windowId: refs.windowId ?? null,
		paneId: refs.paneId ?? (target.primaryId?.startsWith("%") ? target.primaryId : null),
	};
}

function inventoryFromTmux(): HostInventory {
	const raw = getTmuxInventory();
	const primaryIds = new Set<string>([...raw.panes, ...raw.windows, ...raw.sessions]);
	return {
		primaryIds,
		displayNames: new Set(raw.sessionNames),
		raw: {
			sessions: raw.sessions,
			sessionNames: raw.sessionNames,
			windows: raw.windows,
			panes: raw.panes,
		},
	};
}

export class TmuxProcessHost implements ProcessHost {
	readonly hostKind = "tmux" as const;
	private readonly agentDetachedSessionName: string;
	private readonly serviceDetachedSessionName: string;

	constructor(options: ProcessHostOptions = {}) {
		this.agentDetachedSessionName = options.agentDetachedSessionName ?? DEFAULT_AGENT_SESSION;
		this.serviceDetachedSessionName = options.serviceDetachedSessionName ?? DEFAULT_SERVICE_SESSION;
	}

	async isAvailable(): Promise<boolean> {
		return commandExists("tmux");
	}

	async getCurrentTarget(): Promise<HostTarget | null> {
		if (!process.env.TMUX) return null;
		try {
			const ids = parseTmuxIds(runTmux(["display-message", "-p", TMUX_OUTPUT_FORMAT]));
			return toHostTarget(ids);
		} catch {
			return null;
		}
	}

	async spawnWindow(input: HostSpawnWindowInput): Promise<HostTarget> {
		if (!(await this.isAvailable())) {
			throw new Error("tmux is not installed or not on PATH.");
		}
		const detached =
			input.detachedSessionName ??
			(input.pool === "services" ? this.serviceDetachedSessionName : this.agentDetachedSessionName);
		const windowName = sanitizeWindowName(input.title, input.entityId);
		// launchCommand is already a shell command (e.g. exec '…/launch.sh').
		const launchCommand = input.launchCommand;
		const current = await this.getCurrentTarget();
		if (current?.refs.sessionId) {
			const ids = parseTmuxIds(
				runTmux([
					"new-window",
					"-t",
					current.refs.sessionId,
					"-P",
					"-F",
					TMUX_OUTPUT_FORMAT,
					"-n",
					windowName,
					launchCommand,
				]),
			);
			return toHostTarget(ids, windowName);
		}
		const hasDetached =
			spawnSync("tmux", ["has-session", "-t", detached], { stdio: "ignore" }).status === 0;
		if (hasDetached) {
			const ids = parseTmuxIds(
				runTmux(["new-window", "-t", detached, "-P", "-F", TMUX_OUTPUT_FORMAT, "-n", windowName, launchCommand]),
			);
			return toHostTarget(ids, windowName);
		}
		const ids = parseTmuxIds(
			runTmux([
				"new-session",
				"-d",
				"-P",
				"-F",
				TMUX_OUTPUT_FORMAT,
				"-s",
				detached,
				"-n",
				windowName,
				launchCommand,
			]),
		);
		return toHostTarget(ids, windowName);
	}

	async focus(target: HostTargetRef): Promise<HostFocusResult> {
		return focusTmuxTarget(refToTmuxInput(target));
	}

	async stop(target: HostTargetRef, options?: { force?: boolean }): Promise<HostStopResult> {
		return stopTmuxTarget(refToTmuxInput(target), options?.force ?? false);
	}

	async capture(target: HostTargetRef, options?: { lines?: number }): Promise<HostCaptureResult> {
		return captureTmuxTarget(refToTmuxInput(target), options?.lines ?? 200);
	}

	async listInventory(): Promise<HostInventory> {
		return inventoryFromTmux();
	}

	async targetExists(target: HostTargetRef, inventory?: HostInventory): Promise<boolean> {
		const inv = inventory ?? (await this.listInventory());
		const tmuxInv = {
			sessions: inv.raw?.sessions ?? new Set<string>(),
			sessionNames: inv.raw?.sessionNames ?? new Set<string>(),
			windows: inv.raw?.windows ?? new Set<string>(),
			panes: inv.raw?.panes ?? new Set<string>(),
		};
		// If raw missing, rebuild from primaryIds best-effort via tmuxTargetExists path.
		if (!inv.raw) {
			return tmuxTargetExists(refToTmuxInput(target), getTmuxInventory());
		}
		return tmuxTargetExists(refToTmuxInput(target), tmuxInv);
	}

	async notify(_input: HostNotifyInput): Promise<void> {
		// tmux backend: notifications are no-ops (policy #19).
	}
}

export function createTmuxProcessHost(options: ProcessHostOptions = {}): TmuxProcessHost {
	return new TmuxProcessHost(options);
}
