/**
 * task-interactions — split from coordinator-helpers.
 */
/**
 * Coordinator helpers (spawn/reconcile/wake/UI). Tool registration lives in tools/*.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { openAgentsBoard, type AgentsBoardData, type AgentsBoardState, type BoardLaneId, type BoardTicket } from "./board.js";
import { registerChildRuntime, getChildRuntimeEnvironment } from "./child-runtime.js";
import { openAgentsDashboard, type AgentsDashboardData, type AgentsDashboardState } from "./dashboard.js";
import { closeMeepoDb, getMeepoDb } from "./db.js";
import { getRpcBridgeSocketPath, pingRpcBridge, readRpcBridgeStatus, sendRpcBridgeCommand } from "./rpc-client.js";
import {
	applyNoWaitSystemPrompt,
	getBashCommandFromToolInput,
	noWaitBashBlockReason,
} from "./no-wait-policy.js";
import { LEGACY_SESSION_CHILD_LINK_ENTRY_TYPE, SESSION_CHILD_LINK_ENTRY_TYPE } from "./paths.js";
import { getAllowedBuiltinToolNames, getSubagentProfile, listSubagentProfiles, normalizeBuiltinTools } from "./profiles.js";
import { getProjectKey } from "./project.js";
import { truncateText } from "./text-util.js";
import {
	AgentMessagePermissionError,
	canSendMessage,
	createAgentEvent,
	createAgentMessage,
	createMessageWithRecipients,
	createRootActorContext,
	fetchAgentInboxV2,
	getAgent,
	getFleetSummary,
	listAgentAttentionItemsV2,
	listAgents,
	listAttentionItems,
	listDescendantAgentIds,
	listHierarchyVisibleAgentIds,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessages,
	resolveAgentActorContext,
	updateAgent,
	updateAgentAttentionItemsV2ForOwner,
	updateAttentionItemsForAgent,
} from "./registry.js";
import type { ListAgentAttentionItemsV2Filters } from "./registry.js";
import { collectQueuedWakeCoalescingContext } from "./wake-coalescing.js";
import { LEGACY_SERVICE_TOOL_ALIASES, loadMeepoConfig } from "./config.js";
import { createMeepoRuntime, type MeepoRuntime } from "./runtime.js";
import {
	assertTaskLeaseAvailable,
	cancelTaskLink,
	createTask,
	createTaskEvent,
	createTaskLink,
	deriveTaskHealth,
	formatTaskLeaseConflict,
	getTask,
	getTaskLease,
	getTaskLeaseConflict,
	getTaskSummary,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTaskEvents,
	listTaskHealth,
	listTaskLinks,
	listTaskReadiness,
	listTasks,
	listTaskSubtreeWithMeta,
	listUnresolvedTaskDependencies,
	reconcileTasks,
	refreshTaskDependencyBlockState,
	resolveDependenciesForCompletedTask,
	taskLeaseKindForProfile,
	unlinkTaskAgent,
	updateTask,
} from "./task-registry.js";
import { getService, listServices, updateService } from "./service-registry.js";
import { readServiceStatus, spawnService, tailFileLines } from "./service-spawn.js";
import { spawnSubagent } from "./spawn.js";
import { maybeNotifyHostAttention } from "./host-notify.js";
import { getProcessHost, hostTargetRefFromLegacy } from "./process-host.js";
import {
	mapDeliveryModeToBridgeCommand,
	missingHostTargetMessage,
} from "./rpc-bridge-control.js";
import type {
	ListServicesFilters,
	ServiceStatusSnapshot,
	ServiceSummary,
	SpawnServiceResult,
	UpdateServiceInput,
} from "./service-types.js";
import type {
	AgentActorContext,
	AgentAttentionV2Record,
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentSummary,
	AttentionItemRecord,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	FleetSummary,
	ListAgentsFilters,
	RuntimeStatusSnapshot,
	SessionChildLinkEntryData,
	SpawnSubagentResult,
	SubagentProfile,
	TaskInteractionRecord,
	UpdateAgentInput,
} from "./types.js";
import type {
	CreateTaskInput,
	ListTaskAgentLinksFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskHealthSnapshot,
	TaskLinkState,
	TaskLinkType,
	TaskLinkWithTasksRecord,
	TaskReadinessRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
	UpdateTaskInput,
} from "./task-types.js";
import {
	actorLabelForInteraction,
	attentionItemIcon,
	attentionItemLabel,
	buildAdminAttentionText,
	buildAttentionText,
	buildAttentionV2Text,
	buildInboxText,
	buildInboxV2Text,
	buildTaskAttentionText,
	buildTaskLinksText,
	buildTaskReadyText,
	defaultDownwardActionPolicy,
	formatAgentDetails,
	formatAgentLine,
	formatAttentionGateWarning,
	formatAttentionWakeup,
	formatCleanupCandidates,
	formatCleanupResults,
	formatFleetSummary,
	formatFocusResult,
	formatReconcileResult,
	formatServiceDetails,
	formatServiceFocusResult,
	formatServiceLine,
	formatServiceReconcileResult,
	formatServiceStartResult,
	formatServiceStopResult,
	formatSpawnSuccess,
	formatStopResult,
	formatTaskDetails,
	formatTaskLine,
	formatTaskLinkLine,
	formatTaskReadinessLine,
	ownerLabelForInteraction,
	serviceReadyLabel,
	serviceStateIcon,
	summarizeFilters,
	summarizeServiceFilters,
	summarizeTaskFilters,
	taskInteractionIcon,
	taskInteractionLabel,
} from "./formatters.js";
import {
	TaskSubtreeControlAction,
	applyTaskSubtreeControl,
	buildTaskSubtreeControlPreview,
	configureSubtreeControlDeps,
	formatTaskSubtreeControlApplyResult,
	formatTaskSubtreeControlConfirmation,
	formatTaskSubtreeControlPreview,
} from "./subtree-control.js";
import {
	deliverQueuedMessagesViaBridge,
	queueDownwardMessage,
} from "./bridge-delivery.js";
import {
	SubagentAttentionParams,
	SubagentCaptureParams,
	SubagentCleanupParams,
	SubagentFocusParams,
	SubagentGetParams,
	SubagentInboxParams,
	SubagentListParams,
	SubagentMessageParams,
	SubagentReconcileParams,
	SubagentSpawnParams,
	SubagentStopParams,
	TaskAttentionParams,
	TaskCreateParams,
	TaskDispatchReadyParams,
	TaskGetParams,
	TaskLinkAgentParams,
	TaskLinkParams,
	TaskLinksParams,
	TaskListParams,
	TaskMoveParams,
	TaskNoteParams,
	TaskReadyParams,
	TaskReconcileParams,
	TaskSubtreeControlParams,
	TaskUnlinkAgentParams,
	TaskUnlinkParams,
	TaskUpdateParams,
	TmuxServiceCaptureParams,
	TmuxServiceFocusParams,
	TmuxServiceGetParams,
	TmuxServiceListParams,
	TmuxServiceReconcileParams,
	TmuxServiceStartParams,
	TmuxServiceStopParams,
} from "./tool-schemas.js";
import type { CleanupCandidate } from "./cleanup-types.js";
import { truncateText } from "./text-util.js";


/** Active Meepo config for this extension process (set on register). */
export function attentionOwnerKindsForAudience(audience?: "all" | "coordinator" | "user"): AgentRecipientKind[] | undefined {
	if (audience === "user") return ["user"];
	if (audience === "coordinator") return ["root", "agent"];
	return undefined;
}

export function resolveAdminAttentionV2Filters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { audience?: "all" | "coordinator" | "user"; includeResolved?: boolean; limit?: number },
	actor: AgentActorContext,
): ListAgentAttentionItemsV2Filters {
	const filters: ListAgentAttentionItemsV2Filters = {
		limit: params.limit,
		ownerKinds: attentionOwnerKindsForAudience(params.audience),
		states: params.includeResolved ? undefined : ["open", "acknowledged", "waiting_on_owner"],
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.subjectAgentIds = listHierarchyVisibleAgentIds(getMeepoDb(), actor, {
				spawnSessionId: ctx.sessionManager.getSessionId(),
				spawnSessionFile: ctx.sessionManager.getSessionFile(),
			});
			break;
		case "descendants":
			filters.subjectAgentIds = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export function attentionV2MatchesAudience(item: AgentAttentionV2Record, audience?: "all" | "coordinator" | "user"): boolean {
	if (audience === "user") return item.ownerKind === "user";
	if (audience === "coordinator") return item.ownerKind !== "user";
	return true;
}

export function legacyAttentionDuplicatesV2(item: AttentionItemRecord, v2MessageIds: Set<string>, v2RecipientRowIds: Set<string>): boolean {
	if (item.messageId && v2MessageIds.has(item.messageId)) return true;
	const payload = item.payload && typeof item.payload === "object" ? (item.payload as Record<string, unknown>) : null;
	const payloadV2MessageId = typeof payload?.v2MessageId === "string" ? payload.v2MessageId : null;
	const payloadV2RecipientRowId = typeof payload?.v2RecipientRowId === "string" ? payload.v2RecipientRowId : null;
	return !!((payloadV2MessageId && v2MessageIds.has(payloadV2MessageId)) || (payloadV2RecipientRowId && v2RecipientRowIds.has(payloadV2RecipientRowId)));
}

export function suppressDuplicateLegacyAttentionItems(legacyItems: AttentionItemRecord[], v2Items: AgentAttentionV2Record[]): AttentionItemRecord[] {
	const v2MessageIds = new Set(v2Items.map((item) => item.messageId).filter((value): value is string => Boolean(value)));
	const v2RecipientRowIds = new Set(v2Items.map((item) => item.recipientRowId).filter((value): value is string => Boolean(value)));
	if (v2MessageIds.size === 0 && v2RecipientRowIds.size === 0) return legacyItems;
	return legacyItems.filter((item) => !legacyAttentionDuplicatesV2(item, v2MessageIds, v2RecipientRowIds));
}

export function payloadRecord(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

export function payloadString(payload: unknown, key: string): string | null {
	const value = payloadRecord(payload)[key];
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function payloadStringArray(payload: unknown, key: string): string[] {
	const value = payloadRecord(payload)[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

export function taskInteractionKindFromAttention(
	kind: AttentionItemRecord["kind"] | AgentAttentionV2Record["kind"],
	ownerKind: AgentRecipientKind,
): TaskInteractionRecord["kind"] {
	switch (kind) {
		case "question_for_user":
			return "user_question";
		case "question":
			return ownerKind === "user" ? "user_question" : "coordinator_question";
		case "approval":
			return "approval_request";
		case "change_request":
			return "change_request";
		case "blocked":
			return "blocker";
		case "complete":
			return "completion";
		default:
			return "coordinator_question";
	}
}


export function buildTaskInteractionActions(
	kind: TaskInteractionRecord["kind"],
	taskId: string,
	agentId: string | null,
	messageId: string | null,
	options: { interactionId?: string; canMessageAgent?: boolean } = {},
): { nextAction: string; actions: string[] } {
	const replyRef = messageId ? ` inReplyToMessageId=${messageId}` : "";
	const resolveRef = options.interactionId ? ` resolveInteractionId=${options.interactionId}` : "";
	const noteAction = (summary: string, resolutionKind = "resolved") => `task_note id=${taskId} summary="${summary}"${resolveRef} resolutionKind=${resolutionKind}`;
	const canMessageAgent = Boolean(agentId && options.canMessageAgent);
	const childAnswer = canMessageAgent
		? `subagent_message id=${agentId} kind=answer summary="<answer>" actionPolicy=resume_if_blocked${replyRef}`
		: noteAction("Answer recorded");
	const childRedirect = canMessageAgent
		? `subagent_message id=${agentId} kind=redirect summary="<requested change>" actionPolicy=replan${replyRef}`
		: noteAction("Change requested", "changes_requested");
	const notifyApproval = canMessageAgent ? `; subagent_message id=${agentId} kind=answer summary="Approved" actionPolicy=resume_if_blocked${replyRef}` : "";
	const notifyRejection = canMessageAgent ? `; subagent_message id=${agentId} kind=redirect summary="Rejected" actionPolicy=replan${replyRef}` : "";
	const notifyChanges = canMessageAgent ? `; subagent_message id=${agentId} kind=redirect summary="Changes requested" actionPolicy=replan${replyRef}` : "";
	switch (kind) {
		case "user_question":
			return {
				nextAction: "answer user-facing question, then resume or acknowledge the child",
				actions: [`answer: ${childAnswer}`, `fallback: ${noteAction("User answer recorded")}`],
			};
		case "coordinator_question":
			return {
				nextAction: "answer coordinator question through the child control plane",
				actions: [`answer: ${childAnswer}`, `note-only fallback: ${noteAction("Coordinator answer recorded")}`],
			};
		case "blocker":
			return {
				nextAction: "unblock with an answer, redirect, or resolved task note",
				actions: [`unblock: ${childAnswer}`, `redirect: ${childRedirect}`, `fallback: ${noteAction("Blocker disposition")}`],
			};
		case "approval_request":
			return {
				nextAction: "approve, reject, or request changes; disposition the interaction with task_note so the card closes",
				actions: [
					`approve: ${noteAction("Approved", "approved")}${notifyApproval}`,
					`reject: ${noteAction("Rejected", "rejected")}${notifyRejection}`,
					`request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`,
				],
			};
		case "change_request":
			return {
				nextAction: "record requested changes and disposition the interaction",
				actions: [`request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`, `resolve: ${noteAction("Change request recorded")}`],
			};
		case "completion":
			return {
				nextAction: "review handoff, then accept or request changes; task_note closes the completion card even for terminal agents",
				actions: [`approve: ${noteAction("Completion accepted", "approved")}`, `request-changes: ${noteAction("Changes requested", "changes_requested")}${notifyChanges}`],
			};
		default:
			return { nextAction: "triage interaction", actions: [`note: ${noteAction("Interaction triaged")}`] };
	}
}

export function taskInteractionFromLegacyAttention(item: AttentionItemRecord, agent: AgentSummary | undefined): TaskInteractionRecord | null {
	const taskId = agent?.taskId ?? null;
	if (!taskId) return null;
	const ownerKind: AgentRecipientKind = item.audience === "user" ? "user" : "root";
	const messageId = payloadString(item.payload, "v2MessageId") ?? item.messageId;
	const recipientRowId = payloadString(item.payload, "v2RecipientRowId");
	const kind = taskInteractionKindFromAttention(item.kind, ownerKind);
	const interactionId = `legacy:${item.id}`;
	const actionInfo = buildTaskInteractionActions(kind, taskId, item.agentId, messageId, {
		interactionId,
		canMessageAgent: Boolean(agent && !TERMINAL_AGENT_STATES.includes(agent.state)),
	});
	return {
		id: interactionId,
		source: "legacy_attention",
		sourceId: item.id,
		taskId,
		agentId: item.agentId,
		actorLabel: actorLabelForInteraction(agent, item.agentId),
		ownerKind,
		ownerAgentId: null,
		kind,
		state: item.state,
		priority: item.priority,
		summary: item.summary,
		details: payloadString(item.payload, "details"),
		answerNeeded: payloadString(item.payload, "answerNeeded"),
		recommendedNextAction: payloadString(item.payload, "recommendedNextAction"),
		files: payloadStringArray(item.payload, "files"),
		messageId,
		recipientRowId,
		nextAction: actionInfo.nextAction,
		actions: actionInfo.actions,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

export function taskInteractionFromAgentAttentionV2(item: AgentAttentionV2Record, agentsById: Map<string, AgentSummary>): TaskInteractionRecord | null {
	const subject = item.subjectAgentId ? agentsById.get(item.subjectAgentId) : undefined;
	const taskId = item.taskId ?? subject?.taskId ?? null;
	if (!taskId) return null;
	const kind = taskInteractionKindFromAttention(item.kind, item.ownerKind);
	const interactionId = `v2:${item.id}`;
	const actionInfo = buildTaskInteractionActions(kind, taskId, item.subjectAgentId, item.messageId, {
		interactionId,
		canMessageAgent: Boolean(subject && !TERMINAL_AGENT_STATES.includes(subject.state)),
	});
	return {
		id: interactionId,
		source: "hierarchy_attention",
		sourceId: item.id,
		taskId,
		agentId: item.subjectAgentId,
		actorLabel: actorLabelForInteraction(subject, item.subjectAgentId),
		ownerKind: item.ownerKind,
		ownerAgentId: item.ownerAgentId,
		kind,
		state: item.state,
		priority: item.priority,
		summary: item.summary,
		details: payloadString(item.payload, "details"),
		answerNeeded: payloadString(item.payload, "answerNeeded"),
		recommendedNextAction: payloadString(item.payload, "recommendedNextAction"),
		files: payloadStringArray(item.payload, "files"),
		messageId: item.messageId,
		recipientRowId: item.recipientRowId,
		nextAction: actionInfo.nextAction,
		actions: actionInfo.actions,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
	};
}

export function addTaskInteraction(result: Map<string, TaskInteractionRecord[]>, interaction: TaskInteractionRecord | null, taskIds?: Set<string>): void {
	if (!interaction) return;
	if (taskIds && !taskIds.has(interaction.taskId)) return;
	const existing = result.get(interaction.taskId) ?? [];
	existing.push(interaction);
	result.set(interaction.taskId, existing);
}

export function sortTaskInteractionsByPriority(items: TaskInteractionRecord[]): TaskInteractionRecord[] {
	return [...items].sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt || left.createdAt - right.createdAt);
}

export function buildTaskInteractionsByTask(
	legacyItems: AttentionItemRecord[],
	v2Items: AgentAttentionV2Record[],
	agentsById: Map<string, AgentSummary>,
	taskIds?: Set<string>,
): Map<string, TaskInteractionRecord[]> {
	const result = new Map<string, TaskInteractionRecord[]>();
	for (const item of v2Items) {
		addTaskInteraction(result, taskInteractionFromAgentAttentionV2(item, agentsById), taskIds);
	}
	for (const item of suppressDuplicateLegacyAttentionItems(legacyItems, v2Items)) {
		addTaskInteraction(result, taskInteractionFromLegacyAttention(item, agentsById.get(item.agentId)), taskIds);
	}
	for (const [taskId, interactions] of result.entries()) {
		result.set(taskId, sortTaskInteractionsByPriority(interactions));
	}
	return result;
}

export function mergeAgentAttentionV2Items(...groups: AgentAttentionV2Record[][]): AgentAttentionV2Record[] {
	const byId = new Map<string, AgentAttentionV2Record>();
	for (const group of groups) {
		for (const item of group) byId.set(item.id, item);
	}
	return [...byId.values()];
}

export function listTaskInteractionsForTaskIds(taskIds: string[]): Map<string, TaskInteractionRecord[]> {
	if (taskIds.length === 0) return new Map();
	const db = getMeepoDb();
	const links = listTaskAgentLinks(db, { taskIds, limit: Math.max(1, Math.min(taskIds.length * 50, 500)) });
	const agentIds = Array.from(new Set(links.map((link) => link.agentId)));
	const agents = agentIds.length > 0 ? listAgents(db, { ids: agentIds, limit: agentIds.length }) : [];
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const legacyItems = agentIds.length > 0 ? listAttentionItems(db, { agentIds, states: OPEN_ATTENTION_STATES, limit: 500 }) : [];
	const directV2Items = listAgentAttentionItemsV2(db, { taskIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 });
	const subjectV2Items = agentIds.length > 0
		? listAgentAttentionItemsV2(db, { subjectAgentIds: agentIds, states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 })
		: [];
	return buildTaskInteractionsByTask(legacyItems, mergeAgentAttentionV2Items(directV2Items, subjectV2Items), agentsById, new Set(taskIds));
}

export function getTaskInteractions(taskId: string): TaskInteractionRecord[] {
	return listTaskInteractionsForTaskIds([taskId]).get(taskId) ?? [];
}


export function resolvedInteractionState(resolutionKind: string): "resolved" | "superseded" | "cancelled" {
	if (resolutionKind === "cancelled") return "cancelled";
	if (["rejected", "changes_requested", "superseded"].includes(resolutionKind)) return "superseded";
	return "resolved";
}

export function sqlPlaceholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

export function resolveTaskInteractionWithNote(taskId: string, interactionId: string, resolutionKind: string, resolutionSummary: string): { source: "legacy" | "v2"; changes: number } {
	const [source, ...rest] = interactionId.split(":");
	const sourceId = rest.join(":");
	if (!sourceId || (source !== "legacy" && source !== "v2")) {
		throw new Error(`Invalid task interaction id \"${interactionId}\". Expected legacy:<id> or v2:<id>.`);
	}
	const db = getMeepoDb();
	const now = Date.now();
	const state = resolvedInteractionState(resolutionKind);
	if (source === "legacy") {
		const result = db.prepare(
			`UPDATE attention_items
			 SET state = ?, updated_at = ?, resolved_at = ?, resolution_kind = ?, resolution_summary = ?
			 WHERE id = ?
				AND state IN (${sqlPlaceholders(OPEN_ATTENTION_STATES.length)})
				AND agent_id IN (SELECT id FROM agents WHERE task_id = ?)`,
		).run(state, now, now, resolutionKind, resolutionSummary, sourceId, ...OPEN_ATTENTION_STATES, taskId) as { changes?: number };
		return { source, changes: Number(result.changes ?? 0) };
	}
	const result = db.prepare(
		`UPDATE agent_attention_items_v2
		 SET state = ?, updated_at = ?, resolved_at = ?, resolution_kind = ?, resolution_summary = ?
		 WHERE id = ?
			AND state IN (${sqlPlaceholders(OPEN_AGENT_ATTENTION_V2_STATES.length)})
			AND (task_id = ? OR subject_agent_id IN (SELECT id FROM agents WHERE task_id = ?))`,
	).run(state, now, now, resolutionKind, resolutionSummary, sourceId, ...OPEN_AGENT_ATTENTION_V2_STATES, taskId, taskId) as { changes?: number };
	return { source, changes: Number(result.changes ?? 0) };
}



