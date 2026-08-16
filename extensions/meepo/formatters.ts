/**
 * Pure-ish text/format helpers for Meepo coordinator surfaces.
 */
import { formatHost } from "./process-host.js";
import { truncateText } from "./text-util.js";
import { deriveTaskHealth, taskLeaseKindForProfile } from "./task-registry.js";
// Keep formatters free of DB access: callers that need live health pass a snapshot.
import type {
	AgentAttentionV2Record,
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentSummary,
	AttentionItemRecord,
	DownwardMessageActionPolicy,
	InboxEntry,
	FleetSummary,
	ListAgentsFilters,
	RuntimeStatusSnapshot,
	SpawnSubagentResult,
	TaskInteractionRecord,
} from "./types.js";
import type {
	ListTasksFilters,
	TaskAttentionRecord,
	TaskHealthSnapshot,
	TaskLinkWithTasksRecord,
	TaskReadinessRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
} from "./task-types.js";
import type {
	ListServicesFilters,
	ServiceSummary,
	SpawnServiceResult,
} from "./service-types.js";

export function stateIcon(state: AgentSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "idle":
		case "waiting":
			return "◌";
		case "blocked":
			return "⛔";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "stopped":
			return "■";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

export function messageKindLabel(message: AgentMessageRecord | null): string {
	if (!message) return "";
	switch (message.kind) {
		case "question_for_user":
			return "user question";
		case "question":
			return "question";
		case "blocked":
			return "blocker";
		case "milestone":
			return "milestone";
		case "complete":
			return "complete";
		default:
			return message.kind;
	}
}

export function formatAgentLine(agent: AgentSummary): string {
	const parts = [`${stateIcon(agent.state)} ${agent.id}`, `${agent.profile}`, truncateText(agent.title, 40)];
	if (agent.taskId) parts.push(`task=${agent.taskId}`);
	if (agent.transportKind === "rpc_bridge") {
		parts.push(`transport=${agent.transportState}`);
	}
	if (agent.unreadCount > 0) {
		parts.push(`${agent.unreadCount} unread`);
	}
	if (agent.latestUnreadMessage) {
		parts.push(messageKindLabel(agent.latestUnreadMessage));
	}
	return parts.join(" · ");
}

export function formatAgentDetails(agent: AgentSummary): string {
	const lines = [
		`id: ${agent.id}`,
		`state: ${agent.state}`,
		`profile: ${agent.profile}`,
		`title: ${agent.title}`,
		`task: ${agent.task}`,
		`projectKey: ${agent.projectKey}`,
		`taskId: ${agent.taskId ?? "-"}`,
		`parentAgentId: ${agent.parentAgentId ?? "-"}`,
		`orgId: ${agent.orgId ?? "-"}`,
		`roleKey: ${agent.roleKey ?? "-"}`,
		`spawnedByAgentId: ${agent.spawnedByAgentId ?? "-"}`,
		`hierarchyState: ${agent.hierarchyState}`,
		`spawnCwd: ${agent.spawnCwd}`,
		`spawnSessionId: ${agent.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${agent.spawnSessionFile ?? "-"}`,
		`model: ${agent.model ?? "-"}`,
		`transportKind: ${agent.transportKind}`,
		`transportState: ${agent.transportState}`,
		`runDir: ${agent.runDir}`,
		`sessionFile: ${agent.sessionFile}`,
		`bridgeSocketPath: ${agent.bridgeSocketPath ?? "-"}`,
		`bridgeStatusFile: ${agent.bridgeStatusFile ?? "-"}`,
		`bridgeLogFile: ${agent.bridgeLogFile ?? "-"}`,
		`bridgeEventsFile: ${agent.bridgeEventsFile ?? "-"}`,
		`bridgePid: ${agent.bridgePid ?? "-"}`,
		`bridgeConnectedAt: ${agent.bridgeConnectedAt ? new Date(agent.bridgeConnectedAt).toISOString() : "-"}`,
		`bridgeUpdatedAt: ${agent.bridgeUpdatedAt ? new Date(agent.bridgeUpdatedAt).toISOString() : "-"}`,
		`bridgeLastError: ${agent.bridgeLastError ?? "-"}`,
		`host: ${formatHost(agent.host)}`,
		`lastToolName: ${agent.lastToolName ?? "-"}`,
		`lastAssistantPreview: ${agent.lastAssistantPreview ?? "-"}`,
		`lastError: ${agent.lastError ?? "-"}`,
		`finalSummary: ${agent.finalSummary ?? "-"}`,
		`unreadCount: ${agent.unreadCount}`,
		`createdAt: ${new Date(agent.createdAt).toISOString()}`,
		`updatedAt: ${new Date(agent.updatedAt).toISOString()}`,
		`finishedAt: ${agent.finishedAt ? new Date(agent.finishedAt).toISOString() : "-"}`,
	];
	if (agent.latestUnreadMessage) {
		lines.push("");
		lines.push("latestUnreadMessage:");
		lines.push(JSON.stringify(agent.latestUnreadMessage, null, 2));
	}
	if (agent.tools !== null) {
		lines.push("");
		lines.push("tools:");
		lines.push(JSON.stringify(agent.tools, null, 2));
	}
	return lines.join("\n");
}

export function getTaskHealthSnapshot(task: TaskRecord): TaskHealthSnapshot {
	return deriveTaskHealth({ task });
}

export function formatTaskLine(task: TaskRecord, linkedAgents: AgentSummary[] = [], readiness?: TaskReadinessRecord, health: TaskHealthSnapshot = getTaskHealthSnapshot(task)): string {
	const activeLinkedAgents = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state));
	const activeExclusiveOwners = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(agent.profile) === "exclusive");
	const activeReviewers = activeLinkedAgents.filter((agent) => taskLeaseKindForProfile(agent.profile) === "review");
	const flags = [
		`status=${task.status}`,
		`health=${health.state}`,
		`lastUseful=${formatStandupAge(health.lastUsefulUpdateAt ?? 0)}`,
		task.waitingOn ? `waiting=${task.waitingOn}` : null,
		task.recommendedProfile ? `profile=${task.recommendedProfile}` : null,
		readiness && readiness.unresolvedDependencies.length > 0 ? `deps=${readiness.unresolvedDependencies.length}` : null,
		activeExclusiveOwners.length > 0 ? `owner=${activeExclusiveOwners.map((agent) => agent.id).join(",")}` : null,
		activeReviewers.length > 0 ? `reviewers=${activeReviewers.length}` : null,
		`p${task.priority}`,
		linkedAgents.length > 0 ? `${linkedAgents.length} agent${linkedAgents.length === 1 ? "" : "s"}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${task.id} · ${truncateText(task.title, 48)} · ${flags}\n  next: ${health.nextAction}`;
}

export function formatTaskLinkLine(link: TaskLinkWithTasksRecord, perspective: "dependency" | "dependent" | "any" = "any"): string {
	const direction =
		perspective === "dependency"
			? `depends on ${link.targetTaskId}`
			: perspective === "dependent"
				? `blocks ${link.sourceTaskId}`
				: `${link.sourceTaskId} -> ${link.targetTaskId}`;
	const unresolved = link.unresolved ? "unresolved" : link.state === "resolved" || link.targetStatus === "done" ? "resolved" : link.state;
	const title = perspective === "dependent" ? link.sourceTitle : link.targetTitle;
	return `- ${link.id} · ${link.linkType} · ${direction} · ${unresolved} · ${truncateText(title, 60)}${link.summary ? ` — ${truncateText(link.summary, 80)}` : ""}`;
}

export function formatTaskReadinessLine(item: TaskReadinessRecord): string {
	const profile = item.task.recommendedProfile ? ` · profile=${item.task.recommendedProfile}` : "";
	const deps = item.unresolvedDependencies.length > 0 ? ` · blockedBy=${item.unresolvedDependencies.map((link) => link.targetTaskId).join(",")}` : "";
	return `- ${item.task.id} · ${truncateText(item.task.title, 60)} · ${item.reason}${profile}${deps}`;
}

export function buildTaskLinksText(links: TaskLinkWithTasksRecord[]): string {
	if (links.length === 0) return "No task links matched.";
	return links.map((link) => formatTaskLinkLine(link)).join("\n");
}

export function buildTaskReadyText(items: TaskReadinessRecord[], includeBlocked: boolean): string {
	const visible = includeBlocked ? items : items.filter((item) => item.ready);
	if (visible.length === 0) return includeBlocked ? "No matching tasks found." : "No dependency-ready tasks found.";
	return visible.map(formatTaskReadinessLine).join("\n");
}

export function taskStatusCounts(tasks: TaskRecord[]): Record<TaskState, number> {
	return tasks.reduce<Record<TaskState, number>>(
		(counts, task) => {
			counts[task.status] += 1;
			return counts;
		},
		{ todo: 0, blocked: 0, in_progress: 0, in_review: 0, done: 0 },
	);
}

export function formatTaskStatusCounts(tasks: TaskRecord[]): string {
	const counts = taskStatusCounts(tasks);
	return [`todo=${counts.todo}`, `blocked=${counts.blocked}`, `in_progress=${counts.in_progress}`, `in_review=${counts.in_review}`, `done=${counts.done}`].join(" · ");
}

export function appendPreviewSection<T>(lines: string[], title: string, items: T[], formatter: (item: T) => string, empty = "- none", limit = 40): void {
	lines.push("", `## ${title}`);
	if (items.length === 0) {
		lines.push(empty);
		return;
	}
	for (const item of items.slice(0, limit)) lines.push(formatter(item));
	if (items.length > limit) lines.push(`- display truncated: showing ${limit} of ${items.length}; apply still uses the full counted selection when previewComplete=true`);
}

export function formatTaskCounts(summary: TaskSummaryCounts): string | undefined {
	if (summary.todo === 0 && summary.blocked === 0 && summary.inProgress === 0 && summary.inReview === 0 && summary.done === 0) {
		return undefined;
	}
	return `🗂 ${summary.todo} todo · ${summary.blocked} blocked · ${summary.inProgress} in-progress · ${summary.inReview} review · ${summary.done} done`;
}

export function formatFleetSummary(taskSummary: TaskSummaryCounts, agentSummary: FleetSummary): string | undefined {
	const taskText = formatTaskCounts(taskSummary);
	const hasAgentSignals = agentSummary.active > 0 || agentSummary.blocked > 0 || agentSummary.attentionOpen > 0 || agentSummary.unread > 0;
	const agentText =
		!taskText && !hasAgentSignals
			? undefined
			: `🤖 ${agentSummary.active} active · ${agentSummary.blocked} blocked · ${agentSummary.attentionOpen} open attention · ${agentSummary.unread} unread`;
	if (!taskText && !agentText) return undefined;
	return [taskText, agentText].filter((value): value is string => Boolean(value)).join(" · ");
}

export function attentionItemLabel(item: AttentionItemRecord): string {
	switch (item.kind) {
		case "question_for_user":
			return item.state === "waiting_on_user" ? "waiting on user" : "user question";
		case "question":
			return "question";
		case "blocked":
			return "blocker";
		case "complete":
			return "completion";
		default:
			return item.kind;
	}
}

export function attentionItemIcon(item: AttentionItemRecord): string {
	switch (item.kind) {
		case "question_for_user":
			return "❓";
		case "question":
			return "?";
		case "blocked":
			return "⛔";
		case "complete":
			return "✓";
		default:
			return "•";
	}
}

export function formatAttentionWakeup(item: AttentionItemRecord, agent: AgentSummary | undefined): string {
	const payload = (item.payload && typeof item.payload === "object" ? item.payload : {}) as {
		details?: string;
		files?: string[];
		answerNeeded?: string;
		recommendedNextAction?: string;
	};
	const lines = [
		`Child ${agent?.id ?? item.agentId} (${agent?.profile ?? "agent"}) reported a ${attentionItemLabel(item)}.`,
		`Summary: ${item.summary}`,
		agent?.title ? `Title: ${agent.title}` : null,
		payload.answerNeeded ? `Answer needed: ${payload.answerNeeded}` : null,
		payload.recommendedNextAction ? `Recommended next action: ${payload.recommendedNextAction}` : null,
		payload.details ? `Details: ${payload.details}` : null,
		Array.isArray(payload.files) && payload.files.length > 0 ? `Files: ${payload.files.join(", ")}` : null,
	].filter((line): line is string => Boolean(line));
	if (item.kind === "complete") {
		lines.push("Review the handoff, then decide whether to move the linked task or delegate follow-on work.");
		return lines.join("\n");
	}
	lines.push("Respond with concrete guidance, exact file paths, and only one answer or redirect at a time if clarification is needed.");
	return lines.join("\n");
}

export function formatAttentionItemLine(item: AttentionItemRecord, agent: AgentSummary | undefined): string {
	const title = agent ? truncateText(agent.title, 32) : item.agentId;
	return `${attentionItemIcon(item)} ${item.kind} · ${item.state} · ${item.audience} · ${title} · ${item.agentId}`;
}

export function buildAttentionText(items: AttentionItemRecord[], agentsById: Map<string, AgentSummary>, includeResolved: boolean): string {
	if (items.length === 0) return includeResolved ? "No attention items matched." : "No open attention items.";
	return items
		.map((item) => {
			const agent = agentsById.get(item.agentId);
			const payloadText = truncateText(JSON.stringify(item.payload), 180);
			return `${formatAttentionItemLine(item, agent)}\nsummary: ${item.summary}\npayload: ${payloadText}`;
		})
		.join("\n\n");
}

export function buildAttentionV2Text(items: AgentAttentionV2Record[], agentsById: Map<string, AgentSummary>, includeResolved: boolean): string {
	if (items.length === 0) return includeResolved ? "No hierarchy attention items matched." : "No open hierarchy attention items.";
	return items
		.map((item) => {
			const subject = item.subjectAgentId ? agentsById.get(item.subjectAgentId) : undefined;
			const owner = item.ownerKind === "agent" && item.ownerAgentId ? agentsById.get(item.ownerAgentId) : undefined;
			const payloadText = truncateText(JSON.stringify(item.payload), 180);
			return `${item.kind} · ${item.state} · owner=${item.ownerKind}:${item.ownerAgentId ?? "-"}${owner ? ` (${owner.profile})` : ""} · subject=${item.subjectAgentId ?? "-"}${subject ? ` (${truncateText(subject.title, 32)})` : ""}\nsummary: ${item.summary}\nmessageId: ${item.messageId ?? "-"}\nrecipientRowId: ${item.recipientRowId ?? "-"}\npayload: ${payloadText}`;
		})
		.join("\n\n");
}

export function buildAdminAttentionText(
	legacyItems: AttentionItemRecord[],
	v2Items: AgentAttentionV2Record[],
	agentsById: Map<string, AgentSummary>,
	includeResolved: boolean,
): string {
	if (legacyItems.length === 0 && v2Items.length === 0) return includeResolved ? "No attention items matched." : "No open attention items.";
	const sections: string[] = [];
	if (legacyItems.length > 0) sections.push(`Legacy attention\n${buildAttentionText(legacyItems, agentsById, includeResolved)}`);
	if (v2Items.length > 0) sections.push(`Hierarchy attention\n${buildAttentionV2Text(v2Items, agentsById, includeResolved)}`);
	return sections.join("\n\n");
}

export function buildInboxText(messages: InboxEntry[], readReceiptCount = 0): string {
	if (messages.length === 0) return "No unread child-originated messages.";
	const body = messages
		.map((message) => {
			const extra = [message.details, message.actionPolicy].filter(Boolean).join(" · ");
			return `${message.id} · ${message.kind} · ${message.direction} · child=${message.childId ?? "-"}\n${truncateText(extra || message.summary, 160)}`;
		})
		.join("\n\n");
	if (readReceiptCount <= 0) return body;
	return `${body}\n\nRead receipt: marked ${readReceiptCount} message${readReceiptCount === 1 ? "" : "s"} delivered. Future unread inbox reads will omit ${readReceiptCount === 1 ? "it" : "them"}; pass includeDelivered=true for history.`;
}

export function buildInboxV2Text(messages: AgentInboxMessageV2Record[], readReceiptCount = 0): string {
	if (messages.length === 0) return "No unread hierarchy inbox messages.";
	const body = messages
		.map((entry) => {
			const payloadText = truncateText(JSON.stringify(entry.message.payload), 180);
			const recipient = entry.recipient.recipientKind === "agent" ? entry.recipient.recipientAgentId : entry.recipient.recipientKind;
			return `${entry.message.id} · ${entry.message.kind} · sender=${entry.message.senderKind}:${entry.message.senderAgentId ?? "-"} · recipient=${entry.recipient.recipientKind}:${recipient ?? "-"} · recipientRow=${entry.recipient.id} · status=${entry.recipient.status} · route=${entry.recipient.routeId ?? "-"}\n${payloadText}`;
		})
		.join("\n\n");
	if (readReceiptCount <= 0) return body;
	return `${body}\n\nRead receipt: marked ${readReceiptCount} recipient row${readReceiptCount === 1 ? "" : "s"} read. Future unread inbox reads will omit ${readReceiptCount === 1 ? "it" : "them"}; pass includeDelivered=true for history.`;
}

export function formatCleanupCandidates(candidates: CleanupCandidate[], dryRun: boolean): string {
	if (candidates.length === 0) {
		return dryRun ? "No terminal agents matched for cleanup preview." : "No terminal agents matched for cleanup.";
	}
	const header = dryRun ? `Cleanup preview · ${candidates.length} candidate(s)` : `Cleanup candidates · ${candidates.length}`;
	const body = candidates
		.map((candidate) => {
			const attention = candidate.attentionItems.length > 0 ? candidate.attentionItems.map((item) => item.kind).join(",") : "none";
			return `${candidate.cleanupAllowed ? "✓" : "-"} ${candidate.agent.id} · ${candidate.agent.state} · ${candidate.reason} · attention=${attention}`;
		})
		.join("\n");
	return `${header}\n\n${body}`;
}

export function formatCleanupResults(
	results: Array<{ agentId: string; cleaned: boolean; reason: string; command: string }>,
	skipped: CleanupCandidate[],
): string {
	const cleaned = results.filter((result) => result.cleaned);
	const lines = [
		`Cleanup finished · ${cleaned.length} cleaned · ${skipped.length} skipped`,
		"",
		...cleaned.map((result) => `✓ ${result.agentId} · ${result.reason} · ${result.command}`),
		...skipped.map((candidate) => `- ${candidate.agent.id} · ${candidate.reason}`),
	];
	return lines.join("\n");
}

export function buildTaskDispatchText(
	result: {
		preview: Array<{ taskId: string; title: string; profile: string }>;
		dispatched: Array<{ taskId: string; agentId: string; profile: string }>;
		skipped: Array<{ taskId: string; reason: string }>;
	},
	dryRun: boolean,
): string {
	const lines = [dryRun ? "# Ready dispatch preview" : "# Ready dispatch result"];
	if (result.preview.length > 0) {
		lines.push("", "Dispatchable:", ...result.preview.map((item) => `- ${item.taskId} · ${truncateText(item.title, 60)} · profile=${item.profile}`));
	}
	if (result.dispatched.length > 0) {
		lines.push("", "Dispatched:", ...result.dispatched.map((item) => `- ${item.taskId} · ${item.agentId} · profile=${item.profile}`));
	}
	if (result.skipped.length > 0) {
		lines.push("", "Skipped:", ...result.skipped.map((item) => `- ${item.taskId} · ${item.reason}`));
	}
	if (result.preview.length === 0 && result.skipped.length === 0) lines.push("", "No dependency-ready tasks found.");
	return lines.join("\n");
}

export function formatSpawnSuccess(result: SpawnSubagentResult): string {
	return [
		`Spawned ${result.agentId} (${result.profile})`,
		"",
		`title: ${result.title}`,
		`taskId: ${result.taskId ?? "-"}`,
		`cwd: ${result.spawnCwd}`,
		`runDir: ${result.runDir}`,
		`sessionFile: ${result.sessionFile}`,
		`transport: ${result.transportKind} ${result.transportState}`,
		`bridgeSocketPath: ${result.bridgeSocketPath ?? "-"}`,
		`bridgeStatusFile: ${result.bridgeStatusFile ?? "-"}`,
		`bridgeLogFile: ${result.bridgeLogFile ?? "-"}`,
		`host: ${formatHost(result.host)}`,
	].join("\n");
}

export function formatFocusResult(agent: AgentSummary, result: { focused: boolean; command: string; reason?: string }): string {
	return [
		result.focused
			? `Focused ${agent.id} on ${formatHost(agent.host)}.`
			: `Could not switch the current pi client automatically for ${agent.id}.`,
		result.reason ? `reason: ${result.reason}` : null,
		`host: ${formatHost(agent.host)}`,
		`manual command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function formatStopResult(
	agent: AgentSummary,
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string },
	force: boolean,
): string {
	return [
		force ? `Force stop issued for ${agent.id}.` : `Stop requested for ${agent.id}.`,
		`mode: ${force ? "force" : result.graceful ? "graceful" : "graceful-request"}`,
		result.reason ? `reason: ${result.reason}` : null,
		`host command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function formatReconcileResult(result: { scope: string; reconciled: number; changed: Array<{ id: string; state: string; transportState: string; reason: string }> }): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} agents in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} agents in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · transport=${item.transportState} · ${item.reason}`),
	].join("\n");
}

export function serviceStateIcon(state: ServiceSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "stopped":
			return "■";
		case "error":
			return "✗";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

export function formatServiceLine(service: ServiceSummary): string {
	const parts = [
		`${serviceStateIcon(service.state)} ${service.id}`,
		truncateText(service.title, 32),
		truncateText(service.command, 54),
	];
	const ready = serviceReadyLabel(service);
	if (ready) parts.push(ready);
	return parts.join(" · ");
}

export function formatServiceDetails(service: ServiceSummary): string {
	const lines = [
		`id: ${service.id}`,
		`state: ${service.state}`,
		`title: ${service.title}`,
		`command: ${service.command}`,
		`projectKey: ${service.projectKey}`,
		`spawnCwd: ${service.spawnCwd}`,
		`spawnSessionId: ${service.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${service.spawnSessionFile ?? "-"}`,
		`readySubstring: ${service.readySubstring ?? "-"}`,
		`readyMatchedAt: ${service.readyMatchedAt ? new Date(service.readyMatchedAt).toISOString() : "-"}`,
		`runDir: ${service.runDir}`,
		`logFile: ${service.logFile}`,
		`latestStatusFile: ${service.latestStatusFile}`,
		`host: ${formatHost(service.host)}`,
		`lastExitCode: ${service.lastExitCode ?? "-"}`,
		`lastError: ${service.lastError ?? "-"}`,
		`createdAt: ${new Date(service.createdAt).toISOString()}`,
		`updatedAt: ${new Date(service.updatedAt).toISOString()}`,
		`finishedAt: ${service.finishedAt ? new Date(service.finishedAt).toISOString() : "-"}`,
	];
	if (service.env && Object.keys(service.env).length > 0) {
		lines.push("");
		lines.push("env:");
		lines.push(JSON.stringify(service.env, null, 2));
	}
	return lines.join("\n");
}

export function formatServiceStartResult(result: SpawnServiceResult): string {
	const readyText = result.readySubstring
		? result.readyMatched
			? `matched ${JSON.stringify(result.readySubstring)}`
			: result.readyTimedOut
				? `timed out waiting for ${JSON.stringify(result.readySubstring)}`
				: `did not match ${JSON.stringify(result.readySubstring)}`
		: "not requested";
	return [
		`Started ${result.serviceId}`,
		"",
		`title: ${result.title}`,
		`command: ${result.command}`,
		`cwd: ${result.spawnCwd}`,
		`state: ${result.state}`,
		`ready: ${readyText}`,
		`runDir: ${result.runDir}`,
		`logFile: ${result.logFile}`,
		`latestStatusFile: ${result.latestStatusFile}`,
		`host: ${formatHost(result.host)}`,
	].join("\n");
}

export function formatServiceFocusResult(service: ServiceSummary, result: { focused: boolean; command: string; reason?: string }): string {
	return [
		result.focused
			? `Focused ${service.id} on ${formatHost(service.host)}.`
			: `Could not switch the current pi client automatically for ${service.id}.`,
		result.reason ? `reason: ${result.reason}` : null,
		`host: ${formatHost(service.host)}`,
		`manual command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function formatServiceStopResult(
	service: ServiceSummary,
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string },
	force: boolean,
): string {
	return [
		force ? `Force stop issued for ${service.id}.` : `Stop requested for ${service.id}.`,
		`mode: ${force ? "force" : result.graceful ? "graceful" : "graceful-request"}`,
		result.reason ? `reason: ${result.reason}` : null,
		`host command: ${result.command}`,
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

export function formatServiceReconcileResult(result: {
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
}): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} services in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} services in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · ${item.reason}`),
	].join("\n");
}

export function formatTaskAttentionLine(item: TaskAttentionRecord): string {
	const bits = [
		item.status,
		`health=${item.health}`,
		`lastUseful=${formatStandupAge(item.lastUsefulUpdateAt ?? 0)}`,
		item.waitingOn ? `waiting=${item.waitingOn}` : null,
		item.unresolvedDependencyCount > 0 ? `deps=${item.unresolvedDependencyCount}` : null,
		item.readyUnblocked ? "dependency-ready" : null,
		`${item.activeAgentCount} active-agent`,
		`${item.openAttentionCount} attention`,
	]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
	return `${item.taskId} · ${truncateText(item.title, 42)} · ${bits}`;
}

export function buildTaskAttentionText(items: TaskAttentionRecord[], interactionsByTask: Map<string, TaskInteractionRecord[]> = new Map()): string {
	if (items.length === 0) return "No task attention items.";
	return items
		.map((item) => {
			const interactions = interactionsByTask.get(item.taskId) ?? [];
			const interactionText = interactions.length > 0 ? `\ninteractions:\n${interactions.map(formatTaskInteractionCard).join("\n")}` : "";
			return `${formatTaskAttentionLine(item)}\nnext: ${item.nextAction}\nsummary: ${item.summary}\nblocked: ${item.blockedReason ?? "-"}\nreview: ${item.reviewSummary ?? "-"}${interactionText}`;
		})
		.join("\n\n");
}

export function formatAttentionGateWarning(items: AttentionItemRecord[], agentsById: Map<string, AgentSummary>): string {
	if (items.length === 0) return "";
	const preview = items.slice(0, 3).map((item) => `- ${formatAttentionItemLine(item, agentsById.get(item.agentId))}`).join("\n");
	return `Attention gate: ${items.length} unresolved attention item(s) already exist.\n${preview}`;
}

export function formatTaskInteractionCard(interaction: TaskInteractionRecord): string {
	const lines = [
		`- ${taskInteractionIcon(interaction.kind)} ${taskInteractionLabel(interaction.kind)} · ${interaction.state} · from=${interaction.actorLabel} · owner=${ownerLabelForInteraction(interaction)}`,
		`  summary: ${interaction.summary}`,
	];
	if (interaction.answerNeeded) lines.push(`  answerNeeded: ${interaction.answerNeeded}`);
	if (interaction.recommendedNextAction) lines.push(`  childNext: ${interaction.recommendedNextAction}`);
	if (interaction.details) lines.push(`  details: ${truncateText(interaction.details, 220)}`);
	if (interaction.files.length > 0) lines.push(`  files: ${interaction.files.join(", ")}`);
	lines.push(`  next: ${interaction.nextAction}`);
	for (const action of interaction.actions) lines.push(`  action: ${action}`);
	return lines.join("\n");
}

export function taskInteractionIcon(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "❓";
		case "coordinator_question":
			return "?";
		case "approval_request":
			return "☑";
		case "change_request":
			return "↻";
		case "blocker":
			return "⛔";
		case "completion":
			return "✓";
		default:
			return "•";
	}
}

export function taskInteractionLabel(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "user question";
		case "coordinator_question":
			return "coordinator question";
		case "approval_request":
			return "approval request";
		case "change_request":
			return "change request";
		case "blocker":
			return "blocker";
		case "completion":
			return "completion";
		default:
			return kind;
	}
}

export function actorLabelForInteraction(agent: AgentSummary | undefined, fallbackAgentId: string | null): string {
	if (agent) return `${agent.profile}:${agent.id}`;
	return fallbackAgentId ? `agent:${fallbackAgentId}` : "system";
}

export function ownerLabelForInteraction(interaction: TaskInteractionRecord): string {
	return interaction.ownerKind === "agent" ? `agent:${interaction.ownerAgentId ?? "-"}` : interaction.ownerKind;
}

export function summarizeFilters(scope: string, filters: ListAgentsFilters): string {
	const parts = [scope];
	if (filters.activeOnly) parts.push("active-only");
	if (filters.blockedOnly) parts.push("blocked-only");
	if (filters.unreadOnly) parts.push("unread-only");
	return parts.join(", ");
}

export function summarizeTaskFilters(scope: string, filters: ListTasksFilters): string {
	const parts = [scope];
	if (filters.statuses && filters.statuses.length > 0) parts.push(`statuses=${filters.statuses.join(",")}`);
	if (filters.waitingOn && filters.waitingOn.length > 0) parts.push(`waitingOn=${filters.waitingOn.join(",")}`);
	if (filters.recommendedProfile) parts.push(`recommendedProfile=${filters.recommendedProfile}`);
	if (filters.includeDone) parts.push("include-done");
	if (filters.linkedAgentId) parts.push(`linkedAgent=${filters.linkedAgentId}`);
	return parts.join(", ");
}

export function summarizeServiceFilters(scope: string, filters: ListServicesFilters): string {
	const parts = [scope];
	if (filters.activeOnly) parts.push("active-only");
	return parts.join(", ");
}

export function serviceReadyLabel(service: ServiceSummary): string | null {
	if (!service.readySubstring) return null;
	if (service.readyMatchedAt) return "ready";
	if (["stopped", "error", "lost"].includes(service.state)) return "not-ready";
	return "waiting-ready";
}

export function formatDownwardMessageForChild(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
	const actionPolicy = payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind as "answer" | "note" | "redirect" | "cancel" | "priority");
	const sender = payload.senderAgentId ?? message.senderAgentId ?? "root";
	const route = payload.routeKind ? ` · route ${payload.routeKind}` : "";
	const lines = [`[Hierarchy ${message.kind} · from ${sender} · action ${actionPolicy}${route}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.inReplyToMessageId) {
		lines.push("", `Replying to message: ${payload.inReplyToMessageId}`);
	}
	if (payload.coalescedMessageIds && payload.coalescedMessageIds.length > 0) {
		lines.push("", `Coalesced prior resume/wake messages: ${payload.coalescedMessageIds.join(", ")}`);
	}
	if (payload.coalescedWakeMessages && payload.coalescedWakeMessages.length > 0) {
		lines.push("", "Prior coalesced wake context:");
		for (const prior of payload.coalescedWakeMessages) {
			lines.push(`- ${prior.kind} ${prior.id}: ${prior.summary}`);
			if (prior.details) lines.push(`  details: ${truncateText(prior.details, 220)}`);
			if (prior.files && prior.files.length > 0) lines.push(`  files: ${prior.files.join(", ")}`);
			if (prior.inReplyToMessageId) lines.push(`  inReplyToMessageId: ${prior.inReplyToMessageId}`);
		}
	}
	lines.push("", "Expected handling:");
	for (const line of expectedDownwardHandlingLines(actionPolicy)) {
		lines.push(`- ${line}`);
	}
	return lines.join("\n");
}

export function expectedDownwardHandlingLines(actionPolicy: DownwardMessageActionPolicy): string[] {
	switch (actionPolicy) {
		case "resume_if_blocked":
			return [
				"If this resolves your current blocker or waiting state, resume work now.",
				"Publish a concise note once you resume so the coordinator can track progress without capture.",
				"If you are still blocked after this message, publish one concrete blocker or question immediately.",
			];
		case "replan":
			return [
				"Revise your plan before the next substantive tool call if this changes your priorities.",
				"Publish a concise note if the plan or file focus changes.",
			];
		case "interrupt_and_replan":
			return [
				"Stop the current approach and replan before more substantive work.",
				"Publish a concise note after adopting this redirect, with exact file paths when relevant.",
			];
		case "stop":
			return [
				"Stop current work gracefully.",
				"Publish a completion-style handoff or cancellation summary before exiting if possible.",
			];
		case "fyi":
		default:
			return [
				"Treat this as additional context. Continue unless it materially changes your plan.",
				"Publish a concise note only if this changes your course of action.",
			];
	}
}

export function defaultDownwardActionPolicy(kind: "answer" | "note" | "redirect" | "cancel" | "priority"): DownwardMessageActionPolicy {
	switch (kind) {
		case "answer":
			return "resume_if_blocked";
		case "redirect":
			return "interrupt_and_replan";
		case "cancel":
			return "stop";
		case "priority":
			return "replan";
		case "note":
		default:
			return "fyi";
	}
}

export function formatTaskDetails(
	task: TaskRecord,
	linkedAgents: AgentSummary[] = [],
	events: ReturnType<typeof listTaskEvents> = [],
	links: { dependencies?: TaskLinkWithTasksRecord[]; dependents?: TaskLinkWithTasksRecord[] } = {},
	interactions: TaskInteractionRecord[] = [],
	health: TaskHealthSnapshot = getTaskHealthSnapshot(task),
): string {
	const lines = [
		`id: ${task.id}`,
		`status: ${task.status} (Kanban lane; health is derived separately)`,
		`health: ${health.state}`,
		`healthSignals: ${health.signals.join(", ")}`,
		`lastUsefulUpdateAt: ${health.lastUsefulUpdateAt ? new Date(health.lastUsefulUpdateAt).toISOString() : "-"}`,
		`lastUsefulUpdate: ${health.lastUsefulUpdateSummary}`,
		`nextAction: ${health.nextAction}`,
		`healthReason: ${health.reason}`,
		`title: ${task.title}`,
		`summary: ${task.summary ?? "-"}`,
		`description: ${task.description ?? "-"}`,
		`priority: ${task.priority}${task.priorityLabel ? ` (${task.priorityLabel})` : ""}`,
		`recommendedProfile: ${task.recommendedProfile ?? "-"}`,
		`waitingOn: ${task.waitingOn ?? "-"}`,
		`blockedReason: ${task.blockedReason ?? "-"}`,
		`projectKey: ${task.projectKey}`,
		`spawnCwd: ${task.spawnCwd}`,
		`spawnSessionId: ${task.spawnSessionId ?? "-"}`,
		`spawnSessionFile: ${task.spawnSessionFile ?? "-"}`,
		`createdAt: ${new Date(task.createdAt).toISOString()}`,
		`updatedAt: ${new Date(task.updatedAt).toISOString()}`,
		`startedAt: ${task.startedAt ? new Date(task.startedAt).toISOString() : "-"}`,
		`reviewRequestedAt: ${task.reviewRequestedAt ? new Date(task.reviewRequestedAt).toISOString() : "-"}`,
		`finishedAt: ${task.finishedAt ? new Date(task.finishedAt).toISOString() : "-"}`,
		"",
		"acceptanceCriteria:",
		...(task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria.map((item) => `- ${item}`) : ["- none"]),
		"",
		"planSteps:",
		...(task.planSteps.length > 0 ? task.planSteps.map((item, index) => `${index + 1}. ${item}`) : ["- none"]),
		"",
		"validationSteps:",
		...(task.validationSteps.length > 0 ? task.validationSteps.map((item) => `- ${item}`) : ["- none"]),
		"",
		"files:",
		...(task.files.length > 0 ? task.files.map((item) => `- ${item}`) : ["- none"]),
		"",
		"labels:",
		...(task.labels.length > 0 ? task.labels.map((item) => `- ${item}`) : ["- none"]),
		"",
		"dependencies:",
		...((links.dependencies ?? []).length > 0 ? (links.dependencies ?? []).map((link) => formatTaskLinkLine(link, "dependency")) : ["- none"]),
		"",
		"blocks:",
		...((links.dependents ?? []).length > 0 ? (links.dependents ?? []).map((link) => formatTaskLinkLine(link, "dependent")) : ["- none"]),
		"",
		`reviewSummary: ${task.reviewSummary ?? "-"}`,
		`finalSummary: ${task.finalSummary ?? "-"}`,
		"",
		"interactions:",
		...(interactions.length > 0 ? interactions.map(formatTaskInteractionCard) : ["- none"]),
		"",
		"linkedAgents:",
		...(linkedAgents.length > 0 ? linkedAgents.map((agent) => `- ${agent.id} · ${agent.profile} · ${agent.state} · lease=${taskLeaseKindForProfile(agent.profile)}`) : ["- none"]),
	];
	if (events.length > 0) {
		lines.push("", "recentEvents:");
		for (const event of events) {
			lines.push(`- ${new Date(event.createdAt).toISOString()} · ${event.eventType} · ${event.summary}`);
		}
	}
	return lines.join("\n");
}
