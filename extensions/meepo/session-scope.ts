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
import { listOpenAttention, type ListOpenAttentionFilters } from "./inbox.js";
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
	AgentRecipientKind,
	AgentSummary,
	AttentionItemRecord,
	ListAgentsFilters,
	SessionChildLinkEntryData,
} from "./types.js";
import type { ListTasksFilters, TaskRecord, TaskState, TaskWaitingOn } from "./task-types.js";
import type { DatabaseSync } from "./sqlite.js";

export const childRuntimeEnvironment = getChildRuntimeEnvironment();

/** Tool/wake scopes that may pin parent-owned subjects. */
export type OwnershipScope = "all" | "current_project" | "current_session" | "descendants";

/**
 * Owner kinds visible on root-coordinator surfaces (wake, board, default attention).
 * Agent-owned items stay 1:1 with the parent agent via bridge/inbox — never root broadcast.
 */
export const ROOT_SURFACE_OWNER_KINDS = ["root", "user"] as const;

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

export interface ComputeParentOwnedAgentIdsInput {
	actor: AgentActorContext;
	projectKey: string;
	/** Root session identity; ignored for agent actors. */
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	/** Explicit session→child links from the coordinator session journal. */
	linkedChildIds?: string[];
}

/**
 * Pure ownership core (DB + values only). Prefer this in unit tests.
 * Root: spawn-session agents ∪ linked children ∪ their descendants.
 * Agent: descendant subtree only (1:1 parent routing).
 */
export function computeParentOwnedAgentIds(db: DatabaseSync, input: ComputeParentOwnedAgentIdsInput): string[] {
	if (input.actor.kind === "agent") {
		return listDescendantAgentIds(db, [input.actor.agentId]);
	}

	const sessionOwned = listHierarchyVisibleAgentIds(db, input.actor, {
		projectKey: input.projectKey,
		spawnSessionId: input.spawnSessionId ?? undefined,
		spawnSessionFile: input.spawnSessionFile ?? undefined,
	});
	const linked = input.linkedChildIds ?? [];
	const roots = [...new Set([...sessionOwned, ...linked])];
	if (roots.length === 0) return [];
	const descendants = listDescendantAgentIds(db, roots);
	return [...new Set([...roots, ...descendants])];
}

/**
 * Agent ids this parent is allowed to receive subagent messages from.
 * Thin ctx wrapper around {@link computeParentOwnedAgentIds}.
 */
export function getParentOwnedAgentIds(ctx: ExtensionContext, options: { projectKey?: string } = {}): string[] {
	return computeParentOwnedAgentIds(getMeepoDb(), {
		actor: resolveToolActorContext(ctx),
		projectKey: options.projectKey ?? getProjectKey(ctx.cwd),
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
		linkedChildIds: getLinkedChildIds(ctx),
	});
}

export interface ResolveOwnedSubjectIdsParts {
	/** Result of {@link computeParentOwnedAgentIds} / getParentOwnedAgentIds. */
	parentOwnedIds: string[];
	linkedChildIds: string[];
	listDescendants: (parentIds: string[]) => string[];
}

/**
 * Pure scope→owned-ids policy (no ctx/DB). Used by {@link resolveOwnedSubjectIds} and unit tests.
 * - `all` → `null` (no pin; explicit fleet-wide escape hatch)
 * - `current_project` / `current_session` → parentOwnedIds (**same id set**)
 * - `descendants` → linkedChildIds ∪ their descendants
 * Empty array means "owned nobody" (never fall open to project-wide).
 *
 * ## `current_project` ≡ `current_session` on parent-owned agent surfaces
 *
 * Under root-coordinator agent/attention/inbox pins, both labels intentionally resolve to the
 * same owned subject id set (session-spawned ∪ linked children ∪ their descendants).
 * Keep both API labels for operator continuity; do **not** hand-roll two parallel id lists that
 * pretend to differ. The only material difference is {@link withOwnedSubjectPin}: `current_project`
 * also sets `projectKey`, while `current_session` does not. Task filters remain ambient
 * (projectKey vs spawn-session columns) and are **not** on this ownership pin.
 */
export function resolveOwnedSubjectIdsFromParts(scope: OwnershipScope, parts: ResolveOwnedSubjectIdsParts): string[] | null {
	if (scope === "all") return null;
	if (scope === "descendants") {
		if (parts.linkedChildIds.length === 0) return [];
		return [...new Set([...parts.linkedChildIds, ...parts.listDescendants(parts.linkedChildIds)])];
	}
	// current_project ≡ current_session owned subject ids (see doc above).
	return parts.parentOwnedIds;
}

/**
 * Single ownership seam for wake, inbox, attention, board, list, dashboard, and reconcile.
 * Thin ctx wrapper around {@link resolveOwnedSubjectIdsFromParts}.
 *
 * `current_project` and `current_session` share the same parent-owned agent id set — see
 * {@link resolveOwnedSubjectIdsFromParts}. Prefer {@link resolveAgentFilters} /
 * {@link resolveOpenAttentionFilters} / {@link resolveRootInboxSenderIds} at call sites instead of
 * composing this helper ad hoc.
 */
export function resolveOwnedSubjectIds(
	ctx: ExtensionContext,
	scope: OwnershipScope,
	options: { projectKey?: string } = {},
): string[] | null {
	const projectKey = options.projectKey ?? getProjectKey(ctx.cwd);
	const linkedChildIds = getLinkedChildIds(ctx);
	return resolveOwnedSubjectIdsFromParts(scope, {
		parentOwnedIds: getParentOwnedAgentIds(ctx, { projectKey }),
		linkedChildIds,
		listDescendants: (parentIds) => listDescendantAgentIds(getMeepoDb(), parentIds),
	});
}

/**
 * Root-coordinator inbox sender allow-list via the single ownership seam.
 * - `scope=all` → `undefined` (no sender pin / fleet-wide)
 * - empty owned set → `[]` (fail-closed: no mail)
 * - otherwise → owned subject ids
 *
 * Use only for root actor inboxes. Agent actors already pin by recipient identity; do not
 * parallel-compose {@link resolveOwnedSubjectIds} in tools.
 */
export function resolveRootInboxSenderIds(
	ctx: ExtensionContext,
	scope: OwnershipScope,
	options: { projectKey?: string } = {},
): string[] | undefined {
	const owned = resolveOwnedSubjectIds(ctx, scope, options);
	return owned === null ? undefined : owned;
}

/**
 * Apply the ownership pin to a filter bag used by agent list / attention queries.
 * When `owned` is non-null it is authoritative — callers must not also AND spawn-session
 * filters (linked children and their descendants often carry different spawn sessions).
 * `current_project` additionally pins projectKey; `current_session` uses the same owned ids
 * without forcing projectKey (labels differ; subject pin does not).
 */
export function withOwnedSubjectPin<
	T extends { projectKey?: string; ids?: string[]; agentIds?: string[]; subjectAgentIds?: string[]; childIds?: string[] },
>(
	filters: T,
	scope: OwnershipScope,
	owned: string[] | null,
	options: { projectKey: string; idField: "ids" | "agentIds" | "subjectAgentIds" | "childIds" },
): T {
	const next = { ...filters };
	if (owned !== null) {
		(next as { ids?: string[]; agentIds?: string[]; subjectAgentIds?: string[]; childIds?: string[] })[options.idField] = owned;
	}
	if (scope === "current_project") {
		next.projectKey = options.projectKey;
	}
	return next;
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

export function attentionOwnerKindsForAudience(audience?: "all" | "coordinator" | "user"): AgentRecipientKind[] | undefined {
	if (audience === "user") return ["user"];
	if (audience === "coordinator") return ["root"];
	if (audience === undefined) return [...ROOT_SURFACE_OWNER_KINDS];
	return undefined;
}

export function resolveOpenAttentionFilters(
	ctx: ExtensionContext,
	scope: OwnershipScope,
	params: {
		audience?: "all" | "coordinator" | "user";
		includeResolved?: boolean;
		limit?: number;
		states?: import("./types.js").ListAttentionItemsFilters["states"];
	} = {},
): ListOpenAttentionFilters {
	const projectKey = getProjectKey(ctx.cwd);
	const filters: ListOpenAttentionFilters = {
		limit: params.limit,
		ownerKinds: attentionOwnerKindsForAudience(params.audience),
		states:
			params.states !== undefined
				? params.states
				: params.includeResolved
					? undefined
					: OPEN_ATTENTION_STATES,
	};
	return withOwnedSubjectPin(filters, scope, resolveOwnedSubjectIds(ctx, scope, { projectKey }), {
		projectKey,
		idField: "childIds",
	});
}

export function resolveAgentFilters(
	ctx: ExtensionContext,
	scope: OwnershipScope,
	params: { activeOnly?: boolean; blockedOnly?: boolean; unreadOnly?: boolean; limit?: number },
): ListAgentsFilters {
	const projectKey = getProjectKey(ctx.cwd);
	const filters: ListAgentsFilters = {
		activeOnly: params.activeOnly,
		blockedOnly: params.blockedOnly,
		unreadOnly: params.unreadOnly,
		limit: params.limit,
	};
	// Same ownership seam as board/inbox/attention — ids pin, no parallel spawn-session path.
	return withOwnedSubjectPin(filters, scope, resolveOwnedSubjectIds(ctx, scope, { projectKey }), {
		projectKey,
		idField: "ids",
	});
}

/**
 * Shared attention-gate snapshot for spawn surfaces (tool + wizard).
 * Both items and agents go through the ownership seam — never project-wide listAgents.
 * Default scope is current_project; current_session shares the same owned id set.
 */
export function loadAttentionGate(
	ctx: ExtensionContext,
	scope: OwnershipScope = "current_project",
	params: { itemLimit?: number; agentLimit?: number } = {},
): { items: AttentionItemRecord[]; agents: Map<string, AgentSummary> } {
	const db = getMeepoDb();
	const items = listOpenAttention(db, resolveOpenAttentionFilters(ctx, scope, { limit: params.itemLimit ?? 5 }));
	// Fail-closed owned pin (same scope as items) — never ambient projectKey-only listAgents.
	const agents = new Map(
		listAgents(db, resolveAgentFilters(ctx, scope, { limit: params.agentLimit ?? 100 })).map((agent) => [
			agent.id,
			agent,
		]),
	);
	return { items, agents };
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
