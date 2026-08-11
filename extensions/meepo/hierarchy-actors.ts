/**
 * hierarchy-actors
 */
/**
 * Hierarchy, routing permissions, and v2 multi-recipient message creation.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { makePlaceholders, runImmediateTransaction, safeJsonParse, toBoolean } from "./sql-util.js";
import {
	toAgentAccessGrantRecord,
	toAgentActiveEdgeRecord,
	toAgentEdgeRecord,
	toAgentMessageRecipientRecord,
	toAgentMessageRouteRecord,
	toAgentMessageV2Record,
	toAgentOrgRecord,
	toAgentRoleRecord,
	toAgentThreadRecord,
} from "./registry-shared.js";
import type {
	CanSendMessageInput,
	CreateAgentHierarchyEdgeInput,
	CreateAgentMessageRouteInput,
	CreateAgentMessageWithRecipientsInput,
	CreateAgentMessageWithRecipientsResult,
	CreateAgentMessageRecipientV2Input,
	FetchAgentInboxV2Input,
	GetActiveAgentAccessGrantInput,
	GetActiveAgentEdgeInput,
	ListActiveAgentEdgesInput,
	ListHierarchyVisibleAgentIdsOptions,
	ResolveAgentActorContextInput,
	UpsertAgentOrgInput,
	AgentMessageRecipientUnreadSummaryFilters,
} from "./registry-types.js";
import type {
	AgentAccessGrantRecord,
	AgentActiveEdgeRecord,
	AgentActorContext,
	AgentEdgeRecord,
	AgentEdgeType,
	AgentInboxMessageV2Record,
	AgentMessageRecipientRecord,
	AgentMessageRecipientStatus,
	AgentMessageRouteRecord,
	AgentMessageV2Record,
	AgentOrgRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentRoleRecord,
	AgentThreadRecord,
	AgentUnreadSummaryRecord,
	CanSendMessageDecision,
} from "./types.js";

export type {
	ResolveAgentActorContextInput,
	ListHierarchyVisibleAgentIdsOptions,
	GetActiveAgentEdgeInput,
	ListActiveAgentEdgesInput,
	GetActiveAgentAccessGrantInput,
	CanSendMessageInput,
	CreateAgentMessageRouteInput,
	CreateAgentMessageWithRecipientsInput,
	CreateAgentMessageWithRecipientsResult,
	UpsertAgentOrgInput,
	CreateAgentHierarchyEdgeInput,
} from "./registry-types.js";

export class AgentMessagePermissionError extends Error {
	messageId: string;
	decisions: CanSendMessageDecision[];

	constructor(messageId: string, decisions: CanSendMessageDecision[]) {
		super(`Message ${messageId} denied for ${decisions.length} recipient${decisions.length === 1 ? "" : "s"}.`);
		this.name = "AgentMessagePermissionError";
		this.messageId = messageId;
		this.decisions = decisions;
	}
}

export function normalizeRecipient(recipient: AgentRecipientRef): { kind: AgentRecipientKind; agentId: string | null } {
	return {
		kind: recipient.kind,
		agentId: recipient.kind === "agent" ? recipient.agentId : null,
	};
}

export function getAgentScopeRow(
	db: DatabaseSync,
	agentId: string,
): { id: string; orgId: string | null; projectKey: string; roleKey: string | null; spawnSessionId: string | null; spawnSessionFile: string | null } | null {
	const row = db
		.prepare(
			`SELECT id, org_id, project_key, role_key, spawn_session_id, spawn_session_file
			 FROM agents
			 WHERE id = ?`,
		)
		.get(agentId) as
		| {
				id: string;
				org_id: string | null;
				project_key: string;
				role_key: string | null;
				spawn_session_id: string | null;
				spawn_session_file: string | null;
		  }
		| undefined;
	if (!row) return null;
	return {
		id: row.id,
		orgId: row.org_id ?? null,
		projectKey: row.project_key,
		roleKey: row.role_key ?? null,
		spawnSessionId: row.spawn_session_id ?? null,
		spawnSessionFile: row.spawn_session_file ?? null,
	};
}

export function runImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = callback();
		db.exec("COMMIT;");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Ignore rollback errors so the original error is preserved.
		}
		throw error;
	}
}

export function createRootActorContext(scope: Omit<ResolveAgentActorContextInput, "currentAgentId" | "root"> = {}): AgentActorContext {
	return {
		kind: "root",
		agentId: null,
		projectKey: scope.projectKey ?? null,
		spawnSessionId: scope.spawnSessionId ?? null,
		spawnSessionFile: scope.spawnSessionFile ?? null,
		defaultVisibilityScope: "root",
		canAdminOverride: true,
	};
}

export function getAgentRole(db: DatabaseSync, roleKey: string): AgentRoleRecord | null {
	const row = db.prepare("SELECT * FROM agent_roles WHERE role_key = ?").get(roleKey) as Record<string, unknown> | undefined;
	return row ? toAgentRoleRecord(row) : null;
}

export function getAgentOrg(db: DatabaseSync, orgId: string): AgentOrgRecord | null {
	const row = db.prepare("SELECT * FROM agent_orgs WHERE id = ?").get(orgId) as Record<string, unknown> | undefined;
	return row ? toAgentOrgRecord(row) : null;
}

export function getAgentActorContext(db: DatabaseSync, agentId: string): AgentActorContext | null {
	const row = db
		.prepare(
			`SELECT
				a.id,
				a.org_id,
				a.role_key,
				a.project_key,
				a.spawn_session_id,
				a.spawn_session_file,
				r.default_visibility_scope,
				r.can_spawn_children,
				r.can_admin_override
			 FROM agents a
			 LEFT JOIN agent_roles r ON r.role_key = a.role_key
			 WHERE a.id = ?`,
		)
		.get(agentId) as Record<string, unknown> | undefined;
	if (!row) return null;
	return {
		kind: "agent",
		agentId: row.id as string,
		orgId: (row.org_id as string | null) ?? null,
		roleKey: (row.role_key as string | null) ?? null,
		projectKey: row.project_key as string,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		defaultVisibilityScope: (row.default_visibility_scope as AgentActorContext["defaultVisibilityScope"] | null) ?? null,
		canSpawnChildren: toBoolean(row.can_spawn_children),
		canAdminOverride: toBoolean(row.can_admin_override),
	};
}

export function resolveAgentActorContext(db: DatabaseSync, input: ResolveAgentActorContextInput = {}): AgentActorContext {
	if (input.currentAgentId) {
		const actor = getAgentActorContext(db, input.currentAgentId);
		if (!actor) throw new Error(`Unknown current agent id "${input.currentAgentId}".`);
		return actor;
	}
	return createRootActorContext(input);
}

export function addIdsFromRows(ids: Set<string>, rows: Array<{ id: string }>): void {
	for (const row of rows) ids.add(row.id);
}

export function filterAgentIdsByScope(db: DatabaseSync, ids: Set<string>, options: ListHierarchyVisibleAgentIdsOptions): string[] {
	if (ids.size === 0) return [];
	const idList = [...ids];
	const where = [`a.id IN (${makePlaceholders(idList.length)})`];
	const params: unknown[] = [...idList];
	if (options.projectKey) {
		where.push("a.project_key = ?");
		params.push(options.projectKey);
	}
	addSessionScopeFilter(where, params, options.spawnSessionId, options.spawnSessionFile, "a");
	if (!options.includeArchived) {
		where.push("COALESCE(a.hierarchy_state, 'attached') <> 'archived'");
	}
	const rows = db
		.prepare(
			`SELECT a.id
			 FROM agents a
			 WHERE ${where.join(" AND ")}
			 ORDER BY a.updated_at DESC, a.id ASC`,
		)
		.all(...params) as Array<{ id: string }>;
	return rows.map((row) => row.id);
}

export function listHierarchyVisibleAgentIds(
	db: DatabaseSync,
	actor: AgentActorContext,
	options: ListHierarchyVisibleAgentIdsOptions = {},
): string[] {
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) {
		const where: string[] = [];
		const params: unknown[] = [];
		if (options.projectKey ?? actor.projectKey) {
			where.push("a.project_key = ?");
			params.push(options.projectKey ?? actor.projectKey);
		}
		addSessionScopeFilter(
			where,
			params,
			options.spawnSessionId ?? actor.spawnSessionId ?? undefined,
			options.spawnSessionFile ?? actor.spawnSessionFile ?? undefined,
			"a",
		);
		if (!options.includeArchived) {
			where.push("COALESCE(a.hierarchy_state, 'attached') <> 'archived'");
		}
		const whereClause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		const rows = db
			.prepare(
				`SELECT a.id
				 FROM agents a
				 ${whereClause}
				 ORDER BY a.updated_at DESC, a.id ASC`,
			)
			.all(...params) as Array<{ id: string }>;
		return rows.map((row) => row.id);
	}

	const ids = new Set<string>([actor.agentId]);
	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT e.parent_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.child_agent_id = ?
					AND e.state = 'active'
					AND p.allow_child_inspect_parent = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);
	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT e.child_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.parent_agent_id = ?
					AND e.state = 'active'
					AND p.allow_parent_inspect_child = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);

	if (actor.defaultVisibilityScope === "project") {
		addIdsFromRows(
			ids,
			db.prepare("SELECT id FROM agents WHERE project_key = ?").all(actor.projectKey) as Array<{ id: string }>,
		);
	} else if (actor.defaultVisibilityScope === "subtree" || actor.defaultVisibilityScope === "root") {
		addIdsFromRows(
			ids,
			db
				.prepare(
					`SELECT descendant_agent_id AS id
					 FROM agent_hierarchy_closure
					 WHERE ancestor_agent_id = ?
						AND (? IS NULL OR org_id = ?)`,
				)
				.all(actor.agentId, actor.orgId, actor.orgId) as Array<{ id: string }>,
		);
	}

	addIdsFromRows(
		ids,
		db
			.prepare(
				`SELECT c.descendant_agent_id AS id
				 FROM agent_edges e
				 JOIN agent_hierarchy_closure c
					ON c.org_id = e.org_id
					AND c.ancestor_agent_id = e.child_agent_id
				 JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
				 WHERE e.parent_agent_id = ?
					AND e.state = 'active'
					AND p.allow_parent_inspect_subtree = 1`,
			)
			.all(actor.agentId) as Array<{ id: string }>,
	);

	const now = Date.now();
	const grantRows = db
		.prepare(
			`SELECT *
			 FROM agent_access_grants
			 WHERE grantee_agent_id = ?
				AND state = 'active'
				AND grant_kind IN ('inspect_agent', 'inspect_subtree', 'inspect_task')
				AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.all(actor.agentId, now) as Array<Record<string, unknown>>;
	for (const row of grantRows) {
		const grant = toAgentAccessGrantRecord(row);
		if (grant.subjectAgentId && (grant.grantKind === "inspect_agent" || grant.grantKind === "inspect_subtree")) {
			ids.add(grant.subjectAgentId);
		}
		if (grant.subjectAgentId && grant.grantKind === "inspect_subtree") {
			addIdsFromRows(
				ids,
				db
					.prepare(
						`SELECT descendant_agent_id AS id
						 FROM agent_hierarchy_closure
						 WHERE org_id = ? AND ancestor_agent_id = ?`,
					)
					.all(grant.orgId, grant.subjectAgentId) as Array<{ id: string }>,
			);
		}
		if (grant.subjectTaskId) {
			addIdsFromRows(
				ids,
				db.prepare("SELECT id FROM agents WHERE task_id = ?").all(grant.subjectTaskId) as Array<{ id: string }>,
			);
		}
	}

	return filterAgentIdsByScope(db, ids, options);
}

