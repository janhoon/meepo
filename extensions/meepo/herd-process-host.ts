/**
 * HerdProcessHost — ProcessHost adapter for herdr named agents.
 *
 * Policy: wayfinder #18 (port), #19 (naming/layout/stop).
 * herdr 0.8 layout: one new tab per child/service in the current workspace.
 * Flow: `tab create --cwd --no-focus` → `pane run <launch>` → `agent rename`.
 * Durable host id: terminal_id. Stop: pane close (last pane removes the tab).
 * Capture/focus: pane id or live name (not terminal_id).
 */

import { spawnSync } from "node:child_process";
import {
	allocateUniqueHostName,
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
	type ProcessHost,
	type ProcessHostOptions,
} from "./process-host.js";
import { shellQuote } from "./text-util.js";
import { probeHerdr } from "./herdr-compat.js";

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
	foreground_cwd?: string;
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

function resolveFocusTarget(target: HostTarget): string | null {
	return target.refs.agentName || target.displayName || target.refs.paneId || target.primaryId || null;
}

function resolveStopPaneId(target: HostTarget): string | null {
	return target.refs.paneId || null;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Tab label for herdr UI; keep short and shell-safe-ish. */
export function herdrTabLabelForSpawn(title: string, hostName: string): string {
	const raw = (title.trim() || hostName).replace(/\s+/g, " ");
	const max = 48;
	if (raw.length <= max) return raw;
	return `${raw.slice(0, max - 1)}…`;
}

interface HerdrTabCreated {
	tabId: string;
	rootPaneId: string | null;
	workspaceId: string | null;
}

function tabCreatedFromUnknown(value: unknown): HerdrTabCreated | null {
	if (!value || typeof value !== "object") return null;
	const record = value as Record<string, unknown>;
	const tab = (record.tab && typeof record.tab === "object" ? record.tab : record) as Record<
		string,
		unknown
	>;
	const tabId = typeof tab.tab_id === "string" ? tab.tab_id : null;
	if (!tabId) return null;
	const root =
		record.root_pane && typeof record.root_pane === "object"
			? (record.root_pane as Record<string, unknown>)
			: null;
	const rootPaneId = typeof root?.pane_id === "string" ? root.pane_id : null;
	const workspaceId =
		(typeof tab.workspace_id === "string" ? tab.workspace_id : null) ??
		(typeof root?.workspace_id === "string" ? root.workspace_id : null);
	return { tabId, rootPaneId, workspaceId };
}

const NOTIFY_RATE_WINDOW_MS = 30_000;
const NOTIFY_BODY_MAX = 200;

/** Policy #19 sound map. info is off by default (no CLI call). */
function notifySoundForKind(kind: HostNotifyInput["kind"]): "request" | "done" | null {
	switch (kind) {
		case "question":
		case "blocker":
			return "request";
		case "complete":
			return "done";
		case "info":
		default:
			return null;
	}
}

function truncateNotifyBody(body: string | undefined): string | undefined {
	if (body == null) return undefined;
	const trimmed = body.replace(/\s+/g, " ").trim();
	if (!trimmed) return undefined;
	if (trimmed.length <= NOTIFY_BODY_MAX) return trimmed;
	return `${trimmed.slice(0, NOTIFY_BODY_MAX - 1)}…`;
}

export class HerdProcessHost implements ProcessHost {
	readonly hostKind = "herdr" as const;
	private readonly runHerdr: HerdrCliRunner;
	private readonly isAvailableProbe: () => boolean;
	/** rateKey → kind → last delivered at (ms). */
	private readonly notifyLastAt = new Map<string, Map<HostNotifyInput["kind"], number>>();
	/** rateKeys that already received a complete notification this host lifetime. */
	private readonly notifyCompleteOnce = new Set<string>();

	constructor(options: HerdProcessHostOptions = {}) {
		this.runHerdr = options.runHerdr ?? defaultRunHerdr;
		this.isAvailableProbe = options.isAvailableProbe ?? (() => probeHerdr().status === "ok");
	}

	private shouldDeliverNotify(input: HostNotifyInput, now: number): boolean {
		const key = input.rateKey?.trim();
		if (!key) return true;
		if (input.kind === "complete") {
			if (this.notifyCompleteOnce.has(key)) return false;
			return true;
		}
		const byKind = this.notifyLastAt.get(key);
		const last = byKind?.get(input.kind);
		if (last != null && now - last < NOTIFY_RATE_WINDOW_MS) return false;
		return true;
	}

	private recordNotifyDelivery(input: HostNotifyInput, now: number): void {
		const key = input.rateKey?.trim();
		if (!key) return;
		if (input.kind === "complete") {
			this.notifyCompleteOnce.add(key);
		}
		let byKind = this.notifyLastAt.get(key);
		if (!byKind) {
			byKind = new Map();
			this.notifyLastAt.set(key, byKind);
		}
		byKind.set(input.kind, now);
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

	async targetExists(target: HostTarget, inventory?: HostInventory): Promise<boolean> {
		const inv = inventory ?? (await this.listInventory());
		if (target.primaryId && inv.primaryIds.has(target.primaryId)) return true;
		const name = target.displayName;
		if (name && inv.displayNames.has(name)) return true;
		return false;
	}

	private closeTabBestEffort(tabId: string | null | undefined): void {
		if (!tabId) return;
		try {
			this.invoke(["tab", "close", tabId]);
		} catch {
			// ignore cleanup failure
		}
	}

	private paneInfo(paneId: string): HerdrAgentInfo | null {
		const envelope = this.invoke(["pane", "get", paneId]);
		const pane = (envelope.result as { pane?: HerdrAgentInfo } | undefined)?.pane;
		return pane ?? null;
	}

	/** Wait until tab create has a pane_id and cwd. `pane run` needs that shell. */
	private async waitForPaneCwd(paneId: string, timeoutMs = 8_000): Promise<HerdrAgentInfo> {
		const deadline = Date.now() + timeoutMs;
		let last: HerdrAgentInfo | null = null;
		let lastError: Error | undefined;
		while (Date.now() < deadline) {
			try {
				last = this.paneInfo(paneId);
				const cwd = last?.cwd ?? last?.foreground_cwd;
				if (last?.pane_id && cwd) return last;
			} catch (error) {
				lastError = error as Error;
			}
			await sleep(150);
		}
		throw lastError ?? new Error(`herdr pane ${paneId} did not report cwd: ${JSON.stringify(last)}`);
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
		const launchLine = input.launchCommand.trim();

		const tabArgs = ["tab", "create", "--no-focus"];
		if (workspaceId) tabArgs.push("--workspace", workspaceId);
		if (input.cwd) tabArgs.push("--cwd", input.cwd);
		if (input.env) {
			for (const [key, value] of Object.entries(input.env)) {
				if (!key) continue;
				tabArgs.push("--env", `${key}=${value}`);
			}
		}
		tabArgs.push("--label", herdrTabLabelForSpawn(input.title, desiredName));
		const tabEnvelope = this.invoke(tabArgs);
		const createdTab = tabCreatedFromUnknown(tabEnvelope.result);
		if (!createdTab?.tabId || !createdTab.rootPaneId) {
			throw new Error(`herdr tab create returned no tab/pane: ${JSON.stringify(tabEnvelope)}`);
		}
		const { tabId, rootPaneId } = createdTab;

		try {
			const shell = await this.waitForPaneCwd(rootPaneId);
			this.invoke(["pane", "run", rootPaneId, launchLine]);
			const pane = this.paneInfo(rootPaneId) ?? shell;
			const named = this.assignPaneName(rootPaneId, desiredName, input.entityId, inventory);
			return toHostTarget(
				{
					...pane,
					name: named ?? undefined,
					pane_id: pane.pane_id ?? rootPaneId,
					tab_id: pane.tab_id ?? tabId,
					terminal_id: pane.terminal_id ?? shell.terminal_id,
				},
				named ?? undefined,
			);
		} catch (error) {
			this.closeTabBestEffort(tabId);
			throw error;
		}
	}

	private assignPaneName(
		paneId: string,
		desiredName: string,
		entityId: string,
		inventory: HostInventory,
	): string | null {
		let name = desiredName;
		for (let attempt = 0; attempt < 8; attempt += 1) {
			try {
				this.invoke(["agent", "rename", paneId, name]);
				return name;
			} catch (error) {
				const err = error as Error & { herdrCode?: string };
				if (err.herdrCode === "agent_name_taken") {
					inventory.displayNames.add(name);
					name = allocateUniqueHostName({ desired: desiredName, entityId, inventory });
					continue;
				}
				// pane run has not produced a herdr-detected agent yet; pane_id is the handle.
				if (err.herdrCode === "agent_not_found") return null;
				throw error;
			}
		}
		throw new Error(`herdr agent rename failed for all 32-char candidates near ${desiredName}`);
	}

	async focus(target: HostTarget): Promise<HostFocusResult> {
		const focusTarget = resolveFocusTarget(target);
		const command = focusTarget
			? `herdr agent focus ${shellQuote(focusTarget)}`
			: "herdr agent focus <target>";
		if (!focusTarget) {
			return {
				focused: false,
				command,
				reason: "Missing herdr target (pane_id / displayName).",
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

	async stop(target: HostTarget, options?: { force?: boolean }): Promise<HostStopResult> {
		const force = options?.force ?? false;
		const focusTarget = resolveFocusTarget(target);
		let resolvedPaneId = resolveStopPaneId(target);
		if (!resolvedPaneId && focusTarget) {
			try {
				const envelope = this.invoke(["agent", "get", focusTarget]);
				const agent = agentInfoFromUnknown(envelope.result);
				resolvedPaneId = agent?.pane_id ?? null;
			} catch {
				// leftover rows without refs.paneId still resolve live.
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

	async capture(target: HostTarget, options?: { lines?: number }): Promise<HostCaptureResult> {
		const lines = Math.max(1, options?.lines ?? 200);
		const focusTarget = resolveFocusTarget(target);
		const kind = "agent";
		const id = focusTarget;
		if (!id) throw new Error("Missing herdr target for capture (pane_id / displayName).");
		const command = `herdr ${kind} read ${shellQuote(id)} --source recent --lines ${lines}`;
		const envelope = this.invoke([kind, "read", id, "--source", "recent", "--lines", String(lines)]);
		const read = (envelope.result as { read?: { text?: string } } | undefined)?.read;
		return { content: read?.text ?? "", command };
	}

	/**
	 * herdr notification show — policy #19.
	 * question/blocker → sound request; complete → done; info → no-op.
	 * Rate limit: 1 per rateKey+kind per 30s; complete once per rateKey per host lifetime.
	 * Failures are swallowed (toast UX must not break attention wake).
	 */
	async notify(input: HostNotifyInput): Promise<void> {
		const sound = notifySoundForKind(input.kind);
		if (sound == null) return;

		const title = input.title.replace(/\s+/g, " ").trim();
		if (!title) return;

		const now = Date.now();
		if (!this.shouldDeliverNotify(input, now)) return;

		const body = truncateNotifyBody(input.body);
		const args = ["notification", "show", title, "--sound", sound];
		if (body) {
			args.push("--body", body);
		}

		try {
			this.invoke(args);
			this.recordNotifyDelivery(input, now);
		} catch {
			// Soft-fail: host toast is best-effort UX, not control-plane truth.
		}
	}
}

export function createHerdProcessHost(options: HerdProcessHostOptions = {}): HerdProcessHost {
	return new HerdProcessHost(options);
}
