/**
 * Coordinator session state: active runtime, last-focused Child, fleet UI chrome.
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
import { attentionItemFromV2 } from "./attention.js";
import { listOpenAttention } from "./inbox.js";
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
export let lastFocusedActiveAgentId: string | undefined;
export function setLastFocusedActiveAgentId(id: string | undefined): void {
	lastFocusedActiveAgentId = id;
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
	const { v2, leftover } = listOpenAttention(db, {
		legacy: resolveAttentionFilters(ctx, "current_session", {
			states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
			limit: 4,
		}),
	});
	const attentionItems = [...v2.map(attentionItemFromV2), ...leftover];
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


