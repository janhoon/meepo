/**
 * Board: Tasks + Children + Attention projected into an operator view.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { openAgentsBoard, type AgentsBoardData, type BoardLaneId, type BoardTicket } from "./board.js";
import { getMeepoDb } from "./db.js";
import { listOpenAttention } from "./inbox.js";
import { getProjectKey } from "./project.js";
import { listAgents } from "./registry.js";
import { OPEN_ATTENTION_STATES } from "./registry-shared.js";
import { resolveAgentFilters, resolveOpenAttentionFilters, resolveTaskFilters } from "./session-scope.js";
import { buildTaskInteractionsByTask } from "./task-interactions.js";
import { deriveTaskHealth, listTaskAgentLinks, listTaskHealth, listTasks, taskLeaseKindForProfile } from "./task-registry.js";
import type { DatabaseSync } from "./sqlite.js";
import type { AgentSummary, AttentionItemRecord } from "./types.js";
import type { TaskRecord } from "./task-types.js";

export type { AgentsBoardData, BoardLaneId, BoardTicket };
export { openAgentsBoard };

export function buildDashboardData(ctx: ExtensionContext): import("./dashboard.js").AgentsDashboardData {
	const db = getMeepoDb();
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
	db: DatabaseSync,
	tasks: TaskRecord[],
	agents: AgentSummary[],
	attentionItems: AttentionItemRecord[],
): AgentsBoardData["scopes"]["all"] {
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
	const interactionsByTaskId = buildTaskInteractionsByTask(attentionItems, agentsById, taskIdSet);
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
		const activeLinkedAgents = linkedAgents.filter((agent) =>
			["launching", "running", "idle", "waiting", "blocked"].includes(agent.state),
		);
		const activeExclusiveOwners = activeLinkedAgents.filter(
			(agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "exclusive",
		);
		const activeReviewers = activeLinkedAgents.filter(
			(agent) => taskLeaseKindForProfile(linkRoleByTaskAgent.get(`${task.id}:${agent.id}`) ?? agent.profile) === "review",
		);
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

function attentionForScope(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session" | "descendants",
): AttentionItemRecord[] {
	return listOpenAttention(
		getMeepoDb(),
		scope === "all"
			? { states: OPEN_ATTENTION_STATES, limit: 500 }
			: resolveOpenAttentionFilters(ctx, scope, { limit: 500 }),
	);
}

export function buildBoardData(ctx: ExtensionContext): AgentsBoardData {
	const db = getMeepoDb();
	const projectKey = getProjectKey(ctx.cwd);
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
	const allAttention = attentionForScope(ctx, "all");
	const projectAttention = attentionForScope(ctx, "current_project");
	const sessionAttention = attentionForScope(ctx, "current_session");
	const descendantAttention = attentionForScope(ctx, "descendants");
	return {
		scopes: {
			all: buildBoardScopeData(db, scopeTasks.all, scopeAgents.all, allAttention),
			current_project: buildBoardScopeData(db, scopeTasks.current_project, scopeAgents.current_project, projectAttention),
			current_session: buildBoardScopeData(db, scopeTasks.current_session, scopeAgents.current_session, sessionAttention),
			descendants: buildBoardScopeData(db, scopeTasks.descendants, scopeAgents.descendants, descendantAttention),
		},
	};
}
