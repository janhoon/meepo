/**
 * Child upward publish (subagent_publish implementation core).
 */
import { randomUUID } from "node:crypto";
import { getMeepoDb } from "./db.js";
import {
	createAgentAttentionItemV2,
	createAgentEvent,
	createMessageWithRecipients,
	getAgent,
	listActiveAgentEdges,
	resolveAgentActorContext,
	updateAgent,
} from "./registry.js";
import { touchAttentionWakeFile } from "./paths.js";
import { applyChildPublishToLinkedTask } from "./task-registry.js";
import { truncateText } from "./text-util.js";
import { appendRunEvent, readLatestStatusFromDisk } from "./child-status.js";
import type {
	AgentRecipientRef,
	AgentThreadKind,
	ChildRuntimeEnvironment,
	DownwardMessagePayload,
	RuntimeStatusSnapshot,
	SubagentPublishPayload,
} from "./types.js";

const BRIDGE_TERMINAL_STATES = new Set<RuntimeStatusSnapshot["state"]>(["error", "stopped"]);
const CHILD_LOCAL_TERMINAL_STATES = new Set<RuntimeStatusSnapshot["state"]>(["done", "error", "stopped"]);

export function attentionPriority(kind: SubagentPublishPayload["kind"]): number | null {
	switch (kind) {
		case "question_for_user":
			return 0;
		case "question":
			return 1;
		case "blocked":
			return 2;
		case "complete":
			return 3;
		default:
			return null;
	}
}

export function publishThreadKind(kind: SubagentPublishPayload["kind"]): AgentThreadKind {
	switch (kind) {
		case "blocked":
			return "blocker";
		case "question":
		case "question_for_user":
			return "question";
		case "complete":
			return "handoff";
		case "milestone":
		case "note":
		default:
			return "task_update";
	}
}

export function resolvePublishRecipient(db: ReturnType<typeof getMeepoDb>, environment: ChildRuntimeEnvironment, kind: SubagentPublishPayload["kind"]): AgentRecipientRef {
	if (kind === "question_for_user") return { kind: "user" };
	const parentEdge = listActiveAgentEdges(db, { childAgentId: environment.childId, edgeType: "reports_to", limit: 1 })[0] ?? null;
	if (parentEdge) return { kind: "agent", agentId: parentEdge.parentAgentId };
	return { kind: "root" };
}

export function recipientLabel(recipient: AgentRecipientRef): string {
	return recipient.kind === "agent" ? `agent:${recipient.agentId}` : recipient.kind;
}



export function publishChildUpdate(
	environment: ChildRuntimeEnvironment,
	kind: SubagentPublishPayload["kind"],
	payload: Omit<SubagentPublishPayload, "kind">,
	state: RuntimeStatusSnapshot["state"],
): {
	recipient: AgentRecipientRef;
	messageId: string;
	routeKind: string;
	recipientRowIds: string[];
} {
	const db = getMeepoDb();
	const fullPayload: SubagentPublishPayload = { kind, ...payload };
	const agent = getAgent(db, environment.childId);
	if (!agent) throw new Error(`Cannot publish from unknown child agent ${environment.childId}.`);
	const actor = resolveAgentActorContext(db, { currentAgentId: environment.childId });
	const recipient = resolvePublishRecipient(db, environment, kind);
	createAgentEvent(db, {
		id: randomUUID(),
		agentId: environment.childId,
		eventType: kind,
		summary: payload.summary,
		payload: { ...fullPayload, recipient },
	});
	const priority = attentionPriority(kind);
	const deliveryMode = kind === "blocked" || kind === "question" || kind === "question_for_user" ? "immediate" : "follow_up";
	const messageResult = createMessageWithRecipients(db, {
		actor,
		recipients: [{ ...recipient, deliveryMode, transportKind: recipient.kind === "agent" ? "inbox" : null }],
		orgId: agent.orgId,
		projectKey: agent.projectKey,
		taskId: environment.taskId,
		subjectAgentId: environment.childId,
		kind,
		summary: payload.summary,
		bodyMarkdown: payload.details ?? null,
		payload: fullPayload,
		priority: priority ?? 3,
		requiresResponse: priority !== null,
		thread: { kind: publishThreadKind(kind), title: payload.summary },
	});
	const routeKind = messageResult.routes[0]?.routeKind ?? "multi_hop";
	const publishedPayload: SubagentPublishPayload & DownwardMessagePayload = {
		...fullPayload,
		senderKind: "agent",
		senderAgentId: environment.childId,
		routeKind,
	};
	if (priority !== null) {
		const attentionKind = kind as "question" | "question_for_user" | "blocked" | "complete";
		createAgentAttentionItemV2(db, {
			messageId: messageResult.message.id,
			recipientRowId: messageResult.recipients[0]?.id ?? null,
			orgId: messageResult.message.orgId,
			projectKey: agent.projectKey,
			taskId: environment.taskId,
			subjectAgentId: environment.childId,
			ownerKind: recipient.kind,
			ownerAgentId: recipient.kind === "agent" ? recipient.agentId : null,
			kind: attentionKind,
			priority,
			state: "waiting_on_owner",
			summary: payload.summary,
			payload: publishedPayload,
		});
		touchAttentionWakeFile();
	}
	appendRunEvent(environment, kind, payload.summary, { ...publishedPayload, recipient });
	const dbAgent = getAgent(db, environment.childId);
	const dbBridgeOwnedTerminal = !!dbAgent && BRIDGE_TERMINAL_STATES.has(dbAgent.state as RuntimeStatusSnapshot["state"]);
	// Also honor on-disk latest-status.json when the bridge (source === "rpc_bridge")
	// recorded a terminal state. DB reconciliation may lag briefly behind the disk write,
	// and the child-runtime must not regress a bridge-observed terminal state in either store.
	const onDiskStatus = readLatestStatusFromDisk(environment);
	const diskBridgeOwnedTerminal = !!onDiskStatus
		&& onDiskStatus.source === "rpc_bridge"
		&& BRIDGE_TERMINAL_STATES.has(onDiskStatus.state);
	const bridgeOwnedTerminal = dbBridgeOwnedTerminal || diskBridgeOwnedTerminal;
	const clearLastError = kind === "milestone" || kind === "note" || kind === "complete";
	updateAgent(db, environment.childId, {
		// Never regress a bridge-observed terminal state back to a non-terminal one.
		state: bridgeOwnedTerminal && !CHILD_LOCAL_TERMINAL_STATES.has(state) ? undefined : state,
		lastAssistantPreview: truncateText(payload.summary, 400),
		lastError: kind === "blocked" ? payload.summary : clearLastError ? null : undefined,
		finalSummary: kind === "complete" ? payload.summary : undefined,
		updatedAt: Date.now(),
		finishedAt: kind === "complete" ? Date.now() : undefined,
	});
	applyChildPublishToLinkedTask(db, {
		agentId: environment.childId,
		profile: environment.profile,
		kind,
		summary: payload.summary,
		details: payload.details,
		files: payload.files,
		taskStatus: payload.taskStatus,
		waitingOn: payload.waitingOn,
		blockedReason: payload.blockedReason,
		taskSummary: payload.taskSummary,
		acceptanceCriteria: payload.acceptanceCriteria,
		planSteps: payload.planSteps,
		validationSteps: payload.validationSteps,
		reviewSummary: payload.reviewSummary,
		finalSummary: payload.finalSummary,
	});
	return {
		recipient,
		messageId: messageResult.message.id,
		routeKind,
		recipientRowIds: messageResult.recipients.map((item) => item.id),
	};
}

