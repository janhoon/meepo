/**
 * Board: Tasks + Children + Attention projected into an operator view.
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
import { getProcessHost, hostHandleFromRecord } from "./process-host.js";
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
import {
	buildTaskInteractionsByTask,
	mergeAgentAttentionV2Items,
	resolveAdminAttentionV2Filters,
} from "./task-interactions.js";
import {
	resolveAgentFilters,
	resolveAttentionFilters,
	resolveTaskFilters,
} from "./session-scope.js";

/** Active Meepo config for this extension process (set on register). */
export async function focusAgentById(id: string): Promise<{ agent: AgentSummary; result: { focused: boolean; command: string; reason?: string } }> {
	const agent = getAgent(getMeepoDb(), id);
	if (!agent) {
		throw new Error(`Unknown agent id "${id}".`);
	}
	const result = await getProcessHost().focus(hostHandleFromRecord(agent));
	return { agent, result };
}

export async function captureAgentById(id: string, lines = 200): Promise<{ agent: AgentSummary; content: string; command: string }> {
	const agent = getAgent(getMeepoDb(), id);
	if (!agent) {
		throw new Error(`Unknown agent id "${id}".`);
	}
	const host = getProcessHost();
	const target = hostHandleFromRecord(agent);
	if (!(await host.targetExists(target))) {
		throw new Error(`Cannot capture agent ${agent.id} because its host target is missing. Reconcile first.`);
	}
	const result = await host.capture(target, { lines });
	return { agent, content: result.content, command: result.command };
}

export function buildDashboardData(ctx: ExtensionContext): AgentsDashboardData {
	const db = getMeepoDb();
	// Agent scopes only via resolveAgentFilters — no hand-rolled owned* locals.
	// current_project ≡ current_session owned ids; projectKey pin is the only builder difference.
	const all = listAgents(db, { limit: 200 });
	const currentProject = listAgents(db, resolveAgentFilters(ctx, "current_project", { limit: 200 }));
	const currentSession = listAgents(db, resolveAgentFilters(ctx, "current_session", { limit: 200 }));
	const descendants = listAgents(db, resolveAgentFilters(ctx, "descendants", { limit: 200 }));
	const childrenByParent = new Map<string, string[]>();
	for (const agent of all) {
		if (!agent.parentAgentId) continue;
		const children = childrenByParent.get(agent.parentAgentId) ?? [];
		children.push(agent.id);
		childrenByParent.set(agent.parentAgentId, children);
	}
	for (const [parent, children] of childrenByParent.entries()) {
		childrenByParent.set(parent, children.sort());
	}
	return {
		scopes: {
			all,
			current_project: currentProject,
			current_session: currentSession,
			descendants,
		},
		childrenByParent,
	};
}

export function boardLaneForTask(task: TaskRecord): BoardLaneId {
	return task.status;
}

export function buildBoardScopeData(
	tasks: TaskRecord[],
	agents: AgentSummary[],
	attentionItems: AttentionItemRecord[],
	v2AttentionItems: AgentAttentionV2Record[] = [],
): AgentsBoardData["scopes"]["all"] {
	const db = getMeepoDb();
	const taskIds = tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const links = listTaskAgentLinks(db, { taskIds, limit: 500 });
	const linkRoleByTaskAgent = new Map(links.map((link) => [`${link.taskId}:${link.agentId}`, link.role] as const));
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const agentsByTaskId = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (!agent) continue;
		const existing = agentsByTaskId.get(link.taskId) ?? [];
		existing.push(agent);
		agentsByTaskId.set(link.taskId, existing);
	}
	const interactionsByTaskId = buildTaskInteractionsByTask(attentionItems, v2AttentionItems, agentsById, taskIdSet);
	const healthByTaskId = listTaskHealth(db, tasks);
	const openAttentionCounts = new Map<string, number>();
	for (const [taskId, interactions] of interactionsByTaskId.entries()) {
		openAttentionCounts.set(taskId, interactions.length);
	}
	const lanes: Record<BoardLaneId, BoardTicket[]> = {
		todo: [],
		blocked: [],
		in_progress: [],
		in_review: [],
		done: [],
	};
	const tasksById = new Map<string, TaskRecord>();
	for (const task of tasks) {
		tasksById.set(task.id, task);
		const linkedAgents = agentsByTaskId.get(task.id) ?? [];
		const activeLinkedAgents = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state));
		const activeExclusiveOwners = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "exclusive");
		const activeReviewers = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "review");
		const activeAgentCount = activeLinkedAgents.length;
		const linkedProfiles = Array.from(new Set(linkedAgents.map((agent) => agent.profile))).sort();
		const laneId = boardLaneForTask(task);
		const openAttentionCount = openAttentionCounts.get(task.id) ?? 0;
		const ticket: BoardTicket = {
			taskId: task.id,
			laneId,
			title: task.title,
			priority: task.priority,
			priorityLabel: task.priorityLabel,
			waitingOn: task.waitingOn,
			blockedReason: task.blockedReason,
			updatedAt: task.updatedAt,
			activeAgentCount,
			exclusiveOwnerCount: activeExclusiveOwners.length,
			reviewerCount: activeReviewers.length,
			ownerAgentIds: activeExclusiveOwners.map((agent) => agent.id),
			linkedProfiles,
			openAttentionCount,
			health: healthByTaskId.get(task.id) ?? deriveTaskHealth({ task, activeAgentCount, linkedAgentCount: linkedAgents.length, openAttentionCount }),
			summary: task.blockedReason ?? task.reviewSummary ?? task.summary ?? task.finalSummary ?? task.description ?? "-",
		};
		lanes[laneId].push(ticket);
	}
	for (const laneId of Object.keys(lanes) as BoardLaneId[]) {
		lanes[laneId].sort(
			(left, right) =>
				right.openAttentionCount - left.openAttentionCount ||
				(left.waitingOn === "user" ? -1 : 0) - (right.waitingOn === "user" ? -1 : 0) ||
				left.priority - right.priority ||
				right.updatedAt - left.updatedAt,
		);
	}
	return { lanes, tasksById, agentsByTaskId, interactionsByTaskId };
}

export function buildBoardData(ctx: ExtensionContext): AgentsBoardData {
	const db = getMeepoDb();
	const projectKey = getProjectKey(ctx.cwd);
	// Tasks stay ambient (project/session columns). Agent + attention scopes only via resolve*Filters.
	// current_project ≡ current_session owned subject ids on agent surfaces — no dual hand-rolled lists.
	const scopeTasks = {
		all: listTasks(db, { includeDone: true, limit: 200 }),
		current_project: listTasks(db, { projectKey, includeDone: true, limit: 200 }),
		current_session: listTasks(db, {
			spawnSessionId: ctx.sessionManager.getSessionId(),
			spawnSessionFile: ctx.sessionManager.getSessionFile(),
			includeDone: true,
			limit: 200,
		}),
		descendants: listTasks(db, resolveTaskFilters(ctx, "descendants", { includeDone: true, limit: 200 })),
	};
	const scopeAgents = {
		all: listAgents(db, { limit: 200 }),
		current_project: listAgents(db, resolveAgentFilters(ctx, "current_project", { limit: 200 })),
		current_session: listAgents(db, resolveAgentFilters(ctx, "current_session", { limit: 200 })),
		descendants: listAgents(db, resolveAgentFilters(ctx, "descendants", { limit: 200 })),
	};
	const scopeAttention = {
		all: listAttentionItems(db, { states: OPEN_ATTENTION_STATES, limit: 500 }),
		current_project: listAttentionItems(db, resolveAttentionFilters(ctx, "current_project", { limit: 500 })),
		current_session: listAttentionItems(db, resolveAttentionFilters(ctx, "current_session", { limit: 500 })),
		descendants: listAttentionItems(db, resolveAttentionFilters(ctx, "descendants", { limit: 500 })),
	};
	const scopeAttentionV2 = {
		all: listAgentAttentionItemsV2(db, { states: OPEN_AGENT_ATTENTION_V2_STATES, limit: 500 }),
		current_project: listAgentAttentionItemsV2(db, resolveAdminAttentionV2Filters(ctx, "current_project", { limit: 500 })),
		current_session: listAgentAttentionItemsV2(db, resolveAdminAttentionV2Filters(ctx, "current_session", { limit: 500 })),
		descendants: listAgentAttentionItemsV2(db, resolveAdminAttentionV2Filters(ctx, "descendants", { limit: 500 })),
	};
	return {
		scopes: {
			all: buildBoardScopeData(scopeTasks.all, scopeAgents.all, scopeAttention.all, scopeAttentionV2.all),
			current_project: buildBoardScopeData(scopeTasks.current_project, scopeAgents.current_project, scopeAttention.current_project, scopeAttentionV2.current_project),
			current_session: buildBoardScopeData(scopeTasks.current_session, scopeAgents.current_session, scopeAttention.current_session, scopeAttentionV2.current_session),
			descendants: buildBoardScopeData(scopeTasks.descendants, scopeAgents.descendants, scopeAttention.descendants, scopeAttentionV2.descendants),
		},
	};
}

