/** Exported registry input/result types (split from monolith). */
import type {
	AgentAccessGrantKind,
	AgentActorContext,
	AgentAttentionV2Record,
	AgentEdgeType,
	AgentInboxMessageV2Record,
	AgentMessageActorKind,
	AgentMessageRecipientDeliveryMode,
	AgentMessageRecipientRecord,
	AgentMessageRecipientStatus,
	AgentMessageRouteRecord,
	AgentMessageTransportKind,
	AgentMessageV2Kind,
	AgentMessageV2Record,
	AgentOrgRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentThreadKind,
	AgentThreadRecord,
	AgentThreadState,
	AgentUnreadSummaryRecord,
	CanSendMessageDecision,
	DownwardMessageActionPolicy,
	MessageKind,
} from "./types.js";

export interface ResolveAgentActorContextInput {
	currentAgentId?: string | null;
	root?: boolean;
	projectKey?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
}

export interface ListHierarchyVisibleAgentIdsOptions {
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	includeArchived?: boolean;
}

export interface GetActiveAgentEdgeInput {
	parentAgentId: string;
	childAgentId: string;
	edgeType?: AgentEdgeType;
	orgId?: string | null;
}

export interface ListActiveAgentEdgesInput {
	parentAgentId?: string;
	childAgentId?: string;
	edgeType?: AgentEdgeType;
	orgId?: string | null;
	limit?: number;
}

export interface GetActiveAgentAccessGrantInput {
	granteeAgentId: string;
	grantKind: AgentAccessGrantKind | AgentAccessGrantKind[];
	orgId?: string | null;
	subjectAgentId?: string | null;
	subjectTaskId?: string | null;
	now?: number;
}

export interface CanSendMessageInput {
	actor: AgentActorContext;
	recipient: AgentRecipientRef;
	messageKind?: AgentMessageV2Kind;
	now?: number;
}

export interface CreateAgentMessageRouteInput {
	id?: string;
	messageId: string;
	orgId?: string | null;
	fromAgentId?: string | null;
	toAgentId?: string | null;
	fromKind: AgentMessageActorKind;
	toKind: AgentRecipientKind;
	routeKind: CanSendMessageDecision["routeKind"];
	edgeId?: string | null;
	policyId?: string | null;
	grantId?: string | null;
	decision: "allowed" | "denied";
	decisionReason: string;
	createdAt?: number;
}

export interface CreateAgentMessageThreadV2Input {
	id?: string;
	kind?: AgentThreadKind;
	title?: string;
	state?: AgentThreadState;
	parentThreadId?: string | null;
	metadata?: unknown;
}

export interface CreateAgentMessageWithRecipientsInput {
	actor: AgentActorContext;
	recipients: CreateAgentMessageRecipientV2Input[];
	messageId?: string;
	threadId?: string;
	thread?: CreateAgentMessageThreadV2Input;
	orgId?: string | null;
	projectKey?: string;
	taskId?: string | null;
	subjectAgentId?: string | null;
	kind: AgentMessageV2Kind;
	summary: string;
	bodyMarkdown?: string | null;
	payload?: unknown;
	actionPolicy?: DownwardMessageActionPolicy | null;
	priority?: number;
	requiresResponse?: boolean;
	supersedesMessageId?: string | null;
	createdAt?: number;
	skipPermissionCheck?: boolean;
}

export interface CreateAgentMessageWithRecipientsResult {
	thread: AgentThreadRecord;
	message: AgentMessageV2Record;
	recipients: AgentMessageRecipientRecord[];
	routes: AgentMessageRouteRecord[];
}

export interface FetchAgentInboxV2Input {
	actor: AgentActorContext;
	recipient?: AgentRecipientRef;
	includeRead?: boolean;
	markRead?: boolean;
	statuses?: AgentMessageRecipientStatus[];
	projectKey?: string;
	threadId?: string;
	limit?: number;
}

export interface CreateAgentAttentionItemV2Input {
	id?: string;
	messageId?: string | null;
	recipientRowId?: string | null;
	orgId?: string | null;
	projectKey: string;
	taskId?: string | null;
	subjectAgentId?: string | null;
	ownerAgentId?: string | null;
	ownerKind: AgentRecipientKind;
	kind: AgentAttentionV2Record["kind"];
	priority: number;
	state?: AgentAttentionV2Record["state"];
	summary: string;
	payload?: unknown;
	createdAt?: number;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface ListAgentAttentionItemsV2Filters {
	projectKey?: string;
	ownerKind?: AgentRecipientKind;
	ownerKinds?: AgentRecipientKind[];
	ownerAgentId?: string | null;
	ownerAgentIds?: string[];
	subjectAgentIds?: string[];
	taskIds?: string[];
	states?: AgentAttentionV2Record["state"][];
	kinds?: AgentAttentionV2Record["kind"][];
	limit?: number;
}

export interface UpdateAgentAttentionItemsV2Patch {
	state?: AgentAttentionV2Record["state"];
	priority?: number;
	summary?: string;
	payload?: unknown;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface AgentMessageRecipientUnreadSummaryFilters {
	recipientKind?: AgentRecipientKind;
	agentIds?: string[];
	projectKey?: string;
	limit?: number;
}

export interface UpsertAgentOrgInput {
	id: string;
	projectKey: string;
	rootAgentId?: string | null;
	title: string;
	state?: AgentOrgRecord["state"];
	metadata?: unknown;
	createdAt?: number;
	updatedAt?: number;
	archivedAt?: number | null;
}

export interface CreateAgentHierarchyEdgeInput {
	id?: string;
	orgId?: string | null;
	parentAgentId: string;
	childAgentId: string;
	edgeType?: AgentEdgeType;
	rolePolicyId?: string | null;
	allowPolicyless?: boolean;
	taskId?: string | null;
	createdByAgentId?: string | null;
	createdByKind?: AgentSystemActorKind;
	reason?: string | null;
	metadata?: unknown;
	createdAt?: number;
	updatedAt?: number;
}

export type CreateAgentMessageRecipientV2Input = AgentRecipientRef & {
	id?: string;
	deliveryMode?: AgentMessageRecipientDeliveryMode;
	status?: AgentMessageRecipientStatus;
	transportKind?: AgentMessageTransportKind | null;
	metadata?: unknown;
};
