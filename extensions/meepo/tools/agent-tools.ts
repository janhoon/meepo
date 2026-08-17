/**
 * Coordinator tool registrations.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	captureAgentById,
	cleanupAgentTarget,
	focusAgentById,
	listCleanupCandidates,
	reconcileAgents,
	stopAgentById,
} from "../child-fleet.js";
import { updateFleetUi, setLastFocusedActiveAgentId } from "../coordinator-session.js";
import {
	applyHierarchyVisibilityToAgentFilters,
	childRuntimeEnvironment,
	getVisibleAgentIdsForTool,
	loadAttentionGate,
	resolveAgentFilters,
	resolveOpenAttentionFilters,
	resolveRootInboxSenderIds,
	resolveTaskFilters,
	resolveToolActorContext,
} from "../session-scope.js";
import { spawnChildFromParams } from "../spawn-ops.js";
import {
	buildAttentionText,
	buildInboxText,
	formatAgentDetails,
	formatAgentLine,
	formatAttentionGateWarning,
	formatCleanupCandidates,
	formatCleanupResults,
	formatFocusResult,
	formatReconcileResult,
	formatSpawnSuccess,
	formatStopResult,
	summarizeFilters,
} from "../formatters.js";
import { getMeepoDb } from "../db.js";
import { defaultDownwardActionPolicy } from "../downward-policy.js";
import { listInbox, listInboxForChild, listOpenAttention, markInbox } from "../inbox.js";
import {
	deliverQueuedMessagesViaBridge,
	queueDownwardMessage,
} from "../bridge-delivery.js";
import { getProcessHost } from "../process-host.js";
import { getProjectKey } from "../project.js";
import { missingHostTargetMessage } from "../rpc-bridge-control.js";
import {
	canSendMessage,
	getAgent,
	listAgents,
} from "../registry.js";
import { reconcileTasks } from "../task-registry.js";
import type {
	AgentRecipientRef,
	AgentSummary,
} from "../types.js";
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
} from "../tool-schemas.js";

type RegisterTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => void;

export function register(registerTool: RegisterTool, pi: ExtensionAPI): void {
	registerTool({
			name: "subagent_spawn",
			label: "Subagent Spawn",
			description: "Spawn a tracked tmux-backed child pi session with a run directory, session file, and global registry entry.",
			promptSnippet: "Spawn a tracked child agent on the frozen ProcessHost (tmux or herdr) using a named profile, task, and optional cwd/model/tools overrides.",
			promptGuidelines: [
				"Use subagent_spawn when work should be delegated into an isolated child context.",
				"Prefer attaching the child to an existing taskId. If taskId is omitted, a new task is auto-created.",
				"Before spawning more work, inspect unresolved attention with subagent_attention and handle blockers/questions first when appropriate.",
				"If the task already has an active exclusive owner, use a reviewer profile or set allowDuplicateOwner=true only after explicit confirmation that duplicate implementation is intentional.",
				"Pick the most appropriate profile and keep the delegated task narrowly scoped.",
				"Do not pass `find` in tool overrides. Use `grep` and `bash` with `rg --files` instead.",
			],
			parameters: SubagentSpawnParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { items: gateItems, agents: gateAgents } = loadAttentionGate(ctx, "current_project");
				const result = await spawnChildFromParams(pi, ctx, params);
				const warning = formatAttentionGateWarning(gateItems, gateAgents);
				return {
					content: [{ type: "text", text: `${warning ? `${warning}\n\n` : ""}${formatSpawnSuccess(result)}` }],
					details: { result, attentionGate: gateItems },
				};
			},
		});

	registerTool({
			name: "subagent_focus",
			label: "Subagent Focus",
			description: "Focus a tracked child agent window/pane on the frozen ProcessHost, or return the exact manual host command when automatic focus is not possible.",
			promptSnippet: "Focus a tracked subagent window/pane using stored host ids.",
			promptGuidelines: [
				"Use subagent_focus when the user wants to jump directly into a child tmux window.",
			],
			parameters: SubagentFocusParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { agent, result } = await focusAgentById(params.id);
				setLastFocusedActiveAgentId(agent.id);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatFocusResult(agent, result) }],
					details: { agent, ...result },
				};
			},
		});

	registerTool({
			name: "subagent_stop",
			label: "Subagent Stop",
			description: "Request a graceful stop for a tracked child agent, or force-kill its host target.",
			promptSnippet: "Stop a tracked subagent gracefully or with force=true.",
			promptGuidelines: [
				"Use graceful stop first so the child can publish a final handoff.",
				"Use force=true only when the child is hung or the user explicitly wants an immediate kill.",
			],
			parameters: SubagentStopParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const { agent, result } = await stopAgentById(params.id, params.force ?? false, params.reason);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatStopResult(agent, result, params.force ?? false) }],
					details: { agent, ...result, force: params.force ?? false },
				};
			},
		});

	registerTool({
			name: "subagent_message",
			label: "Subagent Message",
			description: "Send a structured control-plane message to a tracked child agent.",
			promptSnippet: "Send structured answer, note, redirect, cancel, or priority updates to a tracked child agent, with an explicit action policy when useful.",
			promptGuidelines: [
				"Use subagent_message to answer child questions, redirect work, cancel, or change priority.",
				"Prefer messages plus child publish updates over transcript capture for normal orchestration.",
				"Keep the message concrete and minimal, with exact file paths when relevant.",
				"Use actionPolicy when you need the child to replan, resume, or stop instead of merely reading the note.",
				"When replying to a specific child blocker/question, include inReplyToMessageId when available from subagent_inbox or subagent_get.",
			],
			parameters: SubagentMessageParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const db = getMeepoDb();
				const actor = resolveToolActorContext(ctx);
				const agent = getAgent(db, params.id);
				if (!agent) throw new Error(`Unknown agent id \"${params.id}\".`);
				const kind = params.kind as "answer" | "note" | "redirect" | "cancel" | "priority";
				const actionPolicy = params.actionPolicy ?? defaultDownwardActionPolicy(kind);
				const recipient: AgentRecipientRef = { kind: "agent", agentId: agent.id };
				const preflight = canSendMessage(db, { actor, recipient, messageKind: kind });
				if (!preflight.allowed) {
					throw new Error(
						`Denied hierarchy message from ${preflight.fromKind}:${preflight.fromAgentId ?? "root"} to ${preflight.toKind}:${preflight.toAgentId ?? "-"} via ${preflight.routeKind}: ${preflight.decisionReason}`,
					);
				}
				if (["done", "error", "stopped", "lost"].includes(agent.state)) {
					throw new Error(`Cannot message agent ${agent.id} because it is in terminal state ${agent.state}.`);
				}
				if (!(agent.host && (await getProcessHost().targetExists(agent.host)))) {
					throw new Error(missingHostTargetMessage(agent.id));
				}
				const messageId = queueDownwardMessage(
					agent,
					kind,
					{
						summary: params.summary,
						details: params.details,
						files: params.files,
						actionPolicy,
						inReplyToMessageId: params.inReplyToMessageId,
						routeKind: preflight.routeKind,
					},
					params.deliveryMode ?? "immediate",
					actor,
				);
				const route = preflight;
				const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
				updateFleetUi(ctx);
				const senderText = actor.kind === "agent" ? `agent:${actor.agentId}` : "root";
				const text = liveDelivery.delivered > 0
					? `Queued ${kind} message from ${senderText} to agent:${agent.id} via ${route.routeKind} (${actionPolicy}) and delivered ${liveDelivery.delivered} via RPC bridge.`
					: `Queued ${kind} message from ${senderText} to agent:${agent.id} via ${route.routeKind} (${actionPolicy}).`;
				return {
					content: [{ type: "text", text }],
					details: {
						agentId: agent.id,
						sender: actor,
						recipient,
						kind,
						actionPolicy,
						messageId,
						inReplyToMessageId: params.inReplyToMessageId ?? null,
						deliveryMode: params.deliveryMode ?? "immediate",
						liveDelivery,
						readReceipt: { status: liveDelivery.delivered > 0 ? "acked" : "queued" },
					},
				};
			},
		});

	registerTool({
			name: "subagent_capture",
			label: "Subagent Capture",
			description: "Debug-only: capture recent host pane output for a tracked child agent.",
			promptSnippet: "Debug a tracked subagent by capturing recent host pane output only when structured reporting is insufficient.",
			promptGuidelines: [
				"Prefer subagent_attention, subagent_inbox, subagent_get, and subagent_message for normal orchestration.",
				"Use subagent_capture only when child reporting is stale, missing, or clearly inconsistent and you need raw transcript context.",
			],
			parameters: SubagentCaptureParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const capture = await captureAgentById(params.id, params.lines ?? 200);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: capture.content || "(empty capture)" }],
					details: { agentId: capture.agent.id, command: capture.command, lines: params.lines ?? 200 },
				};
			},
		});

	registerTool({
			name: "subagent_reconcile",
			label: "Subagent Reconcile",
			description: "Reconcile registry state against ProcessHost inventory and latest child status snapshots.",
			promptSnippet: "Reconcile tracked tmux subagent registry state against tmux and run-directory snapshots.",
			promptGuidelines: [
				"Use subagent_reconcile when tmux windows disappear, status looks stale, or after restarting the primary session.",
			],
			parameters: SubagentReconcileParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await reconcileAgents(ctx, params);
				const taskFilters = resolveTaskFilters(ctx, params.scope ?? "current_project", { includeDone: true, limit: params.limit });
				const taskResult = reconcileTasks(getMeepoDb(), { ids: taskFilters.ids, projectKey: taskFilters.projectKey, spawnSessionId: taskFilters.spawnSessionId, spawnSessionFile: taskFilters.spawnSessionFile, limit: params.limit });
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${formatReconcileResult(result)}\nTasks: ${taskResult.backfilled} backfilled · ${taskResult.deactivatedLinks} stale links released.` }],
					details: { ...result, taskResult },
				};
			},
		});

	registerTool({
			name: "subagent_list",
			label: "Subagent List",
			description: "List tracked tmux-backed subagents from the global registry.",
			promptSnippet: "List tracked tmux subagents by project/session/state/unread filters.",
			promptGuidelines: [
				"Use subagent_list to inspect already tracked child agents before delegating new work.",
				"Prefer current_project or current_session scope unless the user explicitly asks for a global fleet view.",
			],
			parameters: SubagentListParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = applyHierarchyVisibilityToAgentFilters(ctx, resolveAgentFilters(ctx, scope, params));
				const agents = listAgents(getMeepoDb(), filters);
				const header = `scope=${summarizeFilters(scope, filters)}${childRuntimeEnvironment ? " · hierarchy-visible" : ""} · ${agents.length} agent${agents.length === 1 ? "" : "s"}`;
				const body = agents.length === 0 ? "No agents matched." : agents.map(formatAgentLine).join("\n");
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${header}\n\n${body}` }],
					details: {
						scope,
						filters,
						agents,
					},
				};
			},
		});

	registerTool({
			name: "subagent_get",
			label: "Subagent Get",
			description: "Get detailed state for one or more tracked tmux-backed subagents.",
			promptSnippet: "Inspect detailed state for specific tracked tmux subagents.",
			promptGuidelines: [
				"Use subagent_get after subagent_list when you need the full state, tmux ids, last preview, or latest unread message for a specific child.",
			],
			parameters: SubagentGetParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { id?: string; ids?: string[] };
				if (typeof input.id === "string" && !Array.isArray(input.ids)) {
					return { ids: [input.id] };
				}
				return args;
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const visibleIds = getVisibleAgentIdsForTool(ctx, params.ids);
				const visibleSet = visibleIds ? new Set(visibleIds) : null;
				const allowedIds = visibleSet ? params.ids.filter((id) => visibleSet.has(id)) : params.ids;
				const deniedIds = visibleSet ? params.ids.filter((id) => !visibleSet.has(id)) : [];
				const agents = allowedIds
					.map((id) => getAgent(getMeepoDb(), id))
					.filter((agent): agent is AgentSummary => agent !== null);
				const text =
					agents.length === 0
						? deniedIds.length > 0
							? `No matching visible agents found. Hidden by hierarchy scope: ${deniedIds.join(", ")}`
							: "No matching agents found."
						: `${agents.map((agent) => formatAgentDetails(agent)).join("\n\n---\n\n")}${deniedIds.length > 0 ? `\n\nHidden by hierarchy scope: ${deniedIds.join(", ")}` : ""}`;
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text }],
					details: { ids: params.ids, visibleIds: allowedIds, deniedIds, agents },
				};
			},
		});

	registerTool({
			name: "subagent_cleanup",
			label: "Subagent Cleanup",
			description: "Remove finished child host targets after their work has been completed and synthesized.",
			promptSnippet: "Clean up terminal child tmux windows that no longer need to remain open.",
			promptGuidelines: [
				"Use subagent_cleanup after completion has been reviewed or synthesized so old tmux windows do not accumulate.",
				"Prefer dryRun=true first when you are unsure which agents are eligible.",
				"Do not clean blocked or question-bearing agents unless force=true is intentional.",
			],
			parameters: SubagentCleanupParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { id?: string; ids?: string[] };
				if (typeof input.id === "string" && !Array.isArray(input.ids)) {
					return { ids: [input.id] };
				}
				return args;
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const candidates = await listCleanupCandidates(ctx, params);
				const dryRun = params.dryRun ?? false;
				if (dryRun) {
					updateFleetUi(ctx);
					return {
						content: [{ type: "text", text: formatCleanupCandidates(candidates, true) }],
						details: { candidates, dryRun: true },
					};
				}
				const ready = candidates.filter((candidate) => candidate.cleanupAllowed);
				const skipped = candidates.filter((candidate) => !candidate.cleanupAllowed);
				const results = await Promise.all(ready.map((candidate) => cleanupAgentTarget(candidate, params.force ?? false)));
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatCleanupResults(results, skipped) }],
					details: { candidates, results, skipped, dryRun: false },
				};
			},
		});

	registerTool({
			name: "subagent_inbox",
			label: "Subagent Inbox",
			description: "Read unread child-originated mailbox messages that are already stored in the global registry.",
			promptSnippet: "Read unread child-originated questions, blockers, milestones, and completion handoffs from the subagent inbox.",
			promptGuidelines: [
				"Use subagent_inbox to read proactive child updates that were already published. Do not use it to poll children for status generation.",
				"Treat this as a one-shot snapshot: if nothing actionable is returned, continue other ready work or end the turn instead of waiting.",
			],
			parameters: SubagentInboxParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const agentFilters = applyHierarchyVisibilityToAgentFilters(ctx, resolveAgentFilters(ctx, scope, {}));
				const db = getMeepoDb();
				const actor = resolveToolActorContext(ctx);
				// Root inboxes: single helper (no parallel resolveOwnedSubjectIds composition).
				// Agent actors pin by recipient identity only.
				const ownedSenderIds =
					actor.kind === "root"
						? resolveRootInboxSenderIds(ctx, scope, {
								projectKey: agentFilters.projectKey ?? getProjectKey(ctx.cwd),
						  })
						: undefined;
				const messages =
					actor.kind === "agent"
						? listInboxForChild(db, actor.agentId, {
								includeDelivered: params.includeDelivered,
								limit: params.limit,
						  })
						: listInbox(db, {
								projectKey: agentFilters.projectKey,
								agentIds: ownedSenderIds ?? agentFilters.ids ?? agentFilters.descendantOf,
								includeDelivered: params.includeDelivered,
								limit: params.limit,
						  });
				const deliveredIds = params.includeDelivered ? [] : messages.filter((message) => message.status === "queued").map((message) => message.id);
				const readReceiptCount = markInbox(db, deliveredIds, "delivered");
				const deliveredIdSet = new Set(deliveredIds);
				const returnedMessages = messages.map((message) =>
					deliveredIdSet.has(message.id) ? { ...message, status: "delivered" as const } : message,
				);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildInboxText(returnedMessages, readReceiptCount) }],
					details: { scope, actor, messages: returnedMessages, readReceipt: { status: "delivered", ids: deliveredIds, count: readReceiptCount }, version: "inbox" },
				};
			},
		});

	registerTool({
			name: "subagent_attention",
			label: "Subagent Attention",
			description: "List open attention items derived from child questions, blockers, and completions.",
			promptSnippet: "List open attention items for coordinator or user triage.",
			promptGuidelines: [
				"Use subagent_attention before spawning more work or giving a confident status answer when child questions, blockers, or completions may be pending.",
				"Prefer this over raw inbox reads when you need the unresolved queue rather than low-level mailbox rows.",
				"Treat this as a one-shot snapshot, not a long-poll or monitor loop.",
			],
			parameters: SubagentAttentionParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const db = getMeepoDb();
				const actor = resolveToolActorContext(ctx);
				const items = listOpenAttention(
					db,
					resolveOpenAttentionFilters(ctx, scope, {
						audience: params.audience,
						includeResolved: params.includeResolved,
						limit: params.limit,
					}),
				);
				const agentsById = new Map(
					listAgents(db, { ids: [...new Set(items.map((item) => item.agentId))], limit: 200 }).map((agent) => [agent.id, agent]),
				);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildAttentionText(items, agentsById, params.includeResolved ?? false) }],
					details: { scope, actor, items },
				};
			},
		});

}
