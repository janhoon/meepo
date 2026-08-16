/**
 * Task subtree preview/apply control for Meepo.
 */
import { createHash, randomUUID } from "node:crypto";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import type { CleanupCandidate } from "./cleanup-types.js";
import { appendPreviewSection, formatTaskStatusCounts, taskStatusCounts } from "./formatters.js";
import { truncateText } from "./text-util.js";
import { listAgents } from "./registry.js";
import { listOpenAttention } from "./inbox.js";
import {
	createTaskEvent,
	getTask,
	listTaskAgentLinks,
	listTaskSubtreeWithMeta,
	refreshTaskDependencyBlockState,
	updateTask,
} from "./task-registry.js";
import type { AgentSummary, AttentionItemRecord } from "./types.js";
import type { TaskAgentLinkRecord, TaskRecord, TaskState } from "./task-types.js";

const OPEN_ATTENTION_STATES: AttentionItemRecord["state"][] = ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"];
const ACTIVE_AGENT_STATES: AgentSummary["state"][] = ["launching", "running", "idle", "waiting", "blocked"];

export type SubtreeStopAgent = (
	id: string,
	force: boolean,
	reason?: string,
) => Promise<{
	agent: AgentSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
}>;

export type SubtreeListCleanup = (
	ctx: ExtensionContext,
	params: { ids?: string[]; limit?: number; force?: boolean },
) => Promise<CleanupCandidate[]>;

let stopAgentByIdImpl: SubtreeStopAgent | null = null;
let listCleanupCandidatesImpl: SubtreeListCleanup | null = null;

/** Wire coordinator implementations to avoid circular imports. */
export function configureSubtreeControlDeps(deps: {
	stopAgentById: SubtreeStopAgent;
	listCleanupCandidates: SubtreeListCleanup;
}): void {
	stopAgentByIdImpl = deps.stopAgentById;
	listCleanupCandidatesImpl = deps.listCleanupCandidates;
}

async function stopAgentById(id: string, force: boolean, reason?: string) {
	if (!stopAgentByIdImpl) throw new Error("subtree-control: stopAgentById not configured");
	return stopAgentByIdImpl(id, force, reason);
}

async function listCleanupCandidates(
	ctx: ExtensionContext,
	params: { ids?: string[]; limit?: number; force?: boolean },
) {
	if (!listCleanupCandidatesImpl) throw new Error("subtree-control: listCleanupCandidates not configured");
	return listCleanupCandidatesImpl(ctx, params);
}

export type TaskSubtreeControlAction = "preview" | "pause" | "resume" | "cancel";

export interface TaskSubtreeControlPreview {
	action: TaskSubtreeControlAction;
	rootTask: TaskRecord;
	includeRoot: boolean;
	reason: string | null;
	previewToken: string;
	isComplete: boolean;
	truncationWarnings: string[];
	tasks: TaskRecord[];
	taskIdsToUpdate: string[];
	links: TaskAgentLinkRecord[];
	linkedAgents: AgentSummary[];
	activeAgents: AgentSummary[];
	agentIdsToStop: string[];
	agentsByTaskId: Map<string, AgentSummary[]>;
	blockers: TaskRecord[];
	attentionItems: AttentionItemRecord[];
	cleanupCandidates: CleanupCandidate[];
}

export interface TaskSubtreeControlApplyResult {
	preview: TaskSubtreeControlPreview;
	updatedTasks: TaskRecord[];
	stopResults: Array<{ agentId: string; stopped: boolean; graceful: boolean; command: string; reason?: string }>;
	stopErrors: Array<{ agentId: string; error: string }>;
	taskEventsCreated: number;
}

export const SUBTREE_PAUSED_PREFIX = "[subtree paused]";

export const SUBTREE_CANCELLED_PREFIX = "[subtree cancelled]";

export const SUBTREE_QUERY_TASK_LIMIT = 1000;

export const SUBTREE_QUERY_LINK_LIMIT = 1000;

export const SUBTREE_QUERY_AGENT_LIMIT = 200;

export const SUBTREE_QUERY_ATTENTION_LIMIT = 500;

export function normalizeSubtreeReason(action: TaskSubtreeControlAction, reason: string | null | undefined): string {
	const trimmed = reason?.trim();
	if (trimmed) return trimmed;
	switch (action) {
		case "pause":
			return "Subtree paused by coordinator.";
		case "resume":
			return "Subtree resumed by coordinator.";
		case "cancel":
			return "Subtree cancelled by coordinator.";
		case "preview":
		default:
			return "Subtree preview requested.";
	}
}

export function isTaskPausedBySubtree(task: TaskRecord): boolean {
	return task.status === "blocked" && Boolean(task.blockedReason?.startsWith(SUBTREE_PAUSED_PREFIX));
}

export function isActiveAgent(agent: AgentSummary): boolean {
	return ACTIVE_AGENT_STATES.includes(agent.state);
}

export function taskShouldUpdateForSubtreeAction(task: TaskRecord, action: TaskSubtreeControlAction): boolean {
	switch (action) {
		case "pause":
			return task.status !== "done" && task.status !== "blocked";
		case "resume":
			return isTaskPausedBySubtree(task);
		case "cancel":
			return task.status !== "done";
		case "preview":
		default:
			return false;
	}
}

export function subtreeBlockedReason(prefix: string, reason: string): string {
	return `${prefix} ${reason}`.trim();
}

export function addAgentToTaskMap(map: Map<string, AgentSummary[]>, taskId: string, agent: AgentSummary): void {
	const agents = map.get(taskId) ?? [];
	if (!agents.some((existing) => existing.id === agent.id)) agents.push(agent);
	map.set(taskId, agents);
}

export function buildTaskSubtreePreviewToken(input: {
	action: TaskSubtreeControlAction;
	rootTaskId: string;
	includeRoot: boolean;
	reason: string | null;
	taskIds: string[];
	taskIdsToUpdate: string[];
	agentIdsToStop: string[];
	truncationWarnings: string[];
}): string {
	return createHash("sha256")
		.update(JSON.stringify({
			action: input.action,
			rootTaskId: input.rootTaskId,
			includeRoot: input.includeRoot,
			reason: input.reason,
			taskIds: [...input.taskIds].sort(),
			taskIdsToUpdate: [...input.taskIdsToUpdate].sort(),
			agentIdsToStop: [...input.agentIdsToStop].sort(),
			truncationWarnings: input.truncationWarnings,
		}))
		.digest("hex")
		.slice(0, 16);
}

export async function buildTaskSubtreeControlPreview(
	ctx: ExtensionContext,
	rootTaskId: string,
	action: TaskSubtreeControlAction,
	options: { includeRoot?: boolean; reason?: string } = {},
): Promise<TaskSubtreeControlPreview> {
	const db = getMeepoDb();
	const rootTask = getTask(db, rootTaskId);
	if (!rootTask) throw new Error(`Unknown task id \"${rootTaskId}\".`);
	const includeRoot = options.includeRoot ?? true;
	const reason = action === "preview" ? null : normalizeSubtreeReason(action, options.reason);
	const truncationWarnings: string[] = [];
	const subtree = listTaskSubtreeWithMeta(db, rootTask.id, { includeRoot, includeDone: true, limit: SUBTREE_QUERY_TASK_LIMIT, maxDepth: SUBTREE_QUERY_TASK_LIMIT });
	const tasks = subtree.tasks;
	if (subtree.hitLimit) truncationWarnings.push(`task subtree reached safety cap ${subtree.limit}; apply is disabled until the subtree is narrowed or the cap is raised`);
	if (subtree.hitDepthLimit) truncationWarnings.push(`task subtree reached depth safety cap ${subtree.maxDepth}; descendants may be omitted below depth ${subtree.maxReturnedDepth}, so apply is disabled until the subtree is narrowed or the depth cap is raised`);
	const taskIds = tasks.map((task) => task.id);
	const taskIdSet = new Set(taskIds);
	const links = taskIds.length > 0 ? listTaskAgentLinks(db, { taskIds, limit: SUBTREE_QUERY_LINK_LIMIT }) : [];
	if (links.length >= SUBTREE_QUERY_LINK_LIMIT) truncationWarnings.push(`task-agent links reached safety cap ${SUBTREE_QUERY_LINK_LIMIT}; apply is disabled to avoid partial linked-agent control`);
	const activeLinkAgentIds = new Set(links.filter((link) => link.isActive).map((link) => link.agentId));
	const linkedAgentIds = new Set(links.map((link) => link.agentId));
	const agentsById = new Map<string, AgentSummary>();
	if (linkedAgentIds.size > SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`linked agent id set has ${linkedAgentIds.size} agents, exceeding list cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled to avoid partial agent control`);
	if (linkedAgentIds.size > 0) {
		for (const agent of listAgents(db, { ids: [...linkedAgentIds], limit: SUBTREE_QUERY_AGENT_LIMIT })) agentsById.set(agent.id, agent);
	}
	if (taskIds.length > 0) {
		const taskAgents = listAgents(db, { taskIds, limit: SUBTREE_QUERY_AGENT_LIMIT });
		if (taskAgents.length >= SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`agents attached directly by task_id reached safety cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled to avoid partial agent control`);
		for (const agent of taskAgents) agentsById.set(agent.id, agent);
	}
	const linkedAgents = [...agentsById.values()]
		.filter((agent) => (agent.taskId ? taskIdSet.has(agent.taskId) : false) || links.some((link) => link.agentId === agent.id))
		.sort((left, right) => {
			const leftActive = isActiveAgent(left) ? 0 : 1;
			const rightActive = isActiveAgent(right) ? 0 : 1;
			return leftActive - rightActive || left.profile.localeCompare(right.profile) || left.id.localeCompare(right.id);
		});
	const agentsByTaskId = new Map<string, AgentSummary[]>();
	for (const link of links) {
		const agent = agentsById.get(link.agentId);
		if (agent) addAgentToTaskMap(agentsByTaskId, link.taskId, agent);
	}
	for (const agent of linkedAgents) {
		if (agent.taskId && taskIdSet.has(agent.taskId)) addAgentToTaskMap(agentsByTaskId, agent.taskId, agent);
	}
	const activeAgents = linkedAgents.filter((agent) => isActiveAgent(agent) && ((agent.taskId ? taskIdSet.has(agent.taskId) : false) || activeLinkAgentIds.has(agent.id)));
	const agentIds = linkedAgents.map((agent) => agent.id);
	const attentionItems =
		agentIds.length > 0 || taskIds.length > 0
			? listOpenAttention(db, {
					childIds: agentIds.length > 0 ? agentIds : undefined,
					taskIds: taskIds.length > 0 ? taskIds : undefined,
					states: OPEN_ATTENTION_STATES,
					limit: SUBTREE_QUERY_ATTENTION_LIMIT,
			  })
			: [];
	if (attentionItems.length >= SUBTREE_QUERY_ATTENTION_LIMIT) truncationWarnings.push(`attention reached safety cap ${SUBTREE_QUERY_ATTENTION_LIMIT}; apply is disabled until attention fanout is narrowed`);
	const cleanupCandidates = agentIds.length > 0 ? await listCleanupCandidates(ctx, { ids: agentIds, limit: agentIds.length, force: false }) : [];
	if (agentIds.length > SUBTREE_QUERY_AGENT_LIMIT) truncationWarnings.push(`cleanup candidate lookup is incomplete for ${agentIds.length} agents due agent list cap ${SUBTREE_QUERY_AGENT_LIMIT}; apply is disabled`);
	const taskIdsToUpdate = tasks.filter((task) => taskShouldUpdateForSubtreeAction(task, action)).map((task) => task.id);
	const agentIdsToStop = action === "pause" || action === "cancel" ? activeAgents.map((agent) => agent.id) : [];
	const isComplete = truncationWarnings.length === 0;
	const previewToken = buildTaskSubtreePreviewToken({ action, rootTaskId: rootTask.id, includeRoot, reason, taskIds, taskIdsToUpdate, agentIdsToStop, truncationWarnings });
	return {
		action,
		rootTask,
		includeRoot,
		reason,
		previewToken,
		isComplete,
		truncationWarnings,
		tasks,
		taskIdsToUpdate,
		links,
		linkedAgents,
		activeAgents,
		agentIdsToStop,
		agentsByTaskId,
		blockers: tasks.filter((task) => task.status === "blocked" || Boolean(task.waitingOn) || Boolean(task.blockedReason)),
		attentionItems,
		cleanupCandidates,
	};
}

export function formatTaskSubtreePreviewTaskLine(preview: TaskSubtreeControlPreview, task: TaskRecord): string {
	const action = preview.taskIdsToUpdate.includes(task.id) ? `will-${preview.action}` : "unchanged";
	const agents = preview.agentsByTaskId.get(task.id) ?? [];
	const agentText = agents.length > 0 ? ` · agents=${agents.map((agent) => `${agent.id}:${agent.state}`).join(",")}` : "";
	const waitingText = task.waitingOn ? ` · waiting=${task.waitingOn}` : "";
	const blockedText = task.blockedReason ? `\n  blocked: ${truncateText(task.blockedReason, 140)}` : "";
	return `- ${task.id} · ${action} · ${task.status} · parent=${task.parentTaskId ?? "-"} · ${truncateText(task.title, 72)}${waitingText}${agentText}${blockedText}`;
}

export function formatTaskSubtreePreviewAgentLine(preview: TaskSubtreeControlPreview, agent: AgentSummary): string {
	const willStop = preview.agentIdsToStop.includes(agent.id);
	const next = willStop ? "will request graceful stop (no force kill)" : "no stop request";
	return `- ${agent.id} · ${agent.profile} · ${agent.state} · task=${agent.taskId ?? "-"} · transport=${agent.transportState} · ${next}`;
}

export function formatTaskSubtreePreviewAttentionLine(item: AttentionItemRecord): string {
	return `- ${item.agentId} · ${item.kind} · ${item.state} · ${truncateText(item.summary, 140)}`;
}



export function formatTaskSubtreeCleanupLine(candidate: CleanupCandidate): string {
	const attention = candidate.attentionItems.length > 0 ? candidate.attentionItems.map((item) => item.kind).join(",") : "none";
	return `- ${candidate.cleanupAllowed ? "✓" : "-"} ${candidate.agent.id} · ${candidate.agent.state} · ${candidate.reason} · attention=${attention}`;
}

export function formatTaskSubtreeControlConsequences(preview: TaskSubtreeControlPreview): string[] {
	if (preview.action === "preview") return ["- Read-only preview; no task, agent, attention, or tmux state changes will be applied."];
	if (preview.action === "resume") {
		return [
			`- ${preview.taskIdsToUpdate.length} task(s) with ${SUBTREE_PAUSED_PREFIX} will move back to todo and clear pause blockers.`,
			"- Dependency checks still run after resume; tasks with unresolved dependencies may remain blocked.",
			"- No agents are spawned automatically; dispatch explicitly after reviewing the resumed subtree.",
		];
	}
	if (preview.action === "pause") {
		return [
			`- ${preview.taskIdsToUpdate.length} non-blocked open task(s) will move to blocked/waitingOn=coordinator with ${SUBTREE_PAUSED_PREFIX}.`,
			`- ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests; no force kill is used.`,
			"- Already blocked tasks keep their existing blocker state and receive only durable subtree-control notes when linked agents are affected.",
			"- Terminal cleanup candidates are not cleaned automatically; use subagent_cleanup after reviewing handoffs.",
		];
	}
	return [
		`- ${preview.taskIdsToUpdate.length} non-done task(s) will be parked blocked/waitingOn=coordinator with ${SUBTREE_CANCELLED_PREFIX}.`,
		`- ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests; no force kill is used.`,
		"- Cancel does not mark work accepted/done and does not delete task records; finalize or archive manually after reviewing notes.",
		"- Terminal cleanup candidates are not cleaned automatically; use subagent_cleanup after reviewing handoffs.",
	];
}

export function formatTaskSubtreeControlPreview(preview: TaskSubtreeControlPreview): string {
	const lines = [
		`# Subtree control preview · action=${preview.action}`,
		`root: ${preview.rootTask.id} · ${truncateText(preview.rootTask.title, 90)}`,
		`selection: ${preview.includeRoot ? "root task plus " : ""}recursive descendants via tasks.parentTaskId; linked agents come from task_agent_links plus agents.taskId for selected tasks.`,
		`confirmation: ${preview.action === "preview" ? "not required for read-only preview" : `rerun with confirm=true and previewToken=${preview.previewToken}`}`,
		`previewToken: ${preview.previewToken}`,
		`previewComplete: ${preview.isComplete ? "yes" : "no — apply is disabled until warnings are resolved"}`,
		preview.reason ? `reason: ${preview.reason}` : null,
		`counts: ${preview.tasks.length} task(s) (${formatTaskStatusCounts(preview.tasks)}) · ${preview.linkedAgents.length} linked agent(s) · ${preview.activeAgents.length} active · ${preview.blockers.length} blocked task(s) · ${preview.attentionItems.length} open attention · ${preview.cleanupCandidates.length} cleanup candidate(s)`,
		...preview.truncationWarnings.map((warning) => `warning: ${warning}`),
	]
		.filter((line): line is string => Boolean(line));
	lines.push("", "## Consequences", ...formatTaskSubtreeControlConsequences(preview));
	appendPreviewSection(lines, "Affected tasks", preview.tasks, (task) => formatTaskSubtreePreviewTaskLine(preview, task), preview.includeRoot ? "- none (root task not found)" : "- none (root excluded and no descendants)", 60);
	appendPreviewSection(lines, "Active linked agents", preview.activeAgents, (agent) => formatTaskSubtreePreviewAgentLine(preview, agent), "- none", 40);
	appendPreviewSection(lines, "Task blockers", preview.blockers, (task) => `- ${task.id} · waiting=${task.waitingOn ?? "-"} · ${truncateText(task.blockedReason ?? task.summary ?? task.title, 140)}`, "- none", 40);
	appendPreviewSection(lines, "Open attention", preview.attentionItems, formatTaskSubtreePreviewAttentionLine, "- none", 40);
	appendPreviewSection(lines, "Terminal cleanup candidates", preview.cleanupCandidates, formatTaskSubtreeCleanupLine, "- none", 40);
	return lines.join("\n");
}

export function formatTaskSubtreeControlConfirmation(preview: TaskSubtreeControlPreview): string {
	return [
		`Apply subtree ${preview.action} to ${preview.rootTask.id}?`,
		`${preview.taskIdsToUpdate.length} task(s) will be updated; ${preview.agentIdsToStop.length} active linked agent(s) will receive graceful stop requests.`,
		`${preview.blockers.length} blocked task(s), ${preview.attentionItems.length} open attention item(s), and ${preview.cleanupCandidates.length} cleanup candidate(s) were shown in the preview`,
		`Preview token required for tool/API apply: ${preview.previewToken}.`,
		preview.isComplete ? "Preview is complete; apply may proceed after confirmation." : "Preview is incomplete; apply is disabled until warnings are resolved.",
		"No force stop or cleanup will run from this action.",
	].join("\n");
}

export async function applyTaskSubtreeControl(
	ctx: ExtensionContext,
	rootTaskId: string,
	action: Exclude<TaskSubtreeControlAction, "preview">,
	options: { includeRoot?: boolean; reason?: string; previewToken?: string } = {},
): Promise<TaskSubtreeControlApplyResult> {
	const db = getMeepoDb();
	const preview = await buildTaskSubtreeControlPreview(ctx, rootTaskId, action, options);
	if (!preview.isComplete) {
		throw new Error(`Refusing to apply subtree ${action}: preview is incomplete. ${preview.truncationWarnings.join(" ")}`);
	}
	if (!options.previewToken || options.previewToken !== preview.previewToken) {
		throw new Error(`Refusing to apply subtree ${action}: rerun preview and pass previewToken=${preview.previewToken} with confirm=true to acknowledge the exact selection.`);
	}
	const now = Date.now();
	const reason = normalizeSubtreeReason(action, options.reason);
	const stopResults: TaskSubtreeControlApplyResult["stopResults"] = [];
	const stopErrors: TaskSubtreeControlApplyResult["stopErrors"] = [];
	const stopReason = `Subtree ${action} for ${preview.rootTask.id}: ${reason}`;
	for (const agent of preview.activeAgents.filter((item) => preview.agentIdsToStop.includes(item.id))) {
		try {
			const stopped = await stopAgentById(agent.id, false, stopReason);
			stopResults.push({
				agentId: stopped.agent.id,
				stopped: stopped.result.stopped,
				graceful: stopped.result.graceful,
				command: stopped.result.command,
				reason: stopped.result.reason,
			});
		} catch (error) {
			stopErrors.push({ agentId: agent.id, error: error instanceof Error ? error.message : String(error) });
		}
	}
	const taskIdsToUpdate = new Set(preview.taskIdsToUpdate);
	const updatedTasks: TaskRecord[] = [];
	for (const task of preview.tasks) {
		if (!taskIdsToUpdate.has(task.id)) continue;
		if (action === "pause") {
			updateTask(db, task.id, {
				status: "blocked",
				waitingOn: "coordinator",
				blockedReason: subtreeBlockedReason(SUBTREE_PAUSED_PREFIX, reason),
				updatedAt: now,
			});
			updatedTasks.push(getTask(db, task.id)!);
			continue;
		}
		if (action === "resume") {
			updateTask(db, task.id, {
				status: "todo",
				waitingOn: null,
				blockedReason: null,
				reviewRequestedAt: null,
				finishedAt: null,
				updatedAt: now,
			});
			updatedTasks.push(refreshTaskDependencyBlockState(db, task.id, now) ?? getTask(db, task.id)!);
			continue;
		}
		updateTask(db, task.id, {
			status: "blocked",
			waitingOn: "coordinator",
			blockedReason: subtreeBlockedReason(SUBTREE_CANCELLED_PREFIX, reason),
			finishedAt: null,
			updatedAt: now,
		});
		updatedTasks.push(getTask(db, task.id)!);
	}
	const updatedById = new Map(updatedTasks.map((task) => [task.id, task]));
	const noteTaskIds = new Set(preview.taskIdsToUpdate);
	for (const [taskId, agents] of preview.agentsByTaskId.entries()) {
		if (agents.some((agent) => preview.agentIdsToStop.includes(agent.id))) noteTaskIds.add(taskId);
	}
	let taskEventsCreated = 0;
	for (const taskId of noteTaskIds) {
		const before = preview.tasks.find((task) => task.id === taskId) ?? preview.rootTask;
		const after = updatedById.get(taskId) ?? getTask(db, taskId) ?? before;
		if (!updatedById.has(taskId)) updateTask(db, taskId, { updatedAt: now });
		const linkedStopAgentIds = (preview.agentsByTaskId.get(taskId) ?? [])
			.filter((agent) => preview.agentIdsToStop.includes(agent.id))
			.map((agent) => agent.id);
		createTaskEvent(db, {
			id: randomUUID(),
			taskId,
			eventType: "subtree_control",
			summary: `Subtree ${action} applied from root ${preview.rootTask.id}`,
			payload: {
				action,
				rootTaskId: preview.rootTask.id,
				reason,
				previousStatus: before.status,
				newStatus: after.status,
				previousWaitingOn: before.waitingOn,
				newWaitingOn: after.waitingOn,
				previousBlockedReason: before.blockedReason,
				newBlockedReason: after.blockedReason,
				gracefulStopRequestedAgentIds: linkedStopAgentIds,
				stopErrors: stopErrors.filter((item) => linkedStopAgentIds.includes(item.agentId)),
			},
			createdAt: now,
		});
		taskEventsCreated += 1;
	}
	return { preview, updatedTasks, stopResults, stopErrors, taskEventsCreated };
}

export function formatTaskSubtreeControlApplyResult(result: TaskSubtreeControlApplyResult): string {
	const lines = [
		`# Subtree control result · action=${result.preview.action}`,
		`root: ${result.preview.rootTask.id}`,
		`updatedTasks: ${result.updatedTasks.length}`,
		`gracefulStopRequests: ${result.stopResults.length}`,
		`stopErrors: ${result.stopErrors.length}`,
		`taskEventsCreated: ${result.taskEventsCreated}`,
	];
	appendPreviewSection(lines, "Updated tasks", result.updatedTasks, (task) => `- ${task.id} · ${task.status} · waiting=${task.waitingOn ?? "-"} · ${truncateText(task.title, 80)}`, "- none", 60);
	appendPreviewSection(lines, "Graceful stop requests", result.stopResults, (item) => `- ${item.agentId} · ${item.command} · ${item.reason ?? "queued"}`, "- none", 40);
	appendPreviewSection(lines, "Stop errors", result.stopErrors, (item) => `- ${item.agentId} · ${item.error}`, "- none", 40);
	return lines.join("\n");
}
