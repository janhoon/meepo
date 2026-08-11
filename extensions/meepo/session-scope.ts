/**
 * Session-scoped filter helpers shared by coordinator modules.
 * Kept free of task-interaction / lifecycle imports to avoid cycles.
 */
import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getChildRuntimeEnvironment } from "./child-runtime.js";
import { getMeepoDb } from "./db.js";
import {
	LEGACY_SESSION_CHILD_LINK_ENTRY_TYPE,
	SESSION_CHILD_LINK_ENTRY_TYPE,
} from "./paths.js";
import { getProjectKey } from "./project.js";
import {
	createRootActorContext,
	listAgents,
	listDescendantAgentIds,
	listHierarchyVisibleAgentIds,
	resolveAgentActorContext,
} from "./registry.js";
import { OPEN_ATTENTION_STATES } from "./registry-shared.js";
import type {
	AgentActorContext,
	ListAgentsFilters,
	SessionChildLinkEntryData,
} from "./types.js";
import type { ListTasksFilters, TaskRecord, TaskState, TaskWaitingOn } from "./task-types.js";

export const childRuntimeEnvironment = getChildRuntimeEnvironment();

export function resolveInputPath(baseDir: string, rawPath: string | undefined): string {
	const normalized = (rawPath ?? baseDir).replace(/^@/, "");
	return resolve(baseDir, normalized);
}

export function assertDirectory(path: string): void {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		throw new Error(`Working directory does not exist: ${path}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Working directory is not a directory: ${path}`);
	}
}

export function sortTasksForList(
	tasks: TaskRecord[],
	sort: "priority" | "updated" | "created" | "title" | "status",
): TaskRecord[] {
	return [...tasks].sort((left, right) => {
		switch (sort) {
			case "updated":
				return right.updatedAt - left.updatedAt;
			case "created":
				return right.createdAt - left.createdAt;
			case "title":
				return left.title.localeCompare(right.title) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "status":
				return left.status.localeCompare(right.status) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "priority":
			default:
				return left.priority - right.priority || right.updatedAt - left.updatedAt;
		}
	});
}

export function getLinkedChildIds(ctx: ExtensionContext): string[] {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries() as Array<{
		type?: string;
		customType?: string;
		data?: SessionChildLinkEntryData | undefined;
	}>) {
		if (
			entry.type !== "custom" ||
			(entry.customType !== SESSION_CHILD_LINK_ENTRY_TYPE &&
				entry.customType !== LEGACY_SESSION_CHILD_LINK_ENTRY_TYPE)
		) {
			continue;
		}
		const childId = entry.data?.childId;
		if (typeof childId === "string" && childId.length > 0) {
			ids.add(childId);
		}
	}
	return [...ids];
}

export function resolveToolActorContext(ctx: ExtensionContext): AgentActorContext {
	const db = getMeepoDb();
	if (childRuntimeEnvironment) {
		return resolveAgentActorContext(db, { currentAgentId: childRuntimeEnvironment.childId });
	}
	return createRootActorContext({
		projectKey: getProjectKey(ctx.cwd),
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

export function applyHierarchyVisibilityToAgentFilters(
	ctx: ExtensionContext,
	filters: ListAgentsFilters,
): ListAgentsFilters {
	if (!childRuntimeEnvironment) return filters;
	const db = getMeepoDb();
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return filters;
	let requestedIds: string[] | undefined = filters.ids;
	if (filters.descendantOf) {
		requestedIds = listDescendantAgentIds(db, filters.descendantOf);
	}
	const visibleIds = listHierarchyVisibleAgentIds(db, actor, {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
	});
	const visibleSet = new Set(visibleIds);
	const ids = requestedIds ? requestedIds.filter((id) => visibleSet.has(id)) : visibleIds;
	return { ...filters, ids, descendantOf: undefined };
}

export function getVisibleAgentIdsForTool(ctx: ExtensionContext, requestedIds?: string[]): string[] | null {
	if (!childRuntimeEnvironment) return requestedIds ?? null;
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return requestedIds ?? null;
	const visibleIds = listHierarchyVisibleAgentIds(getMeepoDb(), actor, { projectKey: getProjectKey(ctx.cwd) });
	if (!requestedIds) return visibleIds;
	const visibleSet = new Set(visibleIds);
	return requestedIds.filter((id) => visibleSet.has(id));
}

export function resolveAttentionFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { audience?: "all" | "coordinator" | "user"; includeResolved?: boolean; limit?: number },
) {
	const filters: import("./types.js").ListAttentionItemsFilters = {
		limit: params.limit,
		states: params.includeResolved ? undefined : OPEN_ATTENTION_STATES,
	};
	if (params.audience === "coordinator") filters.audiences = ["coordinator"];
	if (params.audience === "user") filters.audiences = ["user"];
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants":
			filters.agentIds = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export function resolveAgentFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { activeOnly?: boolean; blockedOnly?: boolean; unreadOnly?: boolean; limit?: number },
): ListAgentsFilters {
	const filters: ListAgentsFilters = {
		activeOnly: params.activeOnly,
		blockedOnly: params.blockedOnly,
		unreadOnly: params.unreadOnly,
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
		case "descendants":
			filters.descendantOf = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export function resolveTaskFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: {
		statuses?: TaskState[];
		waitingOn?: TaskWaitingOn[];
		recommendedProfile?: string;
		includeDone?: boolean;
		limit?: number;
		linkedAgentId?: string;
	},
): ListTasksFilters {
	const filters: ListTasksFilters = {
		statuses: params.statuses,
		waitingOn: params.waitingOn,
		recommendedProfile: params.recommendedProfile,
		includeDone: params.includeDone,
		limit: params.limit,
		linkedAgentId: params.linkedAgentId,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants": {
			const ids = getLinkedChildIds(ctx);
			if (ids.length === 0) {
				filters.ids = [];
				break;
			}
			const db = getMeepoDb();
			const taskIds = Array.from(
				new Set(
					listAgents(db, { ids, limit: 500 })
						.map((agent) => agent.taskId)
						.filter((value): value is string => Boolean(value)),
				),
			);
			filters.ids = taskIds;
			break;
		}
		case "all":
		default:
			break;
	}
	return filters;
}
