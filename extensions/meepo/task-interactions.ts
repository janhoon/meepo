/**
 * Task interaction projection from Inbox / Attention.
 */
import { getMeepoDb } from "./db.js";
import { listOpenAttention, markAttentionById } from "./inbox.js";
import { listAgents } from "./registry.js";
import { OPEN_ATTENTION_STATES, TERMINAL_AGENT_STATES } from "./registry-shared.js";
import { actorLabelForInteraction } from "./formatters.js";
import { attentionOwnerKindsForAudience } from "./session-scope.js";
import { payloadString, payloadStringArray } from "./sql-util.js";
import { listTaskAgentLinks } from "./task-registry.js";
import type { AgentAttentionV2Record, AgentRecipientKind, AgentSummary, AttentionItemRecord, TaskInteractionRecord } from "./types.js";

export { attentionOwnerKindsForAudience };

export function attentionV2MatchesAudience(item: AgentAttentionV2Record, audience?: "all" | "coordinator" | "user"): boolean {
	if (audience === "user") return item.ownerKind === "user";
	if (audience === "coordinator") return item.ownerKind === "root";
	return true;
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

export function taskInteractionFromAttention(item: AttentionItemRecord, agent: AgentSummary | undefined): TaskInteractionRecord | null {
	const taskId = item.taskId ?? payloadString(item.payload, "taskId") ?? agent?.taskId ?? null;
	if (!taskId) return null;
	const ownerKind: AgentRecipientKind =
		(payloadString(item.payload, "ownerKind") as AgentRecipientKind | undefined) ??
		(item.audience === "user" ? "user" : "root");
	const messageId = item.messageId;
	const kind = taskInteractionKindFromAttention(item.kind, ownerKind);
	const actionInfo = buildTaskInteractionActions(kind, taskId, item.agentId, messageId, {
		interactionId: item.id,
		canMessageAgent: Boolean(agent && !TERMINAL_AGENT_STATES.includes(agent.state)),
	});
	return {
		id: item.id,
		taskId,
		agentId: item.agentId,
		actorLabel: actorLabelForInteraction(agent, item.agentId),
		ownerKind,
		ownerAgentId: null,
		kind,
		state: item.state,
		priority: item.priority,
		summary: item.summary,
		details: payloadString(item.payload, "details") ?? null,
		answerNeeded: payloadString(item.payload, "answerNeeded") ?? null,
		recommendedNextAction: payloadString(item.payload, "recommendedNextAction") ?? null,
		files: payloadStringArray(item.payload, "files"),
		messageId,
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
	items: AttentionItemRecord[],
	agentsById: Map<string, AgentSummary>,
	taskIds?: Set<string>,
): Map<string, TaskInteractionRecord[]> {
	const result = new Map<string, TaskInteractionRecord[]>();
	for (const item of items) {
		addTaskInteraction(result, taskInteractionFromAttention(item, agentsById.get(item.agentId)), taskIds);
	}
	for (const [taskId, interactions] of result.entries()) {
		result.set(taskId, sortTaskInteractionsByPriority(interactions));
	}
	return result;
}

export function listTaskInteractionsForTaskIds(taskIds: string[]): Map<string, TaskInteractionRecord[]> {
	if (taskIds.length === 0) return new Map();
	const db = getMeepoDb();
	const links = listTaskAgentLinks(db, { taskIds, limit: Math.max(1, Math.min(taskIds.length * 50, 500)) });
	const agentIds = Array.from(new Set(links.map((link) => link.agentId)));
	const agents = agentIds.length > 0 ? listAgents(db, { ids: agentIds, limit: agentIds.length }) : [];
	const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
	const items = listOpenAttention(db, {
		childIds: agentIds,
		taskIds,
		states: OPEN_ATTENTION_STATES,
		limit: 500,
	});
	return buildTaskInteractionsByTask(items, agentsById, new Set(taskIds));
}

export function getTaskInteractions(taskId: string): TaskInteractionRecord[] {
	return listTaskInteractionsForTaskIds([taskId]).get(taskId) ?? [];
}


export function resolvedInteractionState(resolutionKind: string): "resolved" | "superseded" | "cancelled" {
	if (resolutionKind === "cancelled") return "cancelled";
	if (["rejected", "changes_requested", "superseded"].includes(resolutionKind)) return "superseded";
	return "resolved";
}

export function resolveTaskInteractionWithNote(taskId: string, interactionId: string, resolutionKind: string, resolutionSummary: string): { changes: number } {
	const id = interactionId.trim();
	if (!id) {
		throw new Error(`Invalid task interaction id \"${interactionId}\".`);
	}
	const now = Date.now();
	const state = resolvedInteractionState(resolutionKind);
	return {
		changes: markAttentionById(
			getMeepoDb(),
			id,
			{
				state,
				updatedAt: now,
				resolvedAt: now,
				resolutionKind,
				resolutionSummary,
			},
			{ states: OPEN_ATTENTION_STATES, taskId },
		),
	};
}



