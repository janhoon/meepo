/**
 * Service ops: start, focus, capture, stop, reconcile Services.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { getProcessHost } from "./process-host.js";
import { getProjectKey } from "./project.js";
import { getService, listServices, updateService } from "./service-registry.js";
import { readServiceStatus, spawnService, tailFileLines } from "./service-spawn.js";
import type {
	ListServicesFilters,
	ServiceStatusSnapshot,
	ServiceSummary,
	SpawnServiceResult,
	UpdateServiceInput,
} from "./service-types.js";
import { assertDirectory, resolveInputPath } from "./session-scope.js";

function readLatestServiceStatus(service: ServiceSummary): ServiceStatusSnapshot | null {
	return readServiceStatus(service.latestStatusFile);
}

function buildServicePatchFromStatus(service: ServiceSummary, status: ServiceStatusSnapshot): UpdateServiceInput {
	const nextState = status.state;
	const nextLastError =
		nextState === "error"
			? (status.lastError ??
				(typeof status.lastExitCode === "number" ? `Command exited with status ${status.lastExitCode}.` : service.lastError ?? "Service exited with an error."))
			: null;
	return {
		state: nextState,
		updatedAt: status.updatedAt,
		finishedAt: status.finishedAt ?? (nextState === "running" || nextState === "launching" ? null : service.finishedAt),
		lastExitCode: status.lastExitCode ?? (nextState === "running" ? null : service.lastExitCode),
		lastError: nextLastError,
	};
}

function maybeDetectServiceReady(service: ServiceSummary): number | null {
	if (!service.readySubstring || service.readyMatchedAt) return null;
	const output = tailFileLines(service.logFile, 4000);
	if (!output.includes(service.readySubstring)) return null;
	return Date.now();
}

/** Active Meepo config for this extension process (set on register). */
export function resolveServiceFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session",
	params: { activeOnly?: boolean; limit?: number },
): ListServicesFilters {
	const filters: ListServicesFilters = {
		activeOnly: params.activeOnly,
		limit: params.limit,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export async function spawnServiceFromParams(ctx: ExtensionContext, params: {
	title: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	readySubstring?: string;
	readyTimeoutSec?: number;
}): Promise<SpawnServiceResult> {
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	return spawnService({
		title: params.title,
		command: params.command,
		spawnCwd,
		env: params.env,
		readySubstring: params.readySubstring,
		readyTimeoutSec: params.readyTimeoutSec,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

export async function focusServiceById(id: string): Promise<{ service: ServiceSummary; result: { focused: boolean; command: string; reason?: string } }> {
	const service = getService(getMeepoDb(), id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	if (!service.host) throw new Error(`Service ${service.id} has no HostTarget.`);
	const result = await getProcessHost().focus(service.host);
	return { service, result };
}

export async function captureServiceById(id: string, lines = 200): Promise<{ service: ServiceSummary; content: string; command: string; source: "host" | "log" }> {
	const db = getMeepoDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const host = getProcessHost();
	const target = service.host;
	if (target && (await host.targetExists(target))) {
		const result = await host.capture(target, { lines });
		return { service, content: result.content, command: result.command, source: "host" };
	}
	const latestStatus = readLatestServiceStatus(service);
	if (latestStatus) {
		updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
	}
	const refreshed = getService(db, service.id) ?? service;
	return {
		service: refreshed,
		content: tailFileLines(refreshed.logFile, lines),
		command: `tail -n ${lines} ${refreshed.logFile}`,
		source: "log",
	};
}

export async function stopServiceById(id: string, force: boolean, reason?: string): Promise<{
	service: ServiceSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
}> {
	const db = getMeepoDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const host = getProcessHost();
	const target = service.host;
	const targetExists = target ? await host.targetExists(target) : false;
	if (!targetExists) {
		const latestStatus = readLatestServiceStatus(service);
		if (latestStatus) {
			updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: !force,
					command: "(host target already exited)",
					reason: "host target was already gone; registry refreshed from latest-status.json.",
				},
			};
		}
		if (force) {
			updateService(db, service.id, {
				state: "stopped",
				updatedAt: Date.now(),
				finishedAt: Date.now(),
				lastError: null,
			});
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: false,
					command: "(host target already missing)",
					reason: reason?.trim() || "host target was already gone; registry marked stopped.",
				},
			};
		}
		throw new Error(`Service ${service.id} no longer has a live host target. Use force=true or reconcile.`);
	}
	const result = await host.stop(target!, { force });
	if (force) {
		updateService(db, service.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: null,
		});
	}
	return { service: getService(db, service.id) ?? service, result };
}

export async function reconcileServices(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session"; activeOnly?: boolean; limit?: number }): Promise<{
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
}> {
	const scope = params.scope ?? "current_project";
	const filters = resolveServiceFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getMeepoDb();
	const services = listServices(db, filters);
	const host = getProcessHost();
	const inventory = await host.listInventory();
	const changed: Array<{ id: string; state: string; reason: string }> = [];
	for (const service of services) {
		const latestStatus = readLatestServiceStatus(service);
		const targetExists = service.host ? await host.targetExists(service.host, inventory) : false;
		let patch: UpdateServiceInput = {};
		let reason = "";
		const readyMatchedAt = maybeDetectServiceReady(service);
		if (readyMatchedAt) {
			patch = { ...patch, readyMatchedAt };
			reason = reason || "ready substring observed in service output";
		}
		if (latestStatus && latestStatus.updatedAt > service.updatedAt) {
			patch = {
				...patch,
				...buildServicePatchFromStatus(service, latestStatus),
			};
			reason = reason || "latest-status.json was newer than the registry";
		}
		if (!targetExists) {
			if (latestStatus && ["stopped", "error"].includes(latestStatus.state)) {
				patch = {
					...patch,
					...buildServicePatchFromStatus(service, latestStatus),
				};
				reason = reason || "host target exited after terminal latest-status update";
			} else if (["launching", "running"].includes(service.state)) {
				patch = {
					...patch,
					state: "lost",
					updatedAt: Date.now(),
					lastError: service.lastError ?? "host target missing during reconcile",
				};
				reason = reason || "host target missing during reconcile";
			}
		} else if (service.state === "launching" && !latestStatus) {
			patch = {
				...patch,
				state: "running",
				updatedAt: Date.now(),
			};
			reason = reason || "host target exists and the service appears to be running";
		}
		if (Object.keys(patch).length > 0) {
			updateService(db, service.id, patch);
			changed.push({ id: service.id, state: patch.state ?? service.state, reason: reason || "service metadata refreshed" });
		}
	}
	return { scope, reconciled: services.length, changed };
}


