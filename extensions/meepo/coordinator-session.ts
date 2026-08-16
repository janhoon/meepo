/**
 * coordinator-session — split from coordinator-helpers.
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
import {
	ACTIVE_AGENT_STATES,
	OPEN_AGENT_ATTENTION_V2_STATES,
	OPEN_ATTENTION_STATES,
	TERMINAL_AGENT_STATES,
} from "./registry-shared.js";
export {
	ACTIVE_AGENT_STATES,
	OPEN_AGENT_ATTENTION_V2_STATES,
	OPEN_ATTENTION_STATES,
	TERMINAL_AGENT_STATES,
};

/** Active Meepo config for this extension process (set on register). */
export let activeMeepoRuntime: MeepoRuntime | null = null;

export function setActiveMeepoRuntime(runtime: MeepoRuntime | null): void {
	activeMeepoRuntime = runtime;
}

// Single session-scope import (local use + re-export for direct coordinator-session importers).
// coordinator-helpers barrels session-scope first; keep these re-exports only for direct imports.
import {
	applyHierarchyVisibilityToAgentFilters,
	assertDirectory,
	childRuntimeEnvironment,
	computeParentOwnedAgentIds,
	getLinkedChildIds,
	getParentOwnedAgentIds,
	getVisibleAgentIdsForTool,
	resolveAgentFilters,
	resolveAttentionFilters,
	resolveInputPath,
	resolveOwnedSubjectIds,
	resolveOwnedSubjectIdsFromParts,
	resolveRootInboxSenderIds,
	resolveTaskFilters,
	resolveToolActorContext,
	ROOT_SURFACE_OWNER_KINDS,
	sortTasksForList,
	withOwnedSubjectPin,
} from "./session-scope.js";
export {
	applyHierarchyVisibilityToAgentFilters,
	assertDirectory,
	childRuntimeEnvironment,
	computeParentOwnedAgentIds,
	getLinkedChildIds,
	getParentOwnedAgentIds,
	getVisibleAgentIdsForTool,
	resolveAgentFilters,
	resolveAttentionFilters,
	resolveInputPath,
	resolveOwnedSubjectIds,
	resolveOwnedSubjectIdsFromParts,
	resolveRootInboxSenderIds,
	resolveTaskFilters,
	resolveToolActorContext,
	ROOT_SURFACE_OWNER_KINDS,
	sortTasksForList,
	withOwnedSubjectPin,
};
import { resolveAdminAttentionV2Filters, suppressDuplicateLegacyAttentionItems } from "./task-interactions.js";

export const ATTENTION_WAKE_POLL_MS = 2000;
export let lastFocusedActiveAgentId: string | undefined;
export function setLastFocusedActiveAgentId(id: string | undefined): void {
	lastFocusedActiveAgentId = id;
}
export let attentionWakePoll: ReturnType<typeof setInterval> | undefined;
export function setAttentionWakePoll(timer: ReturnType<typeof setInterval> | undefined): void {
	attentionWakePoll = timer;
}
export const sentCoordinatorAttentionIds = new Set<string>();
export const notifiedUserAttentionIds = new Set<string>();
/** Attention item ids that already triggered a ProcessHost toast (herdr). */
export const hostNotifiedAttentionIds = new Set<string>();


export function attentionItemFromV2(item: AgentAttentionV2Record): AttentionItemRecord {
	return {
		id: item.id,
		messageId: item.messageId,
		agentId: item.subjectAgentId ?? "unknown",
		threadId: item.subjectAgentId ?? item.id,
		projectKey: item.projectKey,
		spawnSessionId: null,
		spawnSessionFile: null,
		audience: item.ownerKind === "user" ? "user" : "coordinator",
		kind: (item.kind === "approval" || item.kind === "change_request" ? "question" : item.kind) as AttentionItemRecord["kind"],
		priority: item.priority,
		state:
			item.state === "waiting_on_owner"
				? item.ownerKind === "user"
					? "waiting_on_user"
					: "waiting_on_coordinator"
				: (item.state as AttentionItemRecord["state"]),
		summary: item.summary,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		resolvedAt: item.resolvedAt,
		resolutionKind: item.resolutionKind,
		resolutionSummary: item.resolutionSummary,
	};
}

export async function wakeCoordinatorFromAttention(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	// Child sessions (including mid-level parents) must not consume root attention.
	// Parent-agent delivery is 1:1 via recipient_agent_id + RPC bridge.
	if (childRuntimeEnvironment) return;
	const db = getMeepoDb();
	// Same filter builders as subagent_attention / board — states passed in (no post-hoc bag mutation).
	const v2Filters = resolveAdminAttentionV2Filters(ctx, "current_session", {
		limit: 25,
		states: ["open", "acknowledged", "waiting_on_owner"],
	});
	if (v2Filters.subjectAgentIds && v2Filters.subjectAgentIds.length === 0) return;
	const v2Items = listAgentAttentionItemsV2(db, v2Filters);
	const legacyFilters = resolveAttentionFilters(ctx, "current_session", {
		limit: 25,
		states: ["open", "waiting_on_coordinator", "waiting_on_user"],
	});
	const legacyItems = suppressDuplicateLegacyAttentionItems(listAttentionItems(db, legacyFilters), v2Items);
	const items = [...v2Items.map(attentionItemFromV2), ...legacyItems].sort(
		(a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
	);
	if (items.length === 0) return;
	// Prefer subject pin from the shared filter builders; never fall open to fleet-wide agent lookup.
	const ownedSubjectIds = v2Filters.subjectAgentIds ?? legacyFilters.agentIds ?? [];
	const agents = new Map(
		(ownedSubjectIds.length > 0
			? listAgents(db, { ids: ownedSubjectIds, limit: Math.max(ownedSubjectIds.length, 1) })
			: []
		).map((agent) => [agent.id, agent]),
	);

	for (const item of items) {
		const agent = agents.get(item.agentId);
		if (!hostNotifiedAttentionIds.has(item.id)) {
			hostNotifiedAttentionIds.add(item.id);
			void maybeNotifyHostAttention({
				kind: item.kind,
				agentId: item.agentId,
				summary: item.summary,
				displayName: agent?.hostDisplayName ?? agent?.title ?? null,
			}).catch(() => {});
		}
		if (item.audience === "user") {
			if (notifiedUserAttentionIds.has(item.id)) continue;
			try {
				ctx.ui.notify(`${attentionItemIcon(item)} ${agent?.title ?? item.agentId} · ${item.summary}`, item.kind === "question_for_user" ? "warning" : "info");
				notifiedUserAttentionIds.add(item.id);
			} catch (error) {
				notifiedUserAttentionIds.delete(item.id);
				throw error;
			}
			continue;
		}
		if (sentCoordinatorAttentionIds.has(item.id)) continue;
		sentCoordinatorAttentionIds.add(item.id);
		const content = formatAttentionWakeup(item, agent);
		try {
			if (ctx.isIdle()) {
				await pi.sendUserMessage(content);
			} else {
				await pi.sendUserMessage(content, { deliverAs: item.kind === "complete" ? "followUp" : "steer" });
			}
		} catch (error) {
			sentCoordinatorAttentionIds.delete(item.id);
			throw error;
		}
		break;
	}
}

export function updateFleetUi(ctx: ExtensionContext): void {
	const db = getMeepoDb();
	const projectKey = getProjectKey(ctx.cwd);
	const taskSummary = getTaskSummary(db, { projectKey });
	const agentSummary = getFleetSummary(db, { projectKey });
	ctx.ui.setStatus("meepo", formatFleetSummary(taskSummary, agentSummary));
	const taskItems = listTaskAttention(db, { projectKey, limit: 4 });
	if (taskItems.length > 0) {
		ctx.ui.setWidget(
			"meepo",
			taskItems.map((item) => `${item.health === "stale" || item.health === "empty_or_no_progress" ? "⚠" : item.status === "blocked" ? "⛔" : "◍"} ${truncateText(item.title, 32)} · ${item.status} · health=${item.health}${item.waitingOn ? ` · ${item.waitingOn}` : ""}`),
		);
		return;
	}
	// Status chrome is ownership-pinned — never ambient project-wide children from other sessions.
	const attentionItems = listAttentionItems(
		db,
		resolveAttentionFilters(ctx, "current_session", {
			states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
			limit: 4,
		}),
	);
	if (attentionItems.length === 0) {
		ctx.ui.setWidget("meepo", undefined);
		return;
	}
	const agents = new Map(
		listAgents(db, resolveAgentFilters(ctx, "current_session", { limit: 100 })).map((agent) => [agent.id, agent]),
	);
	const lines = attentionItems.map((item) => {
		const agent = agents.get(item.agentId);
		const title = agent ? truncateText(agent.title, 34) : item.agentId;
		return `${attentionItemIcon(item)} ${title} · ${attentionItemLabel(item)} · ${item.agentId}`;
	});
	ctx.ui.setWidget("meepo", lines);
}


