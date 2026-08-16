/**
 * spawn-ops — split from coordinator-helpers.
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
import { activeMeepoRuntime, updateFleetUi } from "./coordinator-session.js";
import {
	assertDirectory,
	childRuntimeEnvironment,
	resolveInputPath,
	resolveTaskFilters,
	resolveToolActorContext,
} from "./session-scope.js";

/** Active Meepo config for this extension process (set on register). */
export function requireProfile(profileName: string): SubagentProfile {
	const profile = getSubagentProfile(profileName);
	if (profile) return profile;
	const names = listSubagentProfiles().map((item) => item.name);
	const available = names.join(", ") || "(none)";
	const byoHint =
		names.length === 0
			? " Meepo does not ship agent profiles — add markdown under ~/.pi/agent/agents/ or set profiles.dirs to your agent pack."
			: "";
	throw new Error(`Unknown subagent profile "${profileName}". Available profiles: ${available}.${byoHint}`);
}

export function createTaskFromParams(ctx: ExtensionContext, params: {
	title: string;
	summary?: string;
	description?: string;
	cwd?: string;
	parentTaskId?: string;
	priority?: number;
	priorityLabel?: string;
	recommendedProfile?: string;
	acceptanceCriteria?: string[];
	planSteps?: string[];
	validationSteps?: string[];
	labels?: string[];
	files?: string[];
	status?: TaskState;
	blockedReason?: string;
	waitingOn?: TaskWaitingOn;
}): TaskRecord {
	const db = getMeepoDb();
	const now = Date.now();
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	const taskId = `task_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
	const input: CreateTaskInput = {
		id: taskId,
		parentTaskId: params.parentTaskId?.trim() || null,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
		spawnCwd,
		projectKey: getProjectKey(spawnCwd),
		title: params.title.trim(),
		summary: params.summary?.trim() || null,
		description: params.description?.trim() || null,
		status: params.status ?? "todo",
		priority: params.priority ?? 3,
		priorityLabel: params.priorityLabel?.trim() || null,
		recommendedProfile: params.recommendedProfile?.trim() || null,
		waitingOn: params.waitingOn,
		blockedReason: params.blockedReason?.trim() || null,
		acceptanceCriteria: params.acceptanceCriteria,
		planSteps: params.planSteps,
		validationSteps: params.validationSteps,
		labels: params.labels,
		files: params.files,
		createdAt: now,
		updatedAt: now,
		startedAt: params.status === "in_progress" ? now : null,
		reviewRequestedAt: params.status === "in_review" ? now : null,
		finishedAt: params.status === "done" ? now : null,
	};
	createTask(db, input);
	createTaskEvent(db, {
		id: randomUUID(),
		taskId,
		eventType: "created",
		summary: `Created task ${input.title}`,
		payload: {
			summary: input.summary,
			status: input.status,
			priority: input.priority,
			recommendedProfile: input.recommendedProfile ?? null,
		},
		createdAt: now,
	});
	return getTask(db, taskId)!;
}

export function ensureTaskForSpawn(ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	cwd?: string;
	taskId?: string;
	priority?: string;
	allowDuplicateOwner?: boolean;
}): TaskRecord {
	const db = getMeepoDb();
	const existingTaskId = params.taskId?.trim() || null;
	if (existingTaskId) {
		const task = getTask(db, existingTaskId);
		if (!task) throw new Error(`Unknown task id \"${existingTaskId}\".`);
		const unresolved = listUnresolvedTaskDependencies(db, [existingTaskId]).get(existingTaskId) ?? [];
		if (unresolved.length > 0) {
			throw new Error(`Task ${existingTaskId} has unresolved dependencies: ${unresolved.map((link) => link.targetTaskId).join(", ")}. Do not spawn an agent for this ticket until dependencies resolve.`);
		}
		assertTaskLeaseAvailable(db, {
			taskId: existingTaskId,
			profile: params.profile,
			allowDuplicateOwner: params.allowDuplicateOwner,
		});
		const now = Date.now();
		const requestedLeaseKind = taskLeaseKindForProfile(params.profile);
		const status: TaskState = requestedLeaseKind === "review" && task.status === "in_review" ? "in_review" : "in_progress";
		updateTask(db, existingTaskId, {
			status,
			waitingOn: null,
			blockedReason: null,
			updatedAt: now,
			startedAt: status === "in_progress" ? task.startedAt ?? now : task.startedAt,
			reviewRequestedAt: status === "in_review" ? task.reviewRequestedAt ?? now : task.reviewRequestedAt,
		});
		createTaskEvent(db, {
			id: randomUUID(),
			taskId: existingTaskId,
			eventType: "spawn_requested",
			summary: `Spawn requested for ${params.profile}`,
			payload: { title: params.title, task: params.task },
			createdAt: now,
		});
		return getTask(db, existingTaskId)!;
	}
	return createTaskFromParams(ctx, {
		title: params.title,
		summary: params.task,
		description: params.task,
		cwd: params.cwd,
		priorityLabel: params.priority,
		status: "in_progress",
	});
}

export function getTaskLinkedAgents(taskId: string, activeOnly = false): AgentSummary[] {
	const db = getMeepoDb();
	const links = listTaskAgentLinks(db, { taskIds: [taskId], activeOnly, limit: 200 });
	const ids = Array.from(new Set(links.map((link) => link.agentId)));
	if (ids.length === 0) return [];
	const agents = listAgents(db, { ids, limit: ids.length });
	return activeOnly ? agents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state)) : agents;
}

export async function chooseAgentForTaskAction(ctx: ExtensionContext, taskId: string, actionLabel: string): Promise<AgentSummary | null> {
	const linkedAgents = getTaskLinkedAgents(taskId, true).sort(
		(left, right) =>
			(taskLeaseKindForProfile(left.profile) === "exclusive" ? 0 : 1) - (taskLeaseKindForProfile(right.profile) === "exclusive" ? 0 : 1) ||
			left.createdAt - right.createdAt,
	);
	if (linkedAgents.length === 0) return null;
	if (linkedAgents.length === 1 || !ctx.hasUI) return linkedAgents[0] ?? null;
	const selection = await ctx.ui.select(
		`${actionLabel}: choose linked agent`,
		linkedAgents.map((agent) => `${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}`),
	);
	if (!selection) return null;
	return linkedAgents.find((agent) => `${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}` === selection) ?? linkedAgents[0] ?? null;
}

export async function spawnChildFromParams(pi: ExtensionAPI, ctx: ExtensionContext, params: {
	title: string;
	task: string;
	profile: string;
	taskId?: string;
	cwd?: string;
	model?: string;
	tools?: string[];
	parentAgentId?: string;
	priority?: string;
	allowDuplicateOwner?: boolean;
}): Promise<SpawnSubagentResult> {
	const profile = requireProfile(params.profile);
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	const actor = resolveToolActorContext(ctx);
	let parentAgentId = params.parentAgentId?.trim() || null;
	if (actor.kind === "agent") {
		if (!parentAgentId) {
			parentAgentId = actor.agentId;
		} else if (parentAgentId !== actor.agentId && !actor.canAdminOverride) {
			throw new Error(`Child session ${actor.agentId} may only spawn direct children under itself; requested parentAgentId=${parentAgentId}.`);
		}
	}
	const task = ensureTaskForSpawn(ctx, {
		title: params.title,
		task: params.task,
		profile: params.profile,
		cwd: spawnCwd,
		taskId: params.taskId,
		priority: params.priority,
		allowDuplicateOwner: params.allowDuplicateOwner,
	});
	const tools = normalizeBuiltinTools(params.tools ?? profile.tools);
	const hierarchyMode =
		activeMeepoRuntime?.config.policies.hierarchy ?? loadMeepoConfig().policies.hierarchy;
	const result = await spawnSubagent({
		title: params.title,
		task: params.task,
		profile,
		spawnCwd,
		model: params.model?.trim() || profile.model,
		tools,
		priority: params.priority?.trim() || null,
		taskId: task.id,
		parentAgentId,
		spawnedByAgentId: actor.kind === "agent" ? actor.agentId : null,
		createdByKind: actor.kind === "agent" ? "agent" : "root",
		allowDuplicateOwner: params.allowDuplicateOwner,
		hierarchyMode,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
	pi.appendEntry(SESSION_CHILD_LINK_ENTRY_TYPE, result.sessionLinkData);
	updateFleetUi(ctx);
	return result;
}

export function buildDispatchTaskPrompt(task: TaskRecord): string {
	return [
		`Task ${task.id}: ${task.title}`,
		task.summary ? `Summary: ${task.summary}` : null,
		task.description ? `Description: ${task.description}` : null,
		task.acceptanceCriteria.length > 0 ? "" : null,
		task.acceptanceCriteria.length > 0 ? "Acceptance criteria:" : null,
		...task.acceptanceCriteria.map((item) => `- ${item}`),
		task.validationSteps.length > 0 ? "" : null,
		task.validationSteps.length > 0 ? "Validation:" : null,
		...task.validationSteps.map((item) => `- ${item}`),
		task.files.length > 0 ? "" : null,
		task.files.length > 0 ? "Relevant files:" : null,
		...task.files.map((item) => `- ${item}`),
		"",
		"This ticket is dependency-ready. Work only this task. If blocked, publish one concrete question/blocker and recommend the task state. On completion, include files changed, validation run, and whether it should move to in_review/done.",
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

export function getReadyTasksForDispatch(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session" | "descendants"; ids?: string[]; recommendedProfile?: string; limit?: number }): TaskReadinessRecord[] {
	const scope = params.scope ?? "current_project";
	const filters = resolveTaskFilters(ctx, scope, {
		statuses: ["todo"],
		recommendedProfile: params.recommendedProfile,
		includeDone: false,
		limit: params.limit ?? 100,
	});
	if (params.ids && params.ids.length > 0) filters.ids = params.ids;
	return listTaskReadiness(getMeepoDb(), filters).filter((item) => item.ready);
}

export async function dispatchReadyTasks(pi: ExtensionAPI, ctx: ExtensionContext, items: TaskReadinessRecord[], options: { fallbackProfile?: string; maxDispatch?: number; dryRun?: boolean } = {}): Promise<{
	dispatched: Array<{ taskId: string; profile: string; agentId: string; title: string }>;
	skipped: Array<{ taskId: string; reason: string }>;
	preview: Array<{ taskId: string; profile: string; title: string }>;
}> {
	const maxDispatch = Math.max(1, Math.min(options.maxDispatch ?? 5, 20));
	const dispatched: Array<{ taskId: string; profile: string; agentId: string; title: string }> = [];
	const skipped: Array<{ taskId: string; reason: string }> = [];
	const preview: Array<{ taskId: string; profile: string; title: string }> = [];
	for (const item of items) {
		if (preview.length >= maxDispatch) break;
		const profileName = item.task.recommendedProfile ?? options.fallbackProfile?.trim() ?? null;
		if (!profileName) {
			skipped.push({ taskId: item.task.id, reason: "missing recommendedProfile and no fallbackProfile provided" });
			continue;
		}
		try {
			requireProfile(profileName);
		} catch (error) {
			skipped.push({ taskId: item.task.id, reason: error instanceof Error ? error.message : String(error) });
			continue;
		}
		preview.push({ taskId: item.task.id, profile: profileName, title: item.task.title });
		if (options.dryRun) continue;
		const result = await spawnChildFromParams(pi, ctx, {
			title: item.task.title,
			task: buildDispatchTaskPrompt(item.task),
			profile: profileName,
			taskId: item.task.id,
			cwd: item.task.spawnCwd,
			priority: item.task.priorityLabel ?? `p${item.task.priority}`,
		});
		dispatched.push({ taskId: item.task.id, profile: profileName, agentId: result.childId, title: item.task.title });
	}
	return { dispatched, skipped, preview };
}

export async function chooseProfile(ctx: ExtensionContext): Promise<SubagentProfile | null> {
	const profiles = listSubagentProfiles();
	if (profiles.length === 0) {
		ctx.ui.notify("No subagent profiles found. Add markdown under ~/.pi/agent/agents or set profiles.dirs.", "warning");
		return null;
	}
	const items: SelectItem[] = profiles.map((profile) => ({
		value: profile.name,
		label: profile.name,
		description: profile.description,
	}));
	const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Spawn subagent")), 1, 0));
		const selectList = new SelectList(items, Math.min(items.length, 10), {
			selectedPrefix: (value) => theme.fg("accent", value),
			selectedText: (value) => theme.fg("accent", value),
			description: (value) => theme.fg("muted", value),
			scrollInfo: (value) => theme.fg("dim", value),
			noMatch: (value) => theme.fg("warning", value),
		});
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);
		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", "↑↓ navigate • enter select • esc cancel"), 1, 0));
		container.addChild(new DynamicBorder((value: string) => theme.fg("accent", value)));
		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
	if (!selected) return null;
	return profiles.find((profile) => profile.name === selected) ?? null;
}

