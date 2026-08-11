/**
 * Meepo registry barrel — stable public import path.
 * Implementation lives in agent-store / message-store / hierarchy-store.
 */

export { ACTIVE_STATES, AGENT_FIELD_TO_COLUMN } from "./registry-shared.js";

export {
	createAgent,
	updateAgent,
	listDescendantAgentIds,
	listAgents,
	getAgent,
	getFleetSummary,
} from "./agent-store.js";

export {
	createAgentMessage,
	markAgentMessages,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessageRecipientsByIds,
	createAgentEvent,
	createArtifact,
	createAttentionItem,
	updateAttentionItem,
	updateAttentionItemsForAgent,
	listAttentionItems,
	createAgentAttentionItemV2,
	listAgentAttentionItemsV2,
	updateAgentAttentionItemsV2ForOwner,
	listInboxMessages,
	listMessagesForRecipient,
} from "./message-store.js";

export {
	AgentMessagePermissionError,
	createRootActorContext,
	getAgentRole,
	getAgentOrg,
	getAgentActorContext,
	resolveAgentActorContext,
	listHierarchyVisibleAgentIds,
	listActiveAgentEdges,
	getActiveAgentEdge,
	getActiveAgentAccessGrant,
	canSendMessage,
	createAgentMessageRoute,
	createAgentMessageRouteAudit,
	createMessageWithRecipients,
	fetchAgentInboxV2,
	listAgentMessageHistoryV2,
	getAgentMessageRecipientUnreadSummary,
	upsertAgentOrg,
	ensureAgentHierarchySelfClosure,
	wouldCreateHierarchyCycle,
	createAgentHierarchyEdge,
	rebuildAgentHierarchyClosure,
} from "./hierarchy-store.js";

export type * from "./registry-types.js";
