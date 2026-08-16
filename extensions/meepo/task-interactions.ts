/**
 * Task interaction projection from Inbox / Attention.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { listOpenAttention } from "./inbox.js";
import { getProjectKey } from "./project.js";
import { listAgents } from "./registry.js";
import type { ListAgentAttentionItemsV2Filters } from "./registry.js";
import { OPEN_AGENT_ATTENTION_V2_STATES, OPEN_ATTENTION_STATES, TERMINAL_AGENT_STATES } from "./registry-shared.js";
import {
	ROOT_SURFACE_OWNER_KINDS,
	resolveOwnedSubjectIds,
	withOwnedSubjectPin,
	type OwnershipScope,
} from "./session-scope.js";
import { listTaskAgentLinks } from "./task-registry.js";
import { actorLabelForInteraction } from "./formatters.js";
import type { AgentAttentionV2Record, AgentRecipientKind, AgentSummary, AttentionItemRecord, TaskInteractionRecord } from "./types.js";

/** Active Meepo config for this extension process (set on register). */
export function attentionOwnerKindsForAudience(audience?: "all" | "coordinator" | "user"): AgentRecipientKind[] | undefined {
	if (audience === "user") return ["user"];
	// Coordinator surfaces own root-bound attention only. Agent-owned items are 1:1 with the parent agent.
	if (audience === "coordinator") return ["root"];
	// Default (no audience) stays fail-closed on root surfaces: root+user, never agent-owned broadcast.
	if (audience === undefined) return [...ROOT_SURFACE_OWNER_KINDS];
	// audience === "all": no ownerKind pin (still subject-pinned by ownership seam when scope ≠ all).
	return undefined;
}

export function resolveAdminAttentionV2Filters(
	ctx: ExtensionContext,
	scope: OwnershipScope,
	params: {
		audience?: "all" | "coordinator" | "user";
		includeResolved?: boolean;
		limit?: number;
		/** Override default open-state set instead of mutating the returned bag. */
		states?: ListAgentAttentionItemsV2Filters["states"];
	} = {},
): ListAgentAttentionItemsV2Filters {
	const projectKey = getProjectKey(ctx.cwd);
	const filters: ListAgentAttentionItemsV2Filters = {
		limit: params.limit,
		ownerKinds: attentionOwnerKindsForAudience(params.audience),
		states:
			params.states !== undefined
				? params.states
				: params.includeResolved
					? undefined
					: ["open", "acknowledged", "waiting_on_owner"],
	};
	// Single ownership seam via withOwnedSubjectPin — empty array means no subjects (never fall-open).
	return withOwnedSubjectPin(filters, scope, resolveOwnedSubjectIds(ctx, scope, { projectKey }), {
		projectKey,
		idField: "subjectAgentIds",
	});
}

export function attentionV2MatchesAudience(item: AgentAttentionV2Record, audience?: "all" | "coordinator" | "user"): boolean {
	if (audience === "user") return item.ownerKind === "user";
	// Coordinator triage is root-owned (or agent-self path elsewhere); do not treat other agents' mail as coordinator mail.
	if (audience === "coordinator") return item.ownerKind === "root";
	return true;
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
	const taskId = payloadString(item.payload, "taskId") ?? agent?.taskId ?? null;
	if (!taskId) return null;
	const ownerKind: AgentRecipientKind =
		(payloadString(item.payload, "ownerKind") as AgentRecipientKind | null) ??
		(item.audience === "user" ? "user" : "root");
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
		addTaskInteraction(result, taskInteractionFromLegacyAttention(item, agentsById.get(item.agentId)), taskIds);
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



