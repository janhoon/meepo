/**
 * SQL CHECK constraint fragments derived from TypeScript enums.
 */
import { SERVICE_STATES } from "../service-types.js";
import { TASK_LINK_STATES, TASK_LINK_TYPES, TASK_STATES, TASK_WAITING_ON_VALUES } from "../task-types.js";
import {
	AGENT_ACCESS_GRANT_KINDS,
	AGENT_ACCESS_GRANT_STATES,
	AGENT_ATTENTION_V2_KINDS,
	AGENT_ATTENTION_V2_STATES,
	AGENT_EDGE_STATES,
	AGENT_EDGE_TYPES,
	AGENT_HIERARCHY_STATES,
	AGENT_MESSAGE_ACTOR_KINDS,
	AGENT_MESSAGE_RECIPIENT_DELIVERY_MODES,
	AGENT_MESSAGE_RECIPIENT_STATUSES,
	AGENT_MESSAGE_ROUTE_DECISIONS,
	AGENT_MESSAGE_ROUTE_KINDS,
	AGENT_MESSAGE_TRANSPORT_KINDS,
	AGENT_MESSAGE_V2_KINDS,
	AGENT_ORG_STATES,
	AGENT_RECIPIENT_KINDS,
	AGENT_ROLE_VISIBILITY_SCOPES,
	AGENT_STATES,
	AGENT_SYSTEM_ACTOR_KINDS,
	AGENT_THREAD_KINDS,
	AGENT_THREAD_STATES,
	AGENT_TRANSPORT_KINDS,
	AGENT_TRANSPORT_STATES,
	ATTENTION_ITEM_AUDIENCES,
	ATTENTION_ITEM_KINDS,
	ATTENTION_ITEM_STATES,
	DELIVERY_MODES,
	DOWNWARD_ACTION_POLICIES,
	MESSAGE_KINDS,
	MESSAGE_STATUSES,
	MESSAGE_TARGET_KINDS,
} from "../types.js";

export const quotedStates = AGENT_STATES.map((value) => `'${value}'`).join(", ");
export const quotedTransportKinds = AGENT_TRANSPORT_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedTransportStates = AGENT_TRANSPORT_STATES.map((value) => `'${value}'`).join(", ");
export const quotedServiceStates = SERVICE_STATES.map((value) => `'${value}'`).join(", ");
export const quotedTargetKinds = MESSAGE_TARGET_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedMessageKinds = MESSAGE_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedDeliveryModes = DELIVERY_MODES.map((value) => `'${value}'`).join(", ");
export const quotedMessageStatuses = MESSAGE_STATUSES.map((value) => `'${value}'`).join(", ");
export const quotedAttentionItemKinds = ATTENTION_ITEM_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedAttentionItemAudiences = ATTENTION_ITEM_AUDIENCES.map((value) => `'${value}'`).join(", ");
export const quotedAttentionItemStates = ATTENTION_ITEM_STATES.map((value) => `'${value}'`).join(", ");
export const quotedRoleVisibilityScopes = AGENT_ROLE_VISIBILITY_SCOPES.map((value) => `'${value}'`).join(", ");
export const quotedOrgStates = AGENT_ORG_STATES.map((value) => `'${value}'`).join(", ");
export const quotedHierarchyStates = AGENT_HIERARCHY_STATES.map((value) => `'${value}'`).join(", ");
export const quotedEdgeTypes = AGENT_EDGE_TYPES.map((value) => `'${value}'`).join(", ");
export const quotedEdgeStates = AGENT_EDGE_STATES.map((value) => `'${value}'`).join(", ");
export const quotedSystemActorKinds = AGENT_SYSTEM_ACTOR_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedMessageActorKinds = AGENT_MESSAGE_ACTOR_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedRecipientKinds = AGENT_RECIPIENT_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedAccessGrantKinds = AGENT_ACCESS_GRANT_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedAccessGrantStates = AGENT_ACCESS_GRANT_STATES.map((value) => `'${value}'`).join(", ");
export const quotedThreadKinds = AGENT_THREAD_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedThreadStates = AGENT_THREAD_STATES.map((value) => `'${value}'`).join(", ");
export const quotedMessageV2Kinds = AGENT_MESSAGE_V2_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedMessageRecipientDeliveryModes = AGENT_MESSAGE_RECIPIENT_DELIVERY_MODES.map((value) => `'${value}'`).join(", ");
export const quotedMessageRecipientStatuses = AGENT_MESSAGE_RECIPIENT_STATUSES.map((value) => `'${value}'`).join(", ");
export const quotedMessageTransportKinds = AGENT_MESSAGE_TRANSPORT_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedRouteKinds = AGENT_MESSAGE_ROUTE_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedRouteDecisions = AGENT_MESSAGE_ROUTE_DECISIONS.map((value) => `'${value}'`).join(", ");
export const quotedAttentionV2Kinds = AGENT_ATTENTION_V2_KINDS.map((value) => `'${value}'`).join(", ");
export const quotedAttentionV2States = AGENT_ATTENTION_V2_STATES.map((value) => `'${value}'`).join(", ");
export const quotedDownwardActionPolicies = DOWNWARD_ACTION_POLICIES.map((value) => `'${value}'`).join(", ");
export const quotedTaskStates = TASK_STATES.map((value) => `'${value}'`).join(", ");
export const quotedTaskWaitingOn = TASK_WAITING_ON_VALUES.map((value) => `'${value}'`).join(", ");
export const quotedTaskLinkTypes = TASK_LINK_TYPES.map((value) => `'${value}'`).join(", ");
export const quotedTaskLinkStates = TASK_LINK_STATES.map((value) => `'${value}'`).join(", ");
