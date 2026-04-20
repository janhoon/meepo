export const AGENT_STATES = [
	"launching",
	"running",
	"idle",
	"waiting",
	"blocked",
	"done",
	"error",
	"stopped",
	"lost",
] as const;

export const MESSAGE_TARGET_KINDS = ["primary", "user", "child"] as const;
export const MESSAGE_KINDS = [
	"started",
	"milestone",
	"blocked",
	"question",
	"question_for_user",
	"answer",
	"note",
	"redirect",
	"cancel",
	"priority",
	"complete",
] as const;
export const DELIVERY_MODES = ["immediate", "steer", "follow_up", "idle_only"] as const;
export const DOWNWARD_ACTION_POLICIES = ["fyi", "resume_if_blocked", "replan", "interrupt_and_replan", "stop"] as const;
export const MESSAGE_STATUSES = ["queued", "delivered", "acked", "failed", "expired"] as const;
export const ATTENTION_ITEM_KINDS = ["question", "question_for_user", "blocked", "complete"] as const;
export const ATTENTION_ITEM_AUDIENCES = ["coordinator", "user"] as const;
export const ATTENTION_ITEM_STATES = [
	"open",
	"acknowledged",
	"waiting_on_coordinator",
	"waiting_on_user",
	"resolved",
	"cancelled",
	"superseded",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];
export type MessageTargetKind = (typeof MESSAGE_TARGET_KINDS)[number];
export type MessageKind = (typeof MESSAGE_KINDS)[number];
export type DeliveryMode = (typeof DELIVERY_MODES)[number];
export type DownwardMessageActionPolicy = (typeof DOWNWARD_ACTION_POLICIES)[number];
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export type AttentionItemKind = (typeof ATTENTION_ITEM_KINDS)[number];
export type AttentionItemAudience = (typeof ATTENTION_ITEM_AUDIENCES)[number];
export type AttentionItemState = (typeof ATTENTION_ITEM_STATES)[number];

export interface SessionChildLinkEntryData {
	childId: string;
	title: string;
	profile: string;
	task: string;
	runDir: string;
	sessionFile: string;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	createdAt: number;
}

export interface SubagentProfile {
	name: string;
	description: string;
	systemPrompt: string;
	tools: string[];
	model: string | null;
	filePath: string;
}

export interface SpawnSubagentInput {
	agentId?: string;
	title: string;
	task: string;
	profile: SubagentProfile;
	spawnCwd: string;
	model: string | null;
	tools: string[];
	priority: string | null;
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
}

export interface SpawnSubagentResult {
	agentId: string;
	profile: string;
	title: string;
	spawnCwd: string;
	runDir: string;
	sessionFile: string;
	tmuxSessionId: string;
	tmuxSessionName: string;
	tmuxWindowId: string;
	tmuxPaneId: string;
	sessionLinkData: SessionChildLinkEntryData;
}

export interface ChildRuntimeEnvironment {
	childId: string;
	runDir: string;
	profile: string;
	allowedTools: string[];
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
}

export interface RuntimeStatusSnapshot {
	agentId: string;
	profile: string;
	state: AgentState;
	updatedAt: number;
	lastToolName: string | null;
	lastAssistantPreview: string | null;
	lastError: string | null;
	finalSummary: string | null;
	finishedAt?: number | null;
}

export interface SubagentPublishPayload {
	kind: "milestone" | "blocked" | "question" | "question_for_user" | "note" | "complete";
	summary: string;
	details?: string;
	files?: string[];
	attempted?: string;
	answerNeeded?: string;
	recommendedNextAction?: string;
}

export interface DownwardMessagePayload {
	summary: string;
	details?: string;
	files?: string[];
	actionPolicy?: DownwardMessageActionPolicy;
	inReplyToMessageId?: string;
}

export interface AgentMessageRecord {
	id: string;
	threadId: string;
	senderAgentId: string | null;
	recipientAgentId: string | null;
	targetKind: MessageTargetKind;
	kind: MessageKind;
	deliveryMode: DeliveryMode;
	payload: unknown;
	status: MessageStatus;
	createdAt: number;
	deliveredAt: number | null;
	ackedAt: number | null;
}

export interface AgentSummary {
	id: string;
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	spawnCwd: string;
	projectKey: string;
	profile: string;
	title: string;
	task: string;
	state: AgentState;
	model: string | null;
	tools: unknown;
	tmuxSessionId: string | null;
	tmuxSessionName: string | null;
	tmuxWindowId: string | null;
	tmuxPaneId: string | null;
	runDir: string;
	sessionFile: string;
	lastToolName: string | null;
	lastAssistantPreview: string | null;
	lastError: string | null;
	finalSummary: string | null;
	createdAt: number;
	updatedAt: number;
	finishedAt: number | null;
	unreadCount: number;
	latestUnreadMessage: AgentMessageRecord | null;
}

export interface AttentionItemRecord {
	id: string;
	messageId: string | null;
	agentId: string;
	threadId: string;
	projectKey: string;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	audience: AttentionItemAudience;
	kind: AttentionItemKind;
	priority: number;
	state: AttentionItemState;
	summary: string;
	payload: unknown;
	createdAt: number;
	updatedAt: number;
	resolvedAt: number | null;
	resolutionKind: string | null;
	resolutionSummary: string | null;
}

export interface CreateAgentInput {
	id: string;
	parentAgentId?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd: string;
	projectKey: string;
	profile: string;
	title: string;
	task: string;
	state: AgentState;
	model?: string | null;
	tools?: unknown;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	runDir: string;
	sessionFile: string;
	lastToolName?: string | null;
	lastAssistantPreview?: string | null;
	lastError?: string | null;
	finalSummary?: string | null;
	createdAt?: number;
	updatedAt?: number;
	finishedAt?: number | null;
}

export interface UpdateAgentInput {
	parentAgentId?: string | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd?: string;
	projectKey?: string;
	profile?: string;
	title?: string;
	task?: string;
	state?: AgentState;
	model?: string | null;
	tools?: unknown;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	runDir?: string;
	sessionFile?: string;
	lastToolName?: string | null;
	lastAssistantPreview?: string | null;
	lastError?: string | null;
	finalSummary?: string | null;
	updatedAt?: number;
	finishedAt?: number | null;
}

export interface CreateAgentMessageInput {
	id: string;
	threadId: string;
	senderAgentId?: string | null;
	recipientAgentId?: string | null;
	targetKind: MessageTargetKind;
	kind: MessageKind;
	deliveryMode: DeliveryMode;
	payload: unknown;
	status: MessageStatus;
	createdAt?: number;
	deliveredAt?: number | null;
	ackedAt?: number | null;
}

export interface CreateAgentEventInput {
	id: string;
	agentId: string;
	eventType: string;
	summary?: string | null;
	payload?: unknown;
	createdAt?: number;
}

export interface CreateArtifactInput {
	id: string;
	agentId: string;
	kind: string;
	path: string;
	label?: string | null;
	metadata?: unknown;
	createdAt?: number;
}

export interface CreateAttentionItemInput {
	id: string;
	messageId?: string | null;
	agentId: string;
	threadId: string;
	projectKey: string;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	audience: AttentionItemAudience;
	kind: AttentionItemKind;
	priority: number;
	state: AttentionItemState;
	summary: string;
	payload?: unknown;
	createdAt?: number;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface UpdateAttentionItemInput {
	state?: AttentionItemState;
	priority?: number;
	summary?: string;
	payload?: unknown;
	updatedAt?: number;
	resolvedAt?: number | null;
	resolutionKind?: string | null;
	resolutionSummary?: string | null;
}

export interface ListAgentsFilters {
	ids?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	descendantOf?: string[];
	activeOnly?: boolean;
	blockedOnly?: boolean;
	unreadOnly?: boolean;
	limit?: number;
}

export interface ListInboxFilters {
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	agentIds?: string[];
	includeDelivered?: boolean;
	limit?: number;
}

export interface ListAttentionItemsFilters {
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	agentIds?: string[];
	states?: AttentionItemState[];
	audiences?: AttentionItemAudience[];
	kinds?: AttentionItemKind[];
	limit?: number;
}

export interface FleetSummary {
	active: number;
	blocked: number;
	userQuestions: number;
	unread: number;
	attentionOpen: number;
	attentionWaitingOnUser: number;
	attentionCompletions: number;
}
