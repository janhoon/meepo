/**
 * HerdProcessHost — ProcessHost adapter for herdr named agents.
 *
 * Policy: wayfinder #18 (port), #19 (naming/layout/stop), research herdr 0.7.x lifecycle.
 * Layout: current workspace, active tab (no tab create), always --no-focus, no split.
 * Durable host id: terminal_id. Stop: pane close. Capture: agent read.
 *
 * Small-model English namer is fog until model/flags are specified; slug fallback is used.
 */

import { spawnSync } from "node:child_process";
import {
	fallbackAgentHostName,
	fallbackServiceHostName,
} from "./host-naming.js";
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
	probeHerdrAvailable,
} from "./process-host.js";

/** Lifecycle ops are implemented — auto may select herdr when probe succeeds. */
export const HERD_PROCESS_HOST_LIFECYCLE_READY = true;

export interface HerdrCliResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

export type HerdrCliRunner = (args: string[]) => HerdrCliResult;

export interface HerdProcessHostOptions extends ProcessHostOptions {
	/** Injectable CLI runner (tests). Defaults to `herdr` on PATH. */
	runHerdr?: HerdrCliRunner;
	/** Override availability probe (tests). */
	isAvailableProbe?: () => boolean;
}

interface HerdrEnvelope {
	id?: string;
	result?: unknown;
	error?: {
		code?: string;
		message?: string;
	};
}

interface HerdrAgentInfo {
	name?: string | null;
	terminal_id?: string;
	pane_id?: string;
	tab_id?: string;
	workspace_id?: string;
	cwd?: string;
	focused?: boolean;
	agent_status?: string;
	agent?: string | null;
	terminal_title?: string;
}

function defaultRunHerdr(args: string[]): HerdrCliResult {
	const result = spawnSync("herdr", args, {
		encoding: "utf8",
		timeout: 20_000,
		maxBuffer: 8 * 1024 * 1024,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function parseEnvelope(raw: string): HerdrEnvelope {
	const text = raw.trim();
	if (!text) return {};
	try {
		return JSON.parse(text) as HerdrEnvelope;
	} catch {
		// Some errors may print non-JSON; wrap as message.
		return { error: { code: "parse_error", message: text } };
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function agentInfoFromUnknown(value: unknown): HerdrAgentInfo | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	// agent_started nests under result.agent; agent_info under result.agent; list under result.agents
	if (record.agent && typeof record.agent === "object") {
		return record.agent as HerdrAgentInfo;
	}
	if (record.terminal_id || record.pane_id || record.name) {
		return record as HerdrAgentInfo;
	}
	return null;
}

function toHostTarget(agent: HerdrAgentInfo, displayName?: string): HostTarget {
	const terminalId = agent.terminal_id;
	if (!terminalId) {
		throw new Error(`herdr agent response missing terminal_id: ${JSON.stringify(agent)}`);
	}
	const name = displayName ?? agent.name ?? undefined;
	return {
		hostKind: "herdr",
		primaryId: terminalId,
		displayName: name ?? undefined,
		refs: {
			terminalId,
			workspaceId: agent.workspace_id,
			tabId: agent.tab_id,
			paneId: agent.pane_id,
			agentName: name ?? undefined,
		},
	};
}

function resolveFocusTarget(target: HostTargetRef): string | null {
	return (
		target.primaryId ||
		target.refs?.terminalId ||
		target.displayName ||
		target.refs?.agentName ||
		target.refs?.paneId ||
		null
	);
}

function resolvePaneId(target: HostTargetRef): string | null {
	return target.refs?.paneId || null;
}

function launchArgvFromCommand(launchCommand: string): string[] {
	// Meepo spawn paths pass a shell fragment (e.g. exec '/path/launch.sh').
	// herdr agent start takes real argv after `--`.
	return ["bash", "-lc", launchCommand];
}

export class HerdProcessHost implements ProcessHost {
	readonly hostKind = "herdr" as const;
	private readonly runHerdr: HerdrCliRunner;
	private readonly isAvailableProbe: () => boolean;

	constructor(options: HerdProcessHostOptions = {}) {
		this.runHerdr = options.runHerdr ?? defaultRunHerdr;
		this.isAvailableProbe = options.isAvailableProbe ?? probeHerdrAvailable;
	}

	private invoke(args: string[]): HerdrEnvelope {
		const result = this.runHerdr(args);
		const combined = `${result.stdout || ""}${result.stderr ? `\n${result.stderr}` : ""}`.trim();
		const envelope = parseEnvelope(result.stdout || result.stderr || "");
		if (result.status !== 0) {
			const code = envelope.error?.code;
			const message =
				envelope.error?.message ||
				combined ||
				`herdr ${args.join(" ")} failed (exit ${result.status})`;
			const err = new Error(message) as Error & { herdrCode?: string; herdrEnvelope?: HerdrEnvelope };
			err.herdrCode = code;
			err.herdrEnvelope = envelope;
			throw err;
		}
		if (envelope.error) {
			const err = new Error(envelope.error.message || "herdr error") as Error & {
				herdrCode?: string;
				herdrEnvelope?: HerdrEnvelope;
			};
			err.herdrCode = envelope.error.code;
			err.herdrEnvelope = envelope;
			throw err;
		}
		return envelope;
	}

	async isAvailable(): Promise<boolean> {
		return this.isAvailableProbe();
	}

	async getCurrentTarget(): Promise<HostTarget | null> {
		try {
			const envelope = this.invoke(["pane", "current"]);
			const result = envelope.result as { pane?: HerdrAgentInfo; type?: string } | undefined;
			const pane = result?.pane;
			if (!pane?.terminal_id) return null;
			return {
				hostKind: "herdr",
				primaryId: pane.terminal_id,
				displayName: pane.name ?? undefined,
				refs: {
					terminalId: pane.terminal_id,
					workspaceId: pane.workspace_id,
					tabId: pane.tab_id,
					paneId: pane.pane_id,
					agentName: pane.name ?? undefined,
				},
			};
		} catch {
			return null;
		}
	}

	async listInventory(): Promise<HostInventory> {
		const primaryIds = new Set<string>();
		const displayNames = new Set<string>();
		const paneIds = new Set<string>();
		const terminalIds = new Set<string>();

		// Prefer full snapshot so services/unnamed panes still reconcile by terminal_id.
		try {
			const envelope = this.invoke(["api", "snapshot"]);
			const snapshot = (envelope.result as { snapshot?: { panes?: HerdrAgentInfo[]; agents?: HerdrAgentInfo[] } })
				?.snapshot;
			const panes = snapshot?.panes ?? [];
			const agents = snapshot?.agents ?? [];
			for (const pane of panes) {
				if (pane.terminal_id) {
					primaryIds.add(pane.terminal_id);
					terminalIds.add(pane.terminal_id);
				}
				if (pane.pane_id) paneIds.add(pane.pane_id);
				if (pane.name) displayNames.add(pane.name);
			}
			for (const agent of agents) {
				if (agent.terminal_id) {
					primaryIds.add(agent.terminal_id);
					terminalIds.add(agent.terminal_id);
				}
				if (agent.pane_id) paneIds.add(agent.pane_id);
				if (agent.name) displayNames.add(agent.name);
			}
		} catch {
			// Fall back to agent list only.
			try {
				const envelope = this.invoke(["agent", "list"]);
				const agents =
					(envelope.result as { agents?: HerdrAgentInfo[] } | undefined)?.agents ?? [];
				for (const agent of agents) {
					if (agent.terminal_id) {
						primaryIds.add(agent.terminal_id);
						terminalIds.add(agent.terminal_id);
					}
					if (agent.pane_id) paneIds.add(agent.pane_id);
					if (agent.name) displayNames.add(agent.name);
				}
			} catch {
				// empty inventory
			}
		}

		return {
			primaryIds,
			displayNames,
			raw: {
				terminalIds,
				paneIds,
				displayNames: new Set(displayNames),
			},
		};
	}

	async targetExists(target: HostTargetRef, inventory?: HostInventory): Promise<boolean> {
		const inv = inventory ?? (await this.listInventory());
		const primary =
			target.primaryId ||
			target.refs?.terminalId ||
			undefined;
		if (primary && inv.primaryIds.has(primary)) return true;
		const paneId = target.refs?.paneId;
		if (paneId && inv.raw?.paneIds?.has(paneId)) return true;
		const name = target.displayName || target.refs?.agentName;
		if (name && inv.displayNames.has(name)) return true;
		return false;
	}

	async spawnWindow(input: HostSpawnWindowInput): Promise<HostTarget> {
		if (!(await this.isAvailable())) {
			throw new Error("herdr is not installed or not available (probe failed).");
		}

		const inventory = await this.listInventory();
		const desiredName =
			input.pool === "services"
				? fallbackServiceHostName(input.title, input.entityId, inventory)
				: fallbackAgentHostName(input.title, input.entityId, inventory);

		const current = await this.getCurrentTarget();
		const workspaceId = current?.refs.workspaceId;
		// Active tab of current workspace — omit --tab so herdr uses active tab (policy #19).
		const argv = launchArgvFromCommand(input.launchCommand);

		const tryNames = [desiredName];
		// Precompute a few collision retries in case of races with concurrent spawns.
		for (let n = 2; n <= 6; n += 1) {
			const base = desiredName.length > 40 ? desiredName.slice(0, 40) : desiredName;
			tryNames.push(`${base}-${n}`);
		}
		const entitySuffix = input.entityId.replace(/[^a-zA-Z0-9]/g, "").slice(-6);
		if (entitySuffix) tryNames.push(`${desiredName.slice(0, 40)}-${entitySuffix}`);

		let lastError: Error | undefined;
		for (const name of tryNames) {
			const args = ["agent", "start", name];
			if (input.cwd) {
				args.push("--cwd", input.cwd);
			}
			if (workspaceId) {
				args.push("--workspace", workspaceId);
			}
			args.push("--no-focus");
			if (input.env) {
				for (const [key, value] of Object.entries(input.env)) {
					if (!key) continue;
					args.push("--env", `${key}=${value}`);
				}
			}
			args.push("--", ...argv);

			try {
				const envelope = this.invoke(args);
				const agent = agentInfoFromUnknown(envelope.result);
				if (!agent) {
					throw new Error(`herdr agent start returned no agent payload: ${JSON.stringify(envelope)}`);
				}
				// Ensure name is present on target even if server omits it.
				if (!agent.name) agent.name = name;
				return toHostTarget(agent, name);
			} catch (error) {
				const err = error as Error & { herdrCode?: string };
				lastError = err;
				if (err.herdrCode === "agent_name_taken") {
					// Retry with next candidate name.
					continue;
				}
				throw error;
			}
		}
		throw lastError ?? new Error(`herdr agent start failed for all name candidates near ${desiredName}`);
	}

	async focus(target: HostTargetRef): Promise<HostFocusResult> {
		const focusTarget = resolveFocusTarget(target);
		const command = focusTarget
			? `herdr agent focus ${shellQuote(focusTarget)}`
			: "herdr agent focus <target>";
		if (!focusTarget) {
			return {
				focused: false,
				command,
				reason: "Missing herdr target (terminal_id / displayName / pane_id).",
			};
		}
		try {
			this.invoke(["agent", "focus", focusTarget]);
			return { focused: true, command };
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				focused: false,
				command,
				reason: message,
			};
		}
	}

	async stop(target: HostTargetRef, options?: { force?: boolean }): Promise<HostStopResult> {
		const force = options?.force ?? false;
		const paneId = resolvePaneId(target);
		const focusTarget = resolveFocusTarget(target);

		// Resolve pane_id via agent get when only terminal_id/name is known.
		let resolvedPaneId = paneId;
		if (!resolvedPaneId && focusTarget) {
			try {
				const envelope = this.invoke(["agent", "get", focusTarget]);
				const agent = agentInfoFromUnknown(envelope.result);
				resolvedPaneId = agent?.pane_id ?? null;
			} catch {
				// fall through
			}
		}

		const command = resolvedPaneId
			? `herdr pane close ${shellQuote(resolvedPaneId)}`
			: focusTarget
				? `herdr pane close (via ${shellQuote(focusTarget)})`
				: "herdr pane close <pane_id>";

		if (!resolvedPaneId) {
			if (force) {
				return {
					stopped: true,
					graceful: false,
					command,
					reason: "herdr pane target missing; treating as stopped for reconcile.",
				};
			}
			return {
				stopped: false,
				graceful: true,
				command,
				reason: "Missing herdr pane_id for stop. Use force=true or reconcile.",
			};
		}

		try {
			this.invoke(["pane", "close", resolvedPaneId]);
			return {
				stopped: true,
				graceful: !force,
				command,
			};
		} catch (error) {
			const err = error as Error & { herdrCode?: string };
			const message = err.message || String(error);
			// Missing pane on force → soft success for reconcile.
			if (force && (err.herdrCode === "pane_not_found" || err.herdrCode === "agent_not_found")) {
				return {
					stopped: true,
					graceful: false,
					command,
					reason: message,
				};
			}
			if (!force && (err.herdrCode === "pane_not_found" || err.herdrCode === "agent_not_found")) {
				return {
					stopped: false,
					graceful: true,
					command,
					reason: message,
				};
			}
			throw error;
		}
	}

	async capture(target: HostTargetRef, options?: { lines?: number }): Promise<HostCaptureResult> {
		const lines = Math.max(1, options?.lines ?? 200);
		const focusTarget = resolveFocusTarget(target);
		if (!focusTarget) {
			throw new Error("Missing herdr target for capture (terminal_id / displayName / pane_id).");
		}
		const command = `herdr agent read ${shellQuote(focusTarget)} --source recent --lines ${lines}`;
		const envelope = this.invoke([
			"agent",
			"read",
			focusTarget,
			"--source",
			"recent",
			"--lines",
			String(lines),
		]);
		const read = (envelope.result as { read?: { text?: string } } | undefined)?.read;
		const content = read?.text ?? "";
		return { content, command };
	}

	async notify(_input: HostNotifyInput): Promise<void> {
		// Notification policy + wiring lands with ticket #23.
	}
}

export function createHerdProcessHost(options: HerdProcessHostOptions = {}): HerdProcessHost {
	return new HerdProcessHost(options);
}
