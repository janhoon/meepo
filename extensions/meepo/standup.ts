/**
 * standup — split from coordinator-helpers.
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
import { formatHost, getProcessHost, hostHandleFromRecord } from "./process-host.js";
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
import { listCleanupCandidates, reconcileAgents, stopAgentById } from "./child-fleet.js";
import {
	buildBoardData,
	buildDashboardData,
	captureAgentById,
	focusAgentById,
} from "./board-projection.js";
import { setLastFocusedActiveAgentId, updateFleetUi } from "./coordinator-session.js";
import { spawnServiceFromParams } from "./service-ops.js";
import { loadAttentionGate, resolveTaskFilters } from "./session-scope.js";
import { getTaskInteractions } from "./task-interactions.js";

/** Active Meepo config for this extension process (set on register). */
export function formatStandupAge(timestamp: number): string {
	if (!timestamp) return "unknown";
	const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

export function standupNextAction(ticket: BoardTicket, linkedAgents: AgentSummary[]): string {
	if (ticket.openAttentionCount > 0) return ticket.waitingOn === "user" ? "answer user interaction" : "triage task interaction";
	if (ticket.health.nextAction) return ticket.health.nextAction;
	if (ticket.waitingOn) return `waiting on ${ticket.waitingOn}`;
	if (ticket.laneId === "blocked") return "add waitingOn or unblock";
	if (ticket.laneId === "in_review") return "run/synthesize review gate";
	if (ticket.laneId === "in_progress") return ticket.exclusiveOwnerCount > 0 ? "let owner run; inspect only if stale" : "assign owner or move todo";
	if (ticket.laneId === "todo") return ticket.exclusiveOwnerCount > 0 ? "inspect existing owner before spawning" : "spawn next specialist";
	if (ticket.laneId === "done") return ticket.activeAgentCount > 0 ? "cleanup active links/agents" : "archive context if useful";
	return "inspect task";
}

export function formatStandupTicketLine(ticket: BoardTicket, linkedAgents: AgentSummary[] = []): string {
	const flags = [
		`status=${ticket.laneId}`,
		`health=${ticket.health.state}`,
		`lastUseful=${formatStandupAge(ticket.health.lastUsefulUpdateAt ?? 0)}`,
		`waiting=${ticket.waitingOn ?? "-"}`,
		`owners=${ticket.exclusiveOwnerCount}`,
		`reviewers=${ticket.reviewerCount}`,
		`agents=${ticket.activeAgentCount}`,
		`interactions=${ticket.openAttentionCount}`,
		`p${ticket.priority}`,
		`updated=${formatStandupAge(ticket.updatedAt)}`,
	].join(" · ");
	return `- ${ticket.taskId} · ${truncateText(ticket.title, 64)} · ${flags}\n  healthReason: ${truncateText(ticket.health.reason, 140)}\n  next: ${standupNextAction(ticket, linkedAgents)}${ticket.blockedReason ? `\n  blocked: ${truncateText(ticket.blockedReason, 120)}` : ""}`;
}

interface StandupDependencyChain {
	source: TaskReadinessRecord;
	path: TaskLinkWithTasksRecord[];
	terminalTask: TaskRecord | null;
	terminalStatus: TaskState;
	terminalTitle: string;
	blockedTaskCount: number;
}

export function standupTaskStatusRank(status: TaskState): number {
	switch (status) {
		case "blocked":
			return 0;
		case "in_review":
			return 1;
		case "in_progress":
			return 2;
		case "todo":
			return 3;
		case "done":
			return 4;
		default:
			return 5;
	}
}

export function compareStandupTickets(left: BoardTicket, right: BoardTicket): number {
	return (
		right.openAttentionCount - left.openAttentionCount ||
		(left.waitingOn === "user" ? -1 : 0) - (right.waitingOn === "user" ? -1 : 0) ||
		left.priority - right.priority ||
		right.updatedAt - left.updatedAt ||
		left.taskId.localeCompare(right.taskId)
	);
}

export function compareDependencyLinks(left: TaskLinkWithTasksRecord, right: TaskLinkWithTasksRecord): number {
	return standupTaskStatusRank(left.targetStatus) - standupTaskStatusRank(right.targetStatus) || left.targetTaskId.localeCompare(right.targetTaskId);
}

export function isStandupHealthConcern(ticket: BoardTicket): boolean {
	return ticket.laneId !== "done" && ticket.health.signals.some((signal) => signal !== "healthy" && signal !== "owner_active");
}

export function formatStandupHealthLine(ticket: BoardTicket, linkedAgents: AgentSummary[] = []): string {
	const flags = [
		`health=${ticket.health.state}`,
		`lastUseful=${formatStandupAge(ticket.health.lastUsefulUpdateAt ?? 0)}`,
		`owners=${ticket.exclusiveOwnerCount}`,
		`agents=${ticket.activeAgentCount}`,
		`interactions=${ticket.openAttentionCount}`,
		`updated=${formatStandupAge(ticket.updatedAt)}`,
	].join(" · ");
	return `- ${ticket.taskId} · ${truncateText(ticket.title, 64)} · ${flags}\n  reason: ${truncateText(ticket.health.reason, 120)}\n  next: ${truncateText(standupNextAction(ticket, linkedAgents), 120)}`;
}

export function appendStandupHealthSection(lines: string[], tickets: BoardTicket[], scopeData: AgentsBoardData["scopes"]["all"], limit = 6): void {
	lines.push("", "## Health / liveness");
	if (tickets.length === 0) {
		lines.push("- no tasks in scope");
		return;
	}
	const ownerActive = tickets.filter((ticket) => ticket.health.signals.includes("owner_active"));
	const stale = tickets.filter((ticket) => ticket.health.signals.includes("stale"));
	const noProgress = tickets.filter((ticket) => ticket.health.signals.includes("empty_or_no_progress"));
	const approval = tickets.filter((ticket) => ticket.health.signals.includes("approval_required") || ticket.health.signals.includes("needs_review"));
	const external = tickets.filter((ticket) => ticket.health.signals.includes("blocked_external"));
	lines.push(`- summary: owner-active ${ownerActive.length} · stale ${stale.length} · no-progress ${noProgress.length} · approval/review ${approval.length} · external/user-wait ${external.length}`);
	const concerns = tickets.filter(isStandupHealthConcern).sort(compareStandupTickets);
	if (concerns.length === 0) {
		lines.push("- no stale/no-progress/approval/external liveness concerns detected");
		return;
	}
	for (const ticket of concerns.slice(0, limit)) lines.push(formatStandupHealthLine(ticket, scopeData.agentsByTaskId.get(ticket.taskId) ?? []));
	if (concerns.length > limit) lines.push(`- +${concerns.length - limit} more`);
}

export function buildDependencyPath(sourceTaskId: string, firstLink: TaskLinkWithTasksRecord, linksBySource: Map<string, TaskLinkWithTasksRecord[]>): TaskLinkWithTasksRecord[] {
	const path = [firstLink];
	const seen = new Set([sourceTaskId, firstLink.targetTaskId]);
	let currentTaskId = firstLink.targetTaskId;
	while (path.length < 8) {
		const next = (linksBySource.get(currentTaskId) ?? [])
			.filter((link) => link.unresolved && !seen.has(link.targetTaskId))
			.sort(compareDependencyLinks)[0];
		if (!next) break;
		path.push(next);
		currentTaskId = next.targetTaskId;
		seen.add(currentTaskId);
	}
	return path;
}

export function buildStandupDependencyChains(readiness: TaskReadinessRecord[]): StandupDependencyChain[] {
	const readinessByTaskId = new Map(readiness.map((item) => [item.task.id, item] as const));
	const linksBySource = new Map<string, TaskLinkWithTasksRecord[]>();
	for (const item of readiness) {
		for (const link of item.unresolvedDependencies) {
			const links = linksBySource.get(link.sourceTaskId) ?? [];
			links.push(link);
			linksBySource.set(link.sourceTaskId, links);
		}
	}
	for (const [taskId, links] of linksBySource.entries()) linksBySource.set(taskId, links.sort(compareDependencyLinks));
	const chains: StandupDependencyChain[] = [];
	for (const item of readiness) {
		for (const link of item.unresolvedDependencies.sort(compareDependencyLinks)) {
			const path = buildDependencyPath(item.task.id, link, linksBySource);
			const terminalLink = path[path.length - 1] ?? link;
			const terminalTask = readinessByTaskId.get(terminalLink.targetTaskId)?.task ?? null;
			chains.push({
				source: item,
				path,
				terminalTask,
				terminalStatus: terminalTask?.status ?? terminalLink.targetStatus,
				terminalTitle: terminalTask?.title ?? terminalLink.targetTitle,
				blockedTaskCount: 1,
			});
		}
	}
	const terminalSources = new Map<string, Set<string>>();
	for (const chain of chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		if (!terminalTaskId) continue;
		const sources = terminalSources.get(terminalTaskId) ?? new Set<string>();
		sources.add(chain.source.task.id);
		terminalSources.set(terminalTaskId, sources);
	}
	for (const chain of chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		chain.blockedTaskCount = terminalTaskId ? terminalSources.get(terminalTaskId)?.size ?? 1 : 1;
	}
	return chains.sort(
		(left, right) =>
			right.blockedTaskCount - left.blockedTaskCount ||
			left.source.task.priority - right.source.task.priority ||
			standupTaskStatusRank(left.terminalStatus) - standupTaskStatusRank(right.terminalStatus) ||
			right.source.task.updatedAt - left.source.task.updatedAt ||
			left.source.task.id.localeCompare(right.source.task.id),
	);
}

export function formatStandupDependencyChain(chain: StandupDependencyChain, scopeData: AgentsBoardData["scopes"]["all"], ticketsById: Map<string, BoardTicket>): string {
	const source = chain.source.task;
	const pathIds = [source.id, ...chain.path.map((link) => link.targetTaskId)];
	const terminalTaskId = pathIds[pathIds.length - 1] ?? source.id;
	const terminalTicket = ticketsById.get(terminalTaskId);
	const terminalNext = terminalTicket
		? standupNextAction(terminalTicket, scopeData.agentsByTaskId.get(terminalTicket.taskId) ?? [])
		: chain.terminalStatus === "done"
			? "refresh dependency state"
			: `finish or replan dependency in ${chain.terminalStatus}`;
	const rootHealth = terminalTicket ? ` · rootHealth=${terminalTicket.health.state}` : "";
	const parent = source.parentTaskId ? ` · parent=${source.parentTaskId}` : "";
	const multipleDeps = chain.source.unresolvedDependencies.length > 1 ? ` · directDeps=${chain.source.unresolvedDependencies.length}` : "";
	return `- ${pathIds.join(" → ")} · blocks ${chain.blockedTaskCount} task${chain.blockedTaskCount === 1 ? "" : "s"} · depth=${chain.path.length}${parent}${multipleDeps}\n  source: ${truncateText(source.title, 72)} · status=${source.status} · waiting=${source.waitingOn ?? "-"}\n  root blocker: ${terminalTaskId} · ${truncateText(chain.terminalTitle, 72)} · status=${chain.terminalStatus}${rootHealth} · next: ${truncateText(terminalNext, 120)}`;
}

export function appendStandupDependencyChainsSection(lines: string[], chains: StandupDependencyChain[], scopeData: AgentsBoardData["scopes"]["all"], ticketsById: Map<string, BoardTicket>, limit = 6): void {
	lines.push("", "## Dependency / blocker chains");
	if (chains.length === 0) {
		lines.push("- none");
		return;
	}
	for (const chain of chains.slice(0, limit)) lines.push(formatStandupDependencyChain(chain, scopeData, ticketsById));
	if (chains.length > limit) lines.push(`- +${chains.length - limit} more`);
}

export function appendStandupSection(lines: string[], title: string, tickets: BoardTicket[], scopeData: AgentsBoardData["scopes"]["all"], limit = 6): void {
	lines.push("", `## ${title}`);
	if (tickets.length === 0) {
		lines.push("- none");
		return;
	}
	for (const ticket of tickets.slice(0, limit)) {
		lines.push(formatStandupTicketLine(ticket, scopeData.agentsByTaskId.get(ticket.taskId) ?? []));
	}
	if (tickets.length > limit) lines.push(`- +${tickets.length - limit} more`);
}

export function formatStandupInteractionCard(interaction: TaskInteractionRecord, ticket: BoardTicket | undefined): string {
	const taskTitle = ticket ? truncateText(ticket.title, 56) : interaction.taskId;
	return [
		`- ${taskInteractionIcon(interaction.kind)} ${taskInteractionLabel(interaction.kind)} · ${interaction.taskId} · ${taskTitle}`,
		`  from: ${interaction.actorLabel} · owner: ${ownerLabelForInteraction(interaction)} · state: ${interaction.state}`,
		`  asks: ${truncateText(interaction.answerNeeded ?? interaction.summary, 140)}`,
		`  next: ${interaction.nextAction}`,
		...interaction.actions.slice(0, 2).map((action) => `  action: ${action}`),
	].join("\n");
}

export function appendStandupInteractionsSection(lines: string[], scopeData: AgentsBoardData["scopes"]["all"], tickets: BoardTicket[], limit = 8): void {
	lines.push("", "## Open task interactions");
	const ticketsById = new Map(tickets.map((ticket) => [ticket.taskId, ticket]));
	const interactions = [...scopeData.interactionsByTaskId.values()].flat().sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
	if (interactions.length === 0) {
		lines.push("- none");
		return;
	}
	for (const interaction of interactions.slice(0, limit)) lines.push(formatStandupInteractionCard(interaction, ticketsById.get(interaction.taskId)));
	if (interactions.length > limit) lines.push(`- +${interactions.length - limit} more`);
}

export function formatStandupCleanupLine(candidate: CleanupCandidate): string {
	const taskText = candidate.agent.taskId ? ` · task=${candidate.agent.taskId}` : "";
	const attentionText = candidate.attentionItems.length > 0 ? ` · ${candidate.attentionItems.length} attention` : "";
	return `- ${candidate.agent.id} · ${candidate.agent.profile} · ${candidate.agent.state}${taskText}${attentionText}\n  next: ${candidate.cleanupAllowed ? "cleanup terminal host target" : "resolve attention before cleanup"} · ${candidate.reason}`;
}

export function appendStandupCleanupSection(lines: string[], candidates: CleanupCandidate[], limit = 6): void {
	lines.push("", "## Cleanup candidates");
	if (candidates.length === 0) {
		lines.push("- none");
		return;
	}
	for (const candidate of candidates.slice(0, limit)) lines.push(formatStandupCleanupLine(candidate));
	if (candidates.length > limit) lines.push(`- +${candidates.length - limit} more`);
}

export function appendStandupReadinessSection(lines: string[], title: string, items: TaskReadinessRecord[], limit = 6): void {
	lines.push("", `## ${title}`);
	if (items.length === 0) {
		lines.push("- none");
		return;
	}
	for (const item of items.slice(0, limit)) lines.push(formatTaskReadinessLine(item));
	if (items.length > limit) lines.push(`- +${items.length - limit} more`);
}

export function appendStandupUnblockOrderSection(
	lines: string[],
	input: {
		scopeData: AgentsBoardData["scopes"]["all"];
		chains: StandupDependencyChain[];
		blockedUser: BoardTicket[];
		blockedCoordinator: BoardTicket[];
		review: BoardTicket[];
		staleOrNoProgress: BoardTicket[];
		ready: BoardTicket[];
		ticketsById: Map<string, BoardTicket>;
	},
	limit = 7,
): void {
	lines.push("", "## Recommended unblock order");
	const items: string[] = [];
	const interactions = [...input.scopeData.interactionsByTaskId.values()].flat().sort((left, right) => left.priority - right.priority || right.updatedAt - left.updatedAt);
	if (interactions.length > 0) {
		const first = interactions[0]!;
		items.push(`triage ${interactions.length} open interaction${interactions.length === 1 ? "" : "s"}; start with ${first.taskId} (${taskInteractionLabel(first.kind)})`);
	}
	const seenTerminalTaskIds = new Set<string>();
	for (const chain of input.chains) {
		const terminalTaskId = chain.path[chain.path.length - 1]?.targetTaskId;
		if (!terminalTaskId || seenTerminalTaskIds.has(terminalTaskId)) continue;
		seenTerminalTaskIds.add(terminalTaskId);
		const terminalTicket = input.ticketsById.get(terminalTaskId);
		const terminalNext = terminalTicket
			? standupNextAction(terminalTicket, input.scopeData.agentsByTaskId.get(terminalTicket.taskId) ?? [])
			: chain.terminalStatus === "done"
				? "refresh dependency state"
				: `finish or replan dependency in ${chain.terminalStatus}`;
		items.push(`resolve blocker ${terminalTaskId} to unblock ${chain.blockedTaskCount} task${chain.blockedTaskCount === 1 ? "" : "s"}; next: ${truncateText(terminalNext, 110)}`);
	}
	for (const ticket of input.blockedUser.slice().sort(compareStandupTickets)) {
		items.push(`answer user-wait ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.blockedCoordinator.slice().sort(compareStandupTickets)) {
		items.push(`clear blocker ${ticket.taskId} (${ticket.waitingOn ?? "coordinator"}); next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.review.slice().sort(compareStandupTickets)) {
		items.push(`synthesize review ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	for (const ticket of input.staleOrNoProgress.slice().sort(compareStandupTickets)) {
		items.push(`refresh liveness ${ticket.taskId}; next: ${truncateText(standupNextAction(ticket, input.scopeData.agentsByTaskId.get(ticket.taskId) ?? []), 110)}`);
	}
	if (input.ready.length > 0) items.push(`then pull Ready to start (${input.ready.length}); first ${input.ready[0]!.taskId} if blockers/review/WIP are under control`);
	if (items.length === 0) {
		lines.push("- no unblock work detected; ready-to-start work can be considered if WIP is under control");
		return;
	}
	for (const [index, item] of items.slice(0, limit).entries()) lines.push(`${index + 1}. ${item}`);
	if (items.length > limit) lines.push(`- +${items.length - limit} more`);
}

export async function buildStandupText(ctx: ExtensionContext, scope: "all" | "current_project" | "current_session" | "descendants" = "current_project"): Promise<string> {
	const board = buildBoardData(ctx);
	const scopeData = board.scopes[scope];
	const lanes = scopeData.lanes;
	const allTickets = Object.values(lanes).flat();
	const ticketsById = new Map(allTickets.map((ticket) => [ticket.taskId, ticket] as const));
	const review = lanes.in_review;
	const activeWip = lanes.in_progress;
	const ready = lanes.todo;
	const cleanupCandidates = await listCleanupCandidates(ctx, { scope, limit: 200 });
	const readiness = listTaskReadiness(getMeepoDb(), { ids: allTickets.map((ticket) => ticket.taskId), includeDone: false, limit: Math.max(allTickets.length, 1) });
	const dependencyBlocked = readiness.filter((item) => item.unresolvedDependencies.length > 0);
	const dependencyReady = readiness.filter((item) => item.ready && item.resolvedDependencies.length > 0);
	const dependencyChains = buildStandupDependencyChains(dependencyBlocked);
	const dependencyBlockedTaskIds = new Set(dependencyBlocked.map((item) => item.task.id));
	const blockedUser = lanes.blocked.filter((ticket) => ticket.waitingOn === "user");
	const blockedCoordinator = lanes.blocked.filter((ticket) => ticket.waitingOn !== "user" && !dependencyBlockedTaskIds.has(ticket.taskId));
	const stale = allTickets.filter((ticket) => ticket.health.signals.includes("stale"));
	const noProgress = allTickets.filter((ticket) => ticket.health.signals.includes("empty_or_no_progress"));
	const approvalRequired = allTickets.filter((ticket) => ticket.health.signals.includes("approval_required"));
	const externalBlocked = allTickets.filter((ticket) => ticket.health.signals.includes("blocked_external"));
	const ownerActive = allTickets.filter((ticket) => ticket.health.signals.includes("owner_active"));
	const staleOrNoProgress = allTickets.filter((ticket) => ticket.health.signals.includes("stale") || ticket.health.signals.includes("empty_or_no_progress"));
	const openAttention = allTickets.reduce((count, ticket) => count + ticket.openAttentionCount, 0);
	const activeAgents = allTickets.reduce((count, ticket) => count + ticket.activeAgentCount, 0);
	const counts = [`todo ${ready.length}`, `blocked ${lanes.blocked.length}`, `in-progress ${activeWip.length}`, `review ${review.length}`, `done ${lanes.done.length}`].join(" · ");
	const lines = [
		`# Standup · ${scope}`,
		`Generated: ${new Date().toISOString()}`,
		`Board: ${counts}`,
		`Signals: ${blockedUser.length} user-wait · ${blockedCoordinator.length} free-text blocker · ${externalBlocked.length} external-blocked · ${dependencyChains.length} dependency-chain · ${dependencyReady.length} dependency-ready · ${review.length} review · ${approvalRequired.length} approval-required · ${openAttention} interactions · ${activeAgents} active agents · ${ownerActive.length} owner-active · ${stale.length} stale · ${noProgress.length} no-progress · ${cleanupCandidates.length} cleanup`,
	];
	appendStandupHealthSection(lines, allTickets, scopeData, 6);
	appendStandupInteractionsSection(lines, scopeData, allTickets, 8);
	appendStandupSection(lines, "Needs user", blockedUser, scopeData, 5);
	appendStandupDependencyChainsSection(lines, dependencyChains, scopeData, ticketsById, 6);
	appendStandupReadinessSection(lines, "Newly dependency-ready", dependencyReady, 6);
	appendStandupSection(lines, "Needs coordinator / free-text blockers", blockedCoordinator, scopeData, 6);
	appendStandupSection(lines, "Ready for review / acceptance", review, scopeData, 6);
	appendStandupSection(lines, "Active WIP", activeWip, scopeData, 8);
	appendStandupSection(lines, "Stale / no progress", staleOrNoProgress, scopeData, 6);
	appendStandupCleanupSection(lines, cleanupCandidates, 6);
	appendStandupUnblockOrderSection(lines, { scopeData, chains: dependencyChains, blockedUser, blockedCoordinator, review, staleOrNoProgress, ready, ticketsById }, 7);
	appendStandupSection(lines, "Ready to start", ready, scopeData, 6);
	lines.push("", "## Operating notes", "- Prefer the `Recommended unblock order` before spawning from `Ready to start`; use `task_dispatch_ready` for dependency-ready tickets and cleanup terminal agents after accepted completion.");
	return lines.join("\n");
}

export async function runReplyFlow(ctx: ExtensionContext, agentId: string): Promise<void> {
	const agent = getAgent(getMeepoDb(), agentId);
	if (!agent) throw new Error(`Unknown agent id \"${agentId}\".`);
	if (["done", "error", "stopped", "lost"].includes(agent.state)) {
		throw new Error(`Cannot message agent ${agent.id} because it is in terminal state ${agent.state}.`);
	}
	if (
		!(await getProcessHost().targetExists(hostHandleFromRecord(agent)))
	) {
		throw new Error(missingHostTargetMessage(agent.id));
	}
	const kind = await ctx.ui.select("Message kind:", ["answer", "note", "redirect", "cancel", "priority"]);
	if (!kind) return;
	const summary = await ctx.ui.input(`Message for ${agent.id}:`, "");
	if (!summary?.trim()) return;
	const details = await ctx.ui.editor("Additional details (optional):", "");
	queueDownwardMessage(agent, kind as "answer" | "note" | "redirect" | "cancel" | "priority", {
		summary: summary.trim(),
		details: details?.trim() || undefined,
	}, "immediate");
	const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
	ctx.ui.notify(
		liveDelivery.delivered > 0 ? `Queued ${kind} for ${agent.id} and delivered via RPC bridge.` : `Queued ${kind} for ${agent.id}.`,
		"info",
	);
}

export async function runStopFlow(ctx: ExtensionContext, agentId: string): Promise<void> {
	const choice = await ctx.ui.select("Stop mode:", ["Graceful stop", "Force stop", "Cancel"]);
	if (!choice || choice === "Cancel") return;
	const force = choice === "Force stop";
	const reason = await ctx.ui.input("Reason (optional):", "");
	const { agent, result } = await stopAgentById(agentId, force, reason?.trim() || undefined);
	ctx.ui.notify(formatStopResult(agent, result, force), force ? "warning" : "info");
}

export function moveTaskById(taskId: string, params: { status: TaskState; reason?: string; waitingOn?: TaskWaitingOn; blockedReason?: string; reviewSummary?: string; finalSummary?: string; force?: boolean }): TaskRecord {
	const db = getMeepoDb();
	const task = getTask(db, taskId);
	if (!task) throw new Error(`Unknown task id \"${taskId}\".`);
	if (task.status === "done" && params.status !== "done" && !params.force) {
		throw new Error(`Task ${task.id} is already done. Pass force=true to reopen it.`);
	}
	const now = Date.now();
	updateTask(db, taskId, {
		status: params.status,
		waitingOn: params.status === "blocked" ? params.waitingOn ?? task.waitingOn : null,
		blockedReason: params.status === "blocked" ? params.blockedReason ?? task.blockedReason : null,
		reviewSummary: params.reviewSummary !== undefined ? params.reviewSummary : params.status === "in_review" ? task.reviewSummary : task.reviewSummary,
		finalSummary: params.finalSummary !== undefined ? params.finalSummary : params.status === "done" ? task.finalSummary : task.finalSummary,
		updatedAt: now,
		startedAt: params.status === "in_progress" ? task.startedAt ?? now : task.startedAt,
		reviewRequestedAt: params.status === "in_review" ? task.reviewRequestedAt ?? now : params.status === "todo" ? null : task.reviewRequestedAt,
		finishedAt: params.status === "done" ? task.finishedAt ?? now : null,
	});
	createTaskEvent(db, {
		id: randomUUID(),
		taskId,
		eventType: "state_changed",
		summary: params.reason?.trim() || `Moved to ${params.status}`,
		payload: {
			from: task.status,
			to: params.status,
			waitingOn: params.waitingOn ?? null,
			blockedReason: params.blockedReason ?? null,
		},
		createdAt: now,
	});
	const lease = getTaskLease(db, taskId);
	if (params.status === "in_progress" && lease.exclusiveOwners.length > 0) {
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_owner_active",
			summary: `Task in_progress with active owner ${lease.exclusiveOwners.map((owner) => owner.agentId).join(", ")}`,
			payload: { ownerAgentIds: lease.exclusiveOwners.map((owner) => owner.agentId) },
			createdAt: now,
		});
	}
	if (params.status === "done" && lease.activeOwners.length > 0) {
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_cleanup_recommended",
			summary: `Task done while ${lease.activeOwners.length} active lease(s) remain; cleanup/reconcile should release them after synthesis.`,
			payload: { agentIds: lease.activeOwners.map((owner) => owner.agentId) },
			createdAt: now,
		});
	}
	if (params.status === "done") {
		resolveDependenciesForCompletedTask(db, taskId, now);
	}
	if (params.status !== "done") {
		refreshTaskDependencyBlockState(db, taskId, now);
	}
	return getTask(db, taskId)!;
}

export async function runTaskCreateWizard(ctx: ExtensionContext): Promise<TaskRecord | null> {
	if (!ctx.hasUI) return null;
	const title = await ctx.ui.input("Task title:", "new task");
	if (!title?.trim()) return null;
	const summary = await ctx.ui.input("Task summary (optional):", "");
	const description = await ctx.ui.editor("Task description (optional):", "");
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return null;
	const status = (await ctx.ui.select("Initial task status:", ["todo", "blocked", "in_progress", "in_review", "done"])) as TaskState | null;
	if (!status) return null;
	const created = createTaskFromParams(ctx, {
		title: title.trim(),
		summary: summary?.trim() || undefined,
		description: description?.trim() || undefined,
		cwd: cwd.trim(),
		status,
	});
	ctx.ui.notify(`Created task ${created.id}.`, "info");
	return created;
}

export async function runTaskMoveFlow(ctx: ExtensionContext, taskId: string): Promise<void> {
	const task = getTask(getMeepoDb(), taskId);
	if (!task) throw new Error(`Unknown task id \"${taskId}\".`);
	const status = (await ctx.ui.select("Move task to:", ["todo", "blocked", "in_progress", "in_review", "done"])) as TaskState | null;
	if (!status) return;
	let waitingOn: TaskWaitingOn | undefined;
	let blockedReason: string | undefined;
	if (status === "blocked") {
		const selectedWaitingOn = (await ctx.ui.select("Waiting on:", ["user", "coordinator", "service", "external"])) as TaskWaitingOn | null;
		waitingOn = selectedWaitingOn ?? undefined;
		blockedReason = (await ctx.ui.input("Blocked reason:", task.blockedReason ?? ""))?.trim() || undefined;
	}
	const reason = await ctx.ui.input("Move reason (optional):", "");
	const moved = moveTaskById(taskId, {
		status,
		reason: reason?.trim() || undefined,
		waitingOn,
		blockedReason,
		force: true,
	});
	ctx.ui.notify(`Moved ${moved.id} to ${moved.status}.`, "info");
}

export async function runTaskSubtreeControlFlow(ctx: ExtensionContext, taskId: string): Promise<void> {
	if (!ctx.hasUI) return;
	const selection = await ctx.ui.select("Subtree control:", ["Preview only", "Pause subtree", "Resume paused subtree", "Cancel subtree", "Back"]);
	if (!selection || selection === "Back") return;
	const actionMap: Record<string, TaskSubtreeControlAction> = {
		"Preview only": "preview",
		"Pause subtree": "pause",
		"Resume paused subtree": "resume",
		"Cancel subtree": "cancel",
	};
	const action = actionMap[selection] ?? "preview";
	const reason = action === "preview" ? undefined : (await ctx.ui.input(`${selection} reason:`, ""))?.trim() || undefined;
	const preview = await buildTaskSubtreeControlPreview(ctx, taskId, action, { reason });
	await ctx.ui.editor(`Subtree ${action} preview`, formatTaskSubtreeControlPreview(preview));
	if (action === "preview") return;
	const ok = await ctx.ui.confirm(`Confirm subtree ${action}`, formatTaskSubtreeControlConfirmation(preview));
	if (!ok) return;
	const result = await applyTaskSubtreeControl(ctx, taskId, action, { reason, previewToken: preview.previewToken });
	ctx.ui.notify(`Applied subtree ${action}: ${result.updatedTasks.length} task(s), ${result.stopResults.length} graceful stop request(s).`, result.stopErrors.length > 0 ? "warning" : "info");
	await ctx.ui.editor(`Subtree ${action} result`, formatTaskSubtreeControlApplyResult(result));
}

export async function confirmTaskLeaseOverride(ctx: ExtensionContext, taskId: string | undefined, profileName: string): Promise<boolean> {
	if (!taskId) return false;
	const conflict = getTaskLeaseConflict(getMeepoDb(), { taskId, profile: profileName });
	if (!conflict) return false;
	if (!ctx.hasUI) throw new Error(formatTaskLeaseConflict(conflict));
	const ok = await ctx.ui.confirm(
		"Active task owner",
		`${formatTaskLeaseConflict(conflict)}\n\nSpawn/link another exclusive owner anyway?`,
	);
	if (ok) {
		createTaskEvent(getMeepoDb(), {
			id: randomUUID(),
			taskId,
			eventType: "task_lease_override_confirmed",
			summary: `Coordinator allowed duplicate exclusive owner for ${profileName}`,
			payload: { profile: profileName, conflictingOwners: conflict.conflictingOwners.map((owner) => owner.agentId) },
		});
	}
	return ok;
}

export async function runTaskSpawnWizard(pi: ExtensionAPI, ctx: ExtensionContext, taskId?: string): Promise<void> {
	if (!ctx.hasUI) return;
	const { items: gateItems, agents: gateAgents } = loadAttentionGate(ctx, "current_project");
	if (gateItems.length > 0) {
		const ok = await ctx.ui.confirm("Open attention items", `${formatAttentionGateWarning(gateItems, gateAgents)}\n\nSpawn anyway?`);
		if (!ok) return;
	}
	const linkedTask = taskId ? getTask(getMeepoDb(), taskId) : null;
	const profile = await chooseProfile(ctx);
	if (!profile) return;
	const title = await ctx.ui.input("Child title:", linkedTask?.title ?? `${profile.name} task`);
	if (!title?.trim()) return;
	const task = await ctx.ui.editor("Child task:", linkedTask?.description ?? linkedTask?.summary ?? "");
	if (!task?.trim()) return;
	const cwd = await ctx.ui.input("Working directory:", linkedTask?.spawnCwd ?? ctx.cwd);
	if (!cwd?.trim()) return;
	const selectedTaskId = taskId ?? ((await ctx.ui.input("Existing task id (optional, blank = auto-create):", ""))?.trim() || undefined);
	try {
		const allowDuplicateOwner = await confirmTaskLeaseOverride(ctx, selectedTaskId, profile.name);
		const result = await spawnChildFromParams(pi, ctx, {
			title: title.trim(),
			task: task.trim(),
			profile: profile.name,
			taskId: selectedTaskId,
			cwd: cwd.trim(),
			allowDuplicateOwner,
		});
		ctx.ui.notify(
			`Spawned ${result.childId} on ${formatHost(result.host)}. RPC bridge launching — task will deliver when the child is ready`,
			"info",
		);
		// Avoid ui.editor dump after spawn — it hijacks the parent composer.
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

export async function runAgentsDashboard(pi: ExtensionAPI, ctx: ExtensionContext, initialState: AgentsDashboardState): Promise<AgentsDashboardState> {
	let state = initialState;
	while (ctx.hasUI) {
		const action = await openAgentsDashboard(ctx, () => buildDashboardData(ctx), state, 5000);
		if (!action || action.type === "close") return action?.state ?? state;
		state = action.state;
		const selectedId = action.selectedId;
		if (!selectedId && action.type !== "spawn" && action.type !== "sync") continue;
		try {
			switch (action.type) {
				case "inspect": {
					const agent = getAgent(getMeepoDb(), selectedId!);
					if (agent) await ctx.ui.editor(`Agent ${agent.id}`, formatAgentDetails(agent));
					break;
				}
				case "focus": {
					const { agent, result } = await focusAgentById(selectedId!);
					lastFocusedActiveAgentId = agent.id;
					ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
					break;
				}
				case "stop":
					await runStopFlow(ctx, selectedId!);
					break;
				case "reply":
					await runReplyFlow(ctx, selectedId!);
					break;
				case "capture": {
					const capture = await captureAgentById(selectedId!, 200);
					await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
					break;
				}
				case "spawn":
					await runSpawnWizard(pi, ctx);
					break;
				case "sync": {
					const agentResult = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					const taskResult = reconcileTasks(getMeepoDb(), resolveTaskFilters(ctx, state.scope, { includeDone: true, limit: 200 }));
					ctx.ui.notify(`${formatReconcileResult(agentResult)}\nTasks: ${taskResult.backfilled} backfilled, ${taskResult.deactivatedLinks} links deactivated.`, "info");
					break;
				}
				default:
					return state;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		updateFleetUi(ctx);
	}
	return state;
}

export async function runAgentsBoard(pi: ExtensionAPI, ctx: ExtensionContext, initialState: AgentsBoardState): Promise<AgentsBoardState> {
	let state = initialState;
	while (ctx.hasUI) {
		const action = await openAgentsBoard(ctx, () => buildBoardData(ctx), state, 5000);
		if (!action || action.type === "close") return action?.state ?? state;
		state = action.state;
		const selectedId = action.selectedId;
		if (!selectedId && !["spawn", "sync", "create"].includes(action.type)) continue;
		try {
			switch (action.type) {
				case "inspect": {
					const task = getTask(getMeepoDb(), selectedId!);
					if (task) await ctx.ui.editor(`Task ${task.id}`, formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getMeepoDb(), { taskIds: [task.id], limit: 20 }), {}, getTaskInteractions(task.id)));
					break;
				}
				case "focus": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Focus");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					const { result } = await focusAgentById(agent.id);
					lastFocusedActiveAgentId = agent.id;
					ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
					break;
				}
				case "stop": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Stop");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					await runStopFlow(ctx, agent.id);
					break;
				}
				case "reply": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Reply");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					await runReplyFlow(ctx, agent.id);
					break;
				}
				case "capture": {
					const agent = await chooseAgentForTaskAction(ctx, selectedId!, "Capture");
					if (!agent) throw new Error(`Task ${selectedId!} has no linked active agents.`);
					const capture = await captureAgentById(agent.id, 200);
					await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
					break;
				}
				case "spawn":
					await runTaskSpawnWizard(pi, ctx, selectedId || undefined);
					break;
				case "move":
					await runTaskMoveFlow(ctx, selectedId!);
					break;
				case "subtree":
					await runTaskSubtreeControlFlow(ctx, selectedId!);
					break;
				case "create":
					await runTaskCreateWizard(ctx);
					break;
				case "sync": {
					const agentResult = await reconcileAgents(ctx, { scope: state.scope, activeOnly: false, limit: 200 });
					const taskResult = reconcileTasks(getMeepoDb(), resolveTaskFilters(ctx, state.scope, { includeDone: true, limit: 200 }));
					ctx.ui.notify(`${formatReconcileResult(agentResult)}\nTasks: ${taskResult.backfilled} backfilled, ${taskResult.deactivatedLinks} links deactivated.`, "info");
					break;
				}
				default:
					return state;
			}
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
		updateFleetUi(ctx);
	}
	return state;
}

export async function runSpawnWizard(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await runTaskSpawnWizard(pi, ctx);
}

export async function runServiceSpawnWizard(ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const title = await ctx.ui.input("Service title:", "dev server");
	if (!title?.trim()) return;
	const command = await ctx.ui.editor("Command to run:", "");
	if (!command?.trim()) return;
	const cwd = await ctx.ui.input("Working directory:", ctx.cwd);
	if (!cwd?.trim()) return;
	const readySubstring = await ctx.ui.input("Ready substring (optional):", "");
	try {
		const result = await spawnServiceFromParams(ctx, {
			title: title.trim(),
			command: command.trim(),
			cwd: cwd.trim(),
			readySubstring: readySubstring?.trim() || undefined,
		});
		ctx.ui.notify(
			`Started ${result.serviceId} on ${formatHost(result.host)}.`,
			"info",
		);
		await ctx.ui.editor(`Started ${result.serviceId}`, formatServiceStartResult(result));
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/**
 * Coordinator + shared tool/command registration (today's full surface).
 * Invoked by MeepoRuntime.start(); capability gating lands in a follow-up ticket.
 */
