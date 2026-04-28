import type { TaskState, TaskWaitingOn, TaskWorkspaceStrategy } from "./task-types.js";

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

export const AGENT_TRANSPORT_KINDS = ["direct", "rpc_bridge"] as const;
export const AGENT_TRANSPORT_STATES = [
	"legacy",
	"launching",
	"listening",
	"live",
	"fallback",
	"disconnected",
	"stopped",
	"error",
	"lost",
] as const;
export const RUNTIME_STATUS_SOURCES = ["spawn", "rpc_bridge", "child_runtime"] as const;
export const CHILD_DOWNWARD_DELIVERY_MODES = ["rpc_bridge", "poll_fallback"] as const;

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
export type AgentTransportKind = (typeof AGENT_TRANSPORT_KINDS)[number];
export type AgentTransportState = (typeof AGENT_TRANSPORT_STATES)[number];
export type RuntimeStatusSource = (typeof RUNTIME_STATUS_SOURCES)[number];
export type ChildDownwardDeliveryMode = (typeof CHILD_DOWNWARD_DELIVERY_MODES)[number];
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
	transportKind?: AgentTransportKind;
	transportState?: AgentTransportState;
	bridgeSocketPath?: string | null;
	bridgeStatusFile?: string | null;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	taskId?: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
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
	taskId: string | null;
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
}

export interface SpawnSubagentResult {
	agentId: string;
	profile: string;
	title: string;
	spawnCwd: string;
	runDir: string;
	sessionFile: string;
	taskId: string | null;
	workspaceStrategy: TaskWorkspaceStrategy | null;
	worktreeId: string | null;
	worktreeCwd: string | null;
	transportKind: AgentTransportKind;
	transportState: AgentTransportState;
	bridgeSocketPath: string | null;
	bridgeStatusFile: string | null;
	bridgeLogFile: string | null;
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
	taskId: string | null;
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	workspaceStrategy: TaskWorkspaceStrategy | null;
	worktreeId: string | null;
	worktreeCwd: string | null;
	transportKind: AgentTransportKind;
	bridgeStatusFile: string | null;
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
	source?: RuntimeStatusSource;
	transportKind?: AgentTransportKind | null;
	transportState?: AgentTransportState | null;
	downwardDeliveryMode?: ChildDownwardDeliveryMode | null;
}

export interface SubagentPublishPayload {
	kind: "milestone" | "blocked" | "question" | "question_for_user" | "note" | "complete";
	summary: string;
	details?: string;
	files?: string[];
	attempted?: string;
	answerNeeded?: string;
	recommendedNextAction?: string;
	taskStatus?: TaskState;
	waitingOn?: TaskWaitingOn;
	blockedReason?: string;
	taskSummary?: string;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	reviewSummary?: string;
	finalSummary?: string;
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
	taskId: string | null;
	workspaceStrategy: TaskWorkspaceStrategy | null;
	worktreeId: string | null;
	worktreeCwd: string | null;
	profile: string;
	title: string;
	task: string;
	state: AgentState;
	transportKind: AgentTransportKind;
	transportState: AgentTransportState;
	model: string | null;
	tools: unknown;
	bridgeSocketPath: string | null;
	bridgeStatusFile: string | null;
	bridgeLogFile: string | null;
	bridgeEventsFile: string | null;
	bridgePid: number | null;
	bridgeConnectedAt: number | null;
	bridgeUpdatedAt: number | null;
	bridgeLastError: string | null;
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
	taskId?: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
	profile: string;
	title: string;
	task: string;
	state: AgentState;
	transportKind?: AgentTransportKind;
	transportState?: AgentTransportState;
	model?: string | null;
	tools?: unknown;
	bridgeSocketPath?: string | null;
	bridgeStatusFile?: string | null;
	bridgeLogFile?: string | null;
	bridgeEventsFile?: string | null;
	bridgePid?: number | null;
	bridgeConnectedAt?: number | null;
	bridgeUpdatedAt?: number | null;
	bridgeLastError?: string | null;
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
	taskId?: string | null;
	workspaceStrategy?: TaskWorkspaceStrategy | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
	profile?: string;
	title?: string;
	task?: string;
	state?: AgentState;
	transportKind?: AgentTransportKind;
	transportState?: AgentTransportState;
	model?: string | null;
	tools?: unknown;
	bridgeSocketPath?: string | null;
	bridgeStatusFile?: string | null;
	bridgeLogFile?: string | null;
	bridgeEventsFile?: string | null;
	bridgePid?: number | null;
	bridgeConnectedAt?: number | null;
	bridgeUpdatedAt?: number | null;
	bridgeLastError?: string | null;
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

export interface RpcBridgeConfig {
	agentId: string;
	title: string;
	spawnCwd: string;
	runDir: string;
	sessionFile: string;
	taskFile: string;
	profileFile: string;
	runtimeAppendixFile: string;
	allowedTools: string[];
	model: string | null;
	piCommand: string;
	piArgs: string[];
	bridgeSocketPath: string;
	bridgeStatusFile: string;
	bridgeEventsFile: string;
	bridgeLogFile: string;
	bridgePidFile: string;
	latestStatusFile: string;
	debugLogFile: string;
	childEnv: Record<string, string>;
	createdAt: number;
}

export interface RpcBridgeStatusSnapshot {
	agentId: string;
	transportKind: "rpc_bridge";
	transportState: AgentTransportState;
	updatedAt: number;
	bridgePid: number | null;
	childPid: number | null;
	socketPath: string | null;
	connectedAt?: number | null;
	lastError?: string | null;
	lastEventType?: string | null;
	isStreaming?: boolean;
	pendingRequests?: number;
}

export interface RpcBridgeCommandRequest {
	id: string;
	command: "ping" | "prompt" | "steer" | "follow_up" | "abort" | "get_state";
	message?: string;
	images?: unknown[];
	streamingBehavior?: "steer" | "followUp";
}

export interface RpcBridgeCommandResponse {
	id: string;
	success: boolean;
	data?: unknown;
	error?: string;
}
