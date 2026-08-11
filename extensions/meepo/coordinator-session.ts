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
import { truncateText } from "./text-util.js";


/** Active Meepo config for this extension process (set on register). */
export let activeMeepoRuntime: MeepoRuntime | null = null;

export function setActiveMeepoRuntime(runtime: MeepoRuntime | null): void {
	activeMeepoRuntime = runtime;
}

export const childRuntimeEnvironment = getChildRuntimeEnvironment();
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


export function resolveInputPath(baseDir: string, rawPath: string | undefined): string {
	const normalized = (rawPath ?? baseDir).replace(/^@/, "");
	return resolve(baseDir, normalized);
}

export function assertDirectory(path: string): void {
	let stats;
	try {
		stats = statSync(path);
	} catch {
		throw new Error(`Working directory does not exist: ${path}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`Working directory is not a directory: ${path}`);
	}
}



export function sortTasksForList(tasks: TaskRecord[], sort: "priority" | "updated" | "created" | "title" | "status"): TaskRecord[] {
	return [...tasks].sort((left, right) => {
		switch (sort) {
			case "updated":
				return right.updatedAt - left.updatedAt;
			case "created":
				return right.createdAt - left.createdAt;
			case "title":
				return left.title.localeCompare(right.title) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "status":
				return left.status.localeCompare(right.status) || left.priority - right.priority || right.updatedAt - left.updatedAt;
			case "priority":
			default:
				return left.priority - right.priority || right.updatedAt - left.updatedAt;
		}
	});
}


export function getLinkedChildIds(ctx: ExtensionContext): string[] {
	const ids = new Set<string>();
	for (const entry of ctx.sessionManager.getEntries() as Array<
		{ type?: string; customType?: string; data?: SessionChildLinkEntryData | undefined }
	>) {
		if (
			entry.type !== "custom" ||
			(entry.customType !== SESSION_CHILD_LINK_ENTRY_TYPE &&
				entry.customType !== LEGACY_SESSION_CHILD_LINK_ENTRY_TYPE)
		) {
			continue;
		}
		const childId = entry.data?.childId;
		if (typeof childId === "string" && childId.length > 0) {
			ids.add(childId);
		}
	}
	return [...ids];
}

export function resolveToolActorContext(ctx: ExtensionContext): AgentActorContext {
	const db = getMeepoDb();
	if (childRuntimeEnvironment) {
		return resolveAgentActorContext(db, { currentAgentId: childRuntimeEnvironment.childId });
	}
	return createRootActorContext({
		projectKey: getProjectKey(ctx.cwd),
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

export function applyHierarchyVisibilityToAgentFilters(ctx: ExtensionContext, filters: ListAgentsFilters): ListAgentsFilters {
	if (!childRuntimeEnvironment) return filters;
	const db = getMeepoDb();
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return filters;
	let requestedIds: string[] | undefined = filters.ids;
	if (filters.descendantOf) {
		requestedIds = listDescendantAgentIds(db, filters.descendantOf);
	}
	const visibleIds = listHierarchyVisibleAgentIds(db, actor, {
		projectKey: filters.projectKey,
		spawnSessionId: filters.spawnSessionId,
		spawnSessionFile: filters.spawnSessionFile,
	});
	const visibleSet = new Set(visibleIds);
	const ids = requestedIds ? requestedIds.filter((id) => visibleSet.has(id)) : visibleIds;
	return { ...filters, ids, descendantOf: undefined };
}

export function getVisibleAgentIdsForTool(ctx: ExtensionContext, requestedIds?: string[]): string[] | null {
	if (!childRuntimeEnvironment) return requestedIds ?? null;
	const actor = resolveToolActorContext(ctx);
	if (actor.kind === "root") return requestedIds ?? null;
	const visibleIds = listHierarchyVisibleAgentIds(getMeepoDb(), actor, { projectKey: getProjectKey(ctx.cwd) });
	if (!requestedIds) return visibleIds;
	const visibleSet = new Set(visibleIds);
	return requestedIds.filter((id) => visibleSet.has(id));
}

export function resolveAgentFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { activeOnly?: boolean; blockedOnly?: boolean; unreadOnly?: boolean; limit?: number },
): ListAgentsFilters {
	const filters: ListAgentsFilters = {
		activeOnly: params.activeOnly,
		blockedOnly: params.blockedOnly,
		unreadOnly: params.unreadOnly,
		limit: params.limit,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants":
			filters.descendantOf = getLinkedChildIds(ctx);
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export function resolveTaskFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
	params: { statuses?: TaskState[]; waitingOn?: TaskWaitingOn[]; recommendedProfile?: string; includeDone?: boolean; limit?: number; linkedAgentId?: string },
): ListTasksFilters {
	const filters: ListTasksFilters = {
		statuses: params.statuses,
		waitingOn: params.waitingOn,
		recommendedProfile: params.recommendedProfile,
		includeDone: params.includeDone,
		limit: params.limit,
		linkedAgentId: params.linkedAgentId,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "descendants": {
			const ids = getLinkedChildIds(ctx);
			if (ids.length === 0) {
				filters.ids = [];
				break;
			}
			const db = getMeepoDb();
			const taskIds = Array.from(new Set(listAgents(db, { ids, limit: 500 }).map((agent) => agent.taskId).filter((value): value is string => Boolean(value))));
			filters.ids = taskIds;
			break;
		}
		case "all":
		default:
			break;
	}
	return filters;
}


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
	if (childRuntimeEnvironment) return;
	const db = getMeepoDb();
	const projectKey = getProjectKey(ctx.cwd);
	const v2Items = listAgentAttentionItemsV2(db, {
		projectKey,
		states: ["open", "acknowledged", "waiting_on_owner"],
		limit: 25,
	});
	const legacyItems = suppressDuplicateLegacyAttentionItems(
		listAttentionItems(db, {
			projectKey,
			states: ["open", "waiting_on_coordinator", "waiting_on_user"],
			limit: 25,
		}),
		v2Items,
	);
	const items = [...v2Items.map(attentionItemFromV2), ...legacyItems].sort(
		(a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
	);
	if (items.length === 0) return;
	const agents = new Map(listAgents(db, { projectKey, limit: 200 }).map((agent) => [agent.id, agent]));

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
	const attentionItems = listAttentionItems(db, {
		projectKey,
		states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
		limit: 4,
	});
	if (attentionItems.length === 0) {
		ctx.ui.setWidget("meepo", undefined);
		return;
	}
	const agents = new Map(listAgents(db, { projectKey, limit: 100 }).map((agent) => [agent.id, agent]));
	const lines = attentionItems.map((item) => {
		const agent = agents.get(item.agentId);
		const title = agent ? truncateText(agent.title, 34) : item.agentId;
		return `${attentionItemIcon(item)} ${title} · ${attentionItemLabel(item)} · ${item.agentId}`;
	});
	ctx.ui.setWidget("meepo", lines);
}

export const OPEN_ATTENTION_STATES: AttentionItemRecord["state"][] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];
export const OPEN_AGENT_ATTENTION_V2_STATES: AgentAttentionV2Record["state"][] = ["open", "acknowledged", "waiting_on_owner"];
export const ACTIVE_AGENT_STATES: AgentSummary["state"][] = ["launching", "running", "idle", "waiting", "blocked"];
export const TERMINAL_AGENT_STATES: AgentSummary["state"][] = ["done", "error", "stopped", "lost"];




