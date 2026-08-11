/**
 * hierarchy-org
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
import { getAgent, updateAgent } from "./agent-store.js";
import { getAgentOrg, getAgentRole, getAgentScopeRow } from "./hierarchy-actors.js";

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

export function upsertAgentOrg(db: DatabaseSync, input: UpsertAgentOrgInput): AgentOrgRecord {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT INTO agent_orgs (id, project_key, root_agent_id, title, state, metadata_json, created_at, updated_at, archived_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			project_key = excluded.project_key,
			root_agent_id = excluded.root_agent_id,
			title = excluded.title,
			state = excluded.state,
			metadata_json = excluded.metadata_json,
			updated_at = excluded.updated_at,
			archived_at = excluded.archived_at`,
	).run(
		input.id,
		input.projectKey,
		input.rootAgentId ?? null,
		input.title,
		input.state ?? "active",
		input.metadata === undefined ? null : JSON.stringify(input.metadata),
		createdAt,
		updatedAt,
		input.archivedAt ?? null,
	);
	const org = getAgentOrg(db, input.id);
	if (!org) throw new Error(`Failed to upsert agent org "${input.id}".`);
	return org;
}

export function ensureAgentHierarchySelfClosure(db: DatabaseSync, orgId: string, agentId: string, createdAt = Date.now()): void {
	db.prepare(
		`INSERT OR IGNORE INTO agent_hierarchy_closure
			(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
		 VALUES (?, ?, ?, 0, NULL, ?)`,
	).run(orgId, agentId, agentId, createdAt);
}

export function wouldCreateHierarchyCycle(
	db: DatabaseSync,
	input: { orgId: string; parentAgentId: string; childAgentId: string },
): boolean {
	if (input.parentAgentId === input.childAgentId) return true;
	const row = db
		.prepare(
			`SELECT 1 AS found
			 FROM agent_hierarchy_closure
			 WHERE org_id = ?
				AND ancestor_agent_id = ?
				AND descendant_agent_id = ?
			 LIMIT 1`,
		)
		.get(input.orgId, input.childAgentId, input.parentAgentId) as { found: number } | undefined;
	if (row) return true;
	const recursiveRow = db
		.prepare(
			`WITH RECURSIVE descendants(agent_id, path) AS (
				SELECT
					edges.child_agent_id,
					'|' || edges.child_agent_id || '|'
				FROM agent_edges edges
				WHERE edges.org_id = ?
					AND edges.parent_agent_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
				UNION ALL
				SELECT
					edges.child_agent_id,
					descendants.path || edges.child_agent_id || '|'
				FROM agent_edges edges
				JOIN descendants ON descendants.agent_id = edges.parent_agent_id
				WHERE edges.org_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
					AND instr(descendants.path, '|' || edges.child_agent_id || '|') = 0
			)
			SELECT 1 AS found
			FROM descendants
			WHERE agent_id = ?
			LIMIT 1`,
		)
		.get(input.orgId, input.childAgentId, input.orgId, input.parentAgentId) as { found: number } | undefined;
	return !!recursiveRow;
}

export function getRolePolicyIdForAgents(db: DatabaseSync, parentAgentId: string, childAgentId: string, edgeType: AgentEdgeType): string | null {
	const row = db
		.prepare(
			`SELECT p.id
			 FROM agents parent
			 JOIN agents child ON child.id = ?
			 JOIN agent_role_edge_policies p
				ON p.parent_role_key = parent.role_key
				AND p.child_role_key = child.role_key
				AND p.edge_type = ?
			 WHERE parent.id = ?
			 LIMIT 1`,
		)
		.get(childAgentId, edgeType, parentAgentId) as { id: string } | undefined;
	return row?.id ?? null;
}

export function isRolePolicyIdAllowedForAgents(db: DatabaseSync, rolePolicyId: string, parentAgentId: string, childAgentId: string, edgeType: AgentEdgeType): boolean {
	const row = db
		.prepare(
			`SELECT 1 AS found
			 FROM agents parent
			 JOIN agents child ON child.id = ?
			 JOIN agent_role_edge_policies p
				ON p.id = ?
				AND p.parent_role_key = parent.role_key
				AND p.child_role_key = child.role_key
				AND p.edge_type = ?
			 WHERE parent.id = ?
			 LIMIT 1`,
		)
		.get(childAgentId, rolePolicyId, edgeType, parentAgentId) as { found: number } | undefined;
	return !!row;
}

export function getAgentEdgeById(db: DatabaseSync, edgeId: string): AgentEdgeRecord | null {
	const row = db.prepare("SELECT * FROM agent_edges WHERE id = ?").get(edgeId) as Record<string, unknown> | undefined;
	return row ? toAgentEdgeRecord(row) : null;
}

export function insertClosureRowsForEdge(db: DatabaseSync, edge: AgentEdgeRecord, createdAt: number): void {
	if (edge.edgeType !== "reports_to" || edge.state !== "active") return;
	ensureAgentHierarchySelfClosure(db, edge.orgId, edge.parentAgentId, createdAt);
	ensureAgentHierarchySelfClosure(db, edge.orgId, edge.childAgentId, createdAt);
	db.prepare(
		`INSERT INTO agent_hierarchy_closure
			(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
		 SELECT
			?,
			ancestors.ancestor_agent_id,
			descendants.descendant_agent_id,
			ancestors.depth + descendants.depth + 1,
			?,
			?
		 FROM agent_hierarchy_closure ancestors
		 CROSS JOIN agent_hierarchy_closure descendants
		 WHERE ancestors.org_id = ?
			AND descendants.org_id = ?
			AND ancestors.descendant_agent_id = ?
			AND descendants.ancestor_agent_id = ?
		 ON CONFLICT(org_id, ancestor_agent_id, descendant_agent_id) DO UPDATE SET
			depth = CASE
				WHEN excluded.depth < agent_hierarchy_closure.depth THEN excluded.depth
				ELSE agent_hierarchy_closure.depth
			END,
			through_edge_id = CASE
				WHEN excluded.depth <= agent_hierarchy_closure.depth THEN excluded.through_edge_id
				ELSE agent_hierarchy_closure.through_edge_id
			END`,
	).run(edge.orgId, edge.id, createdAt, edge.orgId, edge.orgId, edge.parentAgentId, edge.childAgentId);
}

export function createAgentHierarchyEdge(db: DatabaseSync, input: CreateAgentHierarchyEdgeInput): AgentEdgeRecord {
	const edgeType = input.edgeType ?? "reports_to";
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	return runImmediateTransaction(db, () => {
		const parent = getAgentScopeRow(db, input.parentAgentId);
		const child = getAgentScopeRow(db, input.childAgentId);
		if (!parent) throw new Error(`Unknown parent agent id "${input.parentAgentId}".`);
		if (!child) throw new Error(`Unknown child agent id "${input.childAgentId}".`);
		const orgId = input.orgId ?? parent.orgId ?? child.orgId;
		if (!orgId) throw new Error("createAgentHierarchyEdge requires orgId when neither agent is attached to an org.");
		if (parent.orgId && parent.orgId !== orgId) throw new Error(`Parent agent "${parent.id}" belongs to org "${parent.orgId}", not "${orgId}".`);
		if (child.orgId && child.orgId !== orgId) throw new Error(`Child agent "${child.id}" belongs to org "${child.orgId}", not "${orgId}".`);
		if (edgeType === "reports_to" && wouldCreateHierarchyCycle(db, { orgId, parentAgentId: parent.id, childAgentId: child.id })) {
			throw new Error(`Refusing to create ${edgeType} edge ${parent.id} -> ${child.id} because it would create a hierarchy cycle.`);
		}
		if (!parent.orgId) updateAgent(db, parent.id, { orgId, updatedAt });
		if (!child.orgId) updateAgent(db, child.id, { orgId, updatedAt });
		const edgeId = input.id ?? `edge:${edgeType}:${parent.id}:${child.id}`;
		const rolePolicyId = input.rolePolicyId === undefined ? getRolePolicyIdForAgents(db, parent.id, child.id, edgeType) : input.rolePolicyId;
		if (rolePolicyId && !isRolePolicyIdAllowedForAgents(db, rolePolicyId, parent.id, child.id, edgeType)) {
			throw new Error(`Refusing to create active ${edgeType} edge ${parent.id} -> ${child.id} with mismatched role policy "${rolePolicyId}".`);
		}
		if (!rolePolicyId && !input.allowPolicyless) {
			throw new Error(
				`Refusing to create active ${edgeType} edge ${parent.id} -> ${child.id} without an agent_role_edge_policies row; pass allowPolicyless for an explicit audited override.`,
			);
		}
		const reason = input.reason ?? (!rolePolicyId ? "Policyless active edge created by explicit registry override." : null);
		db.prepare(
			`INSERT INTO agent_edges (
				id, org_id, parent_agent_id, child_agent_id, edge_type, role_policy_id, task_id, state,
				created_by_agent_id, created_by_kind, reason, metadata_json, created_at, updated_at, ended_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, NULL)`,
		).run(
			edgeId,
			orgId,
			parent.id,
			child.id,
			edgeType,
			rolePolicyId,
			input.taskId ?? null,
			input.createdByAgentId ?? null,
			input.createdByKind ?? "system",
			reason,
			input.metadata === undefined ? null : JSON.stringify(input.metadata),
			createdAt,
			updatedAt,
		);
		if (edgeType === "reports_to") {
			updateAgent(db, child.id, {
				parentAgentId: parent.id,
				orgId,
				spawnedByAgentId: input.createdByAgentId ?? parent.id,
				hierarchyState: "attached",
				updatedAt,
			});
		}
		const edge = getAgentEdgeById(db, edgeId);
		if (!edge) throw new Error(`Failed to create agent edge "${edgeId}".`);
		insertClosureRowsForEdge(db, edge, createdAt);
		return edge;
	});
}

export function rebuildAgentHierarchyClosure(db: DatabaseSync, orgId: string, createdAt = Date.now()): number {
	return runImmediateTransaction(db, () => {
		db.prepare("DELETE FROM agent_hierarchy_closure WHERE org_id = ?").run(orgId);
		db.prepare(
			`INSERT OR IGNORE INTO agent_hierarchy_closure
				(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
			 SELECT org_id, id, id, 0, NULL, ?
			 FROM agents
			 WHERE org_id = ?`,
		).run(createdAt, orgId);
		db.prepare(
			`WITH RECURSIVE hierarchy_paths(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, path) AS (
				SELECT
					edges.org_id,
					edges.parent_agent_id,
					edges.child_agent_id,
					1,
					edges.id,
					'|' || edges.parent_agent_id || '|' || edges.child_agent_id || '|'
				FROM agent_edges edges
				WHERE edges.org_id = ?
					AND edges.state = 'active'
					AND edges.edge_type = 'reports_to'
				UNION ALL
				SELECT
					hierarchy_paths.org_id,
					hierarchy_paths.ancestor_agent_id,
					edges.child_agent_id,
					hierarchy_paths.depth + 1,
					edges.id,
					hierarchy_paths.path || edges.child_agent_id || '|'
				FROM hierarchy_paths
				JOIN agent_edges edges
					ON edges.org_id = hierarchy_paths.org_id
					AND edges.parent_agent_id = hierarchy_paths.descendant_agent_id
				WHERE edges.state = 'active'
					AND edges.edge_type = 'reports_to'
					AND instr(hierarchy_paths.path, '|' || edges.child_agent_id || '|') = 0
			)
			INSERT OR IGNORE INTO agent_hierarchy_closure
				(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
			SELECT
				org_id,
				ancestor_agent_id,
				descendant_agent_id,
				MIN(depth),
				MIN(through_edge_id),
				?
			FROM hierarchy_paths
			GROUP BY org_id, ancestor_agent_id, descendant_agent_id`,
		).run(orgId, createdAt);
		const row = db
			.prepare("SELECT COUNT(*) AS count FROM agent_hierarchy_closure WHERE org_id = ?")
			.get(orgId) as { count: number } | undefined;
		return Number(row?.count ?? 0);
	});
}
