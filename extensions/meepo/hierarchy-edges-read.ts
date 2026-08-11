/**
 * hierarchy-edges-read
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

export function listActiveAgentEdges(db: DatabaseSync, input: ListActiveAgentEdgesInput = {}): AgentActiveEdgeRecord[] {
	const where: string[] = ["e.state = 'active'"];
	const params: unknown[] = [];
	if (input.parentAgentId) {
		where.push("e.parent_agent_id = ?");
		params.push(input.parentAgentId);
	}
	if (input.childAgentId) {
		where.push("e.child_agent_id = ?");
		params.push(input.childAgentId);
	}
	if (input.edgeType) {
		where.push("e.edge_type = ?");
		params.push(input.edgeType);
	}
	if (input.orgId) {
		where.push("e.org_id = ?");
		params.push(input.orgId);
	}
	const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
	params.push(limit);
	const rows = db
		.prepare(
			`SELECT
				e.*,
				p.allow_spawn,
				p.allow_parent_to_child_message,
				p.allow_child_to_parent_message,
				p.allow_parent_inspect_child,
				p.allow_child_inspect_parent,
				p.allow_parent_inspect_subtree
			 FROM agent_edges e
			 LEFT JOIN agent_role_edge_policies p ON p.id = e.role_policy_id
			 WHERE ${where.join(" AND ")}
			 ORDER BY CASE e.edge_type WHEN 'reports_to' THEN 0 ELSE 1 END, e.updated_at DESC
			 LIMIT ?`,
		)
		.all(...params) as Array<Record<string, unknown>>;
	return rows.map(toAgentActiveEdgeRecord);
}

export function getActiveAgentEdge(db: DatabaseSync, input: GetActiveAgentEdgeInput): AgentActiveEdgeRecord | null {
	return listActiveAgentEdges(db, { ...input, limit: 1 })[0] ?? null;
}

export function getActiveAgentAccessGrant(db: DatabaseSync, input: GetActiveAgentAccessGrantInput): AgentAccessGrantRecord | null {
	const grantKinds = Array.isArray(input.grantKind) ? input.grantKind : [input.grantKind];
	if (grantKinds.length === 0) return null;
	const where: string[] = [
		"grantee_agent_id = ?",
		`grant_kind IN (${makePlaceholders(grantKinds.length)})`,
		"state = 'active'",
		"(expires_at IS NULL OR expires_at > ?)",
	];
	const params: unknown[] = [input.granteeAgentId, ...grantKinds, input.now ?? Date.now()];
	if (input.orgId) {
		where.push("org_id = ?");
		params.push(input.orgId);
	}
	if (input.subjectAgentId !== undefined) {
		where.push("subject_agent_id IS ?");
		params.push(input.subjectAgentId);
	}
	if (input.subjectTaskId !== undefined) {
		where.push("subject_task_id IS ?");
		params.push(input.subjectTaskId);
	}
	const row = db
		.prepare(
			`SELECT *
			 FROM agent_access_grants
			 WHERE ${where.join(" AND ")}
			 ORDER BY updated_at DESC, created_at DESC
			 LIMIT 1`,
		)
		.get(...params) as Record<string, unknown> | undefined;
	return row ? toAgentAccessGrantRecord(row) : null;
}

