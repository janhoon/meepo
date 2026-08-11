/**
 * hierarchy-routing
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
import { getAgentScopeRow, normalizeRecipient } from "./hierarchy-actors.js";
import { listActiveAgentEdges, getActiveAgentEdge, getActiveAgentAccessGrant } from "./hierarchy-edges-read.js";

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

export function makeCanSendDecision(input: {
	allowed: boolean;
	actor: AgentActorContext;
	recipient: AgentRecipientRef;
	routeKind: CanSendMessageDecision["routeKind"];
	reason: string;
	orgId?: string | null;
	edgeId?: string | null;
	policyId?: string | null;
	grantId?: string | null;
}): CanSendMessageDecision {
	const recipient = normalizeRecipient(input.recipient);
	return {
		allowed: input.allowed,
		fromKind: input.actor.kind === "root" ? "root" : "agent",
		toKind: recipient.kind,
		fromAgentId: input.actor.kind === "agent" ? input.actor.agentId : null,
		toAgentId: recipient.agentId,
		orgId: input.orgId ?? (input.actor.kind === "agent" ? input.actor.orgId : null),
		routeKind: input.routeKind,
		edgeId: input.edgeId ?? null,
		policyId: input.policyId ?? null,
		grantId: input.grantId ?? null,
		decisionReason: input.reason,
	};
}

export function canSendMessage(db: DatabaseSync, input: CanSendMessageInput): CanSendMessageDecision {
	const { actor, recipient } = input;
	const now = input.now ?? Date.now();
	const recipientScope = recipient.kind === "agent" ? getAgentScopeRow(db, recipient.agentId) : null;
	if (recipient.kind === "agent" && !recipientScope) {
		return makeCanSendDecision({
			allowed: false,
			actor,
			recipient,
			routeKind: "multi_hop",
			reason: `Unknown recipient agent id "${recipient.agentId}".`,
		});
	}
	if (actor.kind === "root" || (actor.kind === "agent" && actor.canAdminOverride)) {
		return makeCanSendDecision({
			allowed: true,
			actor,
			recipient,
			routeKind: "root_override",
			orgId: recipientScope?.orgId ?? (actor.kind === "agent" ? actor.orgId : null),
			reason: "Root/admin override allows this route.",
		});
	}
	if (recipient.kind === "user") {
		return makeCanSendDecision({
			allowed: input.messageKind === "question_for_user",
			actor,
			recipient,
			routeKind: "user_escalation",
			reason:
				input.messageKind === "question_for_user"
					? "question_for_user messages may route to the user."
					: "Only question_for_user messages may route to the user.",
		});
	}
	if (recipient.kind === "root") {
		const parentEdge = listActiveAgentEdges(db, { childAgentId: actor.agentId, edgeType: "reports_to", limit: 1 })[0] ?? null;
		return makeCanSendDecision({
			allowed: parentEdge === null,
			actor,
			recipient,
			routeKind: parentEdge === null ? "user_escalation" : "multi_hop",
			reason:
				parentEdge === null
					? "Agent has no active parent edge; root may own the escalation."
					: "Agent has an active parent edge; route messages to the direct parent unless root uses override.",
		});
	}
	if (recipient.agentId === actor.agentId) {
		return makeCanSendDecision({
			allowed: false,
			actor,
			recipient,
			routeKind: "multi_hop",
			orgId: actor.orgId,
			reason: "Agents cannot send hierarchy messages to themselves.",
		});
	}

	let directDeniedDecision: CanSendMessageDecision | null = null;
	const directDown = getActiveAgentEdge(db, {
		parentAgentId: actor.agentId,
		childAgentId: recipient.agentId,
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
	});
	if (directDown) {
		const decision = makeCanSendDecision({
			allowed: directDown.allowParentToChildMessage,
			actor,
			recipient,
			routeKind: "direct_child",
			orgId: directDown.orgId,
			edgeId: directDown.id,
			policyId: directDown.rolePolicyId,
			reason: !directDown.rolePolicyId
				? "Active direct child edge has no matching role policy; policyless edges deny parent-to-child messaging."
				: directDown.allowParentToChildMessage
					? "Active direct child edge policy allows parent-to-child messaging."
					: "Active direct child edge policy denies parent-to-child messaging.",
		});
		if (decision.allowed) return decision;
		directDeniedDecision = decision;
	}
	const directUp = getActiveAgentEdge(db, {
		parentAgentId: recipient.agentId,
		childAgentId: actor.agentId,
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
	});
	if (directUp) {
		const decision = makeCanSendDecision({
			allowed: directUp.allowChildToParentMessage,
			actor,
			recipient,
			routeKind: "direct_parent",
			orgId: directUp.orgId,
			edgeId: directUp.id,
			policyId: directUp.rolePolicyId,
			reason: !directUp.rolePolicyId
				? "Active direct parent edge has no matching role policy; policyless edges deny child-to-parent messaging."
				: directUp.allowChildToParentMessage
					? "Active direct parent edge policy allows child-to-parent messaging."
					: "Active direct parent edge policy denies child-to-parent messaging.",
		});
		if (decision.allowed) return decision;
		directDeniedDecision ??= decision;
	}
	const grant = getActiveAgentAccessGrant(db, {
		granteeAgentId: actor.agentId,
		grantKind: "message_agent",
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
		subjectAgentId: recipient.agentId,
		now,
	});
	if (grant) {
		return makeCanSendDecision({
			allowed: true,
			actor,
			recipient,
			routeKind: "explicit_grant",
			orgId: grant.orgId,
			grantId: grant.id,
			reason: "Active explicit message_agent grant allows this route.",
		});
	}
	return directDeniedDecision ?? makeCanSendDecision({
		allowed: false,
		actor,
		recipient,
		routeKind: "multi_hop",
		orgId: actor.orgId ?? recipientScope?.orgId ?? null,
		reason: "No active direct hierarchy edge or message_agent grant allows this route.",
	});
}

export function createAgentMessageRoute(db: DatabaseSync, input: CreateAgentMessageRouteInput): AgentMessageRouteRecord {
	const record: AgentMessageRouteRecord = {
		id: input.id ?? randomUUID(),
		messageId: input.messageId,
		orgId: input.orgId ?? null,
		fromAgentId: input.fromAgentId ?? null,
		toAgentId: input.toAgentId ?? null,
		fromKind: input.fromKind,
		toKind: input.toKind,
		routeKind: input.routeKind,
		edgeId: input.edgeId ?? null,
		policyId: input.policyId ?? null,
		grantId: input.grantId ?? null,
		decision: input.decision,
		decisionReason: input.decisionReason,
		createdAt: input.createdAt ?? Date.now(),
	};
	db.prepare(
		`INSERT INTO agent_message_routes (
			id, message_id, org_id, from_agent_id, to_agent_id, from_kind, to_kind,
			route_kind, edge_id, policy_id, grant_id, decision, decision_reason, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		record.id,
		record.messageId,
		record.orgId,
		record.fromAgentId,
		record.toAgentId,
		record.fromKind,
		record.toKind,
		record.routeKind,
		record.edgeId,
		record.policyId,
		record.grantId,
		record.decision,
		record.decisionReason,
		record.createdAt,
	);
	return record;
}

export function createAgentMessageRouteAudit(db: DatabaseSync, messageId: string, decision: CanSendMessageDecision, createdAt = Date.now()): AgentMessageRouteRecord {
	return createAgentMessageRoute(db, {
		messageId,
		orgId: decision.orgId,
		fromAgentId: decision.fromAgentId,
		toAgentId: decision.toAgentId,
		fromKind: decision.fromKind,
		toKind: decision.toKind,
		routeKind: decision.routeKind,
		edgeId: decision.edgeId,
		policyId: decision.policyId,
		grantId: decision.grantId,
		decision: decision.allowed ? "allowed" : "denied",
		decisionReason: decision.decisionReason,
		createdAt,
	});
}

