/**
 * Coordinator tool registrations.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { updateFleetUi } from "../coordinator-session.js";
import {
	buildTaskAttentionText,
	buildTaskDispatchText,
	buildTaskLinksText,
	buildTaskReadyText,
	formatTaskDetails,
	formatTaskLine,
	formatTaskLinkLine,
	formatTaskReadinessLine,
	summarizeTaskFilters,
} from "../formatters.js";
import { resolveTaskFilters, sortTasksForList } from "../session-scope.js";
import { createTaskFromParams, dispatchReadyTasks, getReadyTasksForDispatch, getTaskLinkedAgents } from "../spawn-ops.js";
import { moveTaskById } from "../standup.js";
import { getTaskInteractions, listTaskInteractionsForTaskIds, resolveTaskInteractionWithNote } from "../task-interactions.js";
import { getMeepoDb } from "../db.js";
import { listAgents } from "../registry.js";
import {
	applyTaskSubtreeControl,
	buildTaskSubtreeControlPreview,
	formatTaskSubtreeControlApplyResult,
	formatTaskSubtreeControlPreview,
	type TaskSubtreeControlAction,
} from "../subtree-control.js";
import {
	cancelTaskLink,
	createTaskEvent,
	createTaskLink,
	getTask,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTaskEvents,
	listTaskHealth,
	listTaskLinks,
	listTaskReadiness,
	listTasks,
	listUnresolvedTaskDependencies,
	reconcileTasks,
	taskLeaseKindForProfile,
	unlinkTaskAgent,
	updateTask,
} from "../task-registry.js";
import type {
	TaskLinkState,
	TaskLinkType,
	TaskRecord,
	TaskState,
	TaskWaitingOn,
	UpdateTaskInput,
} from "../task-types.js";
import type { AgentSummary } from "../types.js";
import {
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
} from "../tool-schemas.js";

type RegisterTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => void;

export function register(registerTool: RegisterTool, pi: ExtensionAPI): void {
	registerTool({
			name: "task_create",
			label: "Task Create",
			description: "Create a tracked task ticket for the task-first board and orchestration flow.",
			promptSnippet: "Create a task ticket before delegation so the board tracks work instead of agent instances.",
			promptGuidelines: [
				"Create or select a task before spawning subagents for new work.",
				"Set recommendedProfile on executable tickets so dependency-ready dispatch can launch the right agent.",
				"Use task_link for ticket dependencies instead of free-text blocked reasons.",
				"Use blocked + waitingOn instead of creating separate waiting swim lanes.",
			],
			parameters: TaskCreateParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const task = createTaskFromParams(ctx, params);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatTaskDetails(task, [], [], {}, getTaskInteractions(task.id)) }],
					details: { task },
				};
			},
		});

	registerTool({
			name: "task_list",
			label: "Task List",
			description: "List tracked task tickets from the task-first board.",
			promptSnippet: "List tasks by scope, status, waiting-on target, and sort order.",
			promptGuidelines: [
				"Use task_list before spawning new work when you need to see whether a task already exists.",
				"Prefer current_project or current_session scope unless the user asks for a global view.",
			],
			parameters: TaskListParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { id?: string; ids?: string[] };
				if (typeof input.id === "string" && !Array.isArray(input.ids)) {
					return { ids: [input.id] };
				}
				return args;
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveTaskFilters(ctx, scope, {
					statuses: params.statuses as TaskState[] | undefined,
					waitingOn: params.waitingOn as TaskWaitingOn[] | undefined,
					recommendedProfile: params.recommendedProfile,
					includeDone: params.includeDone,
					limit: params.limit,
					linkedAgentId: params.linkedAgentId,
				});
				if (params.ids && params.ids.length > 0) filters.ids = params.ids;
				const tasks = sortTasksForList(listTasks(getMeepoDb(), filters), (params.sort ?? "priority") as "priority" | "updated" | "created" | "title" | "status");
				const links = listTaskAgentLinks(getMeepoDb(), { taskIds: tasks.map((task) => task.id), limit: 500 });
				const agents = listAgents(getMeepoDb(), { ids: [...new Set(links.map((link) => link.agentId))], limit: 500 });
				const agentsByTask = new Map<string, AgentSummary[]>();
				const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
				for (const link of links) {
					const agent = agentsById.get(link.agentId);
					if (!agent) continue;
					const existing = agentsByTask.get(link.taskId) ?? [];
					existing.push(agent);
					agentsByTask.set(link.taskId, existing);
				}
				const readinessByTask = new Map(listTaskReadiness(getMeepoDb(), { ids: tasks.map((task) => task.id), includeDone: true, limit: Math.max(tasks.length, 1) }).map((item) => [item.task.id, item]));
				const healthByTask = listTaskHealth(getMeepoDb(), tasks);
				const header = `scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
				const body = tasks.length === 0 ? "No tasks matched." : tasks.map((task) => formatTaskLine(task, agentsByTask.get(task.id) ?? [], readinessByTask.get(task.id), healthByTask.get(task.id))).join("\n");
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${header}\n\n${body}` }],
					details: { scope, filters, tasks },
				};
			},
		});

	registerTool({
			name: "task_get",
			label: "Task Get",
			description: "Inspect one or more tracked tasks in detail.",
			promptSnippet: "Get full task details including acceptance criteria, plan steps, dependency links, linked agents, and recent events.",
			promptGuidelines: [
				"Use task_get after task_list when you need full task context or recent event history.",
			],
			parameters: TaskGetParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { id?: string; ids?: string[] };
				if (typeof input.id === "string" && !Array.isArray(input.ids)) {
					return { ids: [input.id] };
				}
				return args;
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const tasks = params.ids.map((id) => getTask(getMeepoDb(), id)).filter((task): task is TaskRecord => task !== null);
				const links = listTaskAgentLinks(getMeepoDb(), { taskIds: tasks.map((task) => task.id), limit: 500 });
				const agents = listAgents(getMeepoDb(), { ids: [...new Set(links.map((link) => link.agentId))], limit: 500 });
				const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
				const agentsByTask = new Map<string, AgentSummary[]>();
				for (const link of links) {
					const agent = agentsById.get(link.agentId);
					if (!agent) continue;
					const existing = agentsByTask.get(link.taskId) ?? [];
					existing.push(agent);
					agentsByTask.set(link.taskId, existing);
				}
				const eventsByTask = new Map<string, ReturnType<typeof listTaskEvents>>();
				if (params.includeEvents ?? true) {
					for (const task of tasks) {
						eventsByTask.set(task.id, listTaskEvents(getMeepoDb(), { taskIds: [task.id], limit: params.eventLimit ?? 20 }));
					}
				}
				const dependencyLinks = listTaskLinks(getMeepoDb(), { taskIds: tasks.map((task) => task.id), includeResolved: true, limit: 1000 });
				const interactionsByTask = listTaskInteractionsForTaskIds(tasks.map((task) => task.id));
				const healthByTask = listTaskHealth(getMeepoDb(), tasks);
				const text = tasks.length === 0
					? "No matching tasks found."
					: tasks
						.map((task) =>
							formatTaskDetails(task, agentsByTask.get(task.id) ?? [], eventsByTask.get(task.id) ?? [], {
								dependencies: dependencyLinks.filter((link) => link.sourceTaskId === task.id),
								dependents: dependencyLinks.filter((link) => link.targetTaskId === task.id),
							}, interactionsByTask.get(task.id) ?? [], healthByTask.get(task.id)),
						)
						.join("\n\n---\n\n");
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text }],
					details: { tasks, taskLinks: dependencyLinks, interactionsByTask, healthByTask },
				};
			},
		});

	registerTool({
			name: "task_update",
			label: "Task Update",
			description: "Patch task metadata such as summary, acceptance criteria, plan steps, labels, or files.",
			promptSnippet: "Update the non-state metadata of a tracked task.",
			promptGuidelines: [
				"Use task_update to refine ticket contents without necessarily changing its board column.",
			],
			parameters: TaskUpdateParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const task = getTask(getMeepoDb(), params.id);
				if (!task) throw new Error(`Unknown task id \"${params.id}\".`);
				const patch: UpdateTaskInput = {
					title: params.title,
					summary: params.summary,
					description: params.description,
					parentTaskId: params.parentTaskId,
					priority: params.priority,
					priorityLabel: params.priorityLabel,
					recommendedProfile: params.recommendedProfile,
					acceptanceCriteria: params.acceptanceCriteria,
					planSteps: params.planSteps,
					validationSteps: params.validationSteps,
					labels: params.labels,
					files: params.files,
					blockedReason: params.blockedReason,
					waitingOn: params.waitingOn as TaskWaitingOn | undefined,
					reviewSummary: params.reviewSummary,
					finalSummary: params.finalSummary,
					updatedAt: Date.now(),
				};
				updateTask(getMeepoDb(), params.id, patch);
				createTaskEvent(getMeepoDb(), {
					id: randomUUID(),
					taskId: params.id,
					eventType: "updated",
					summary: `Updated task ${task.title}`,
					payload: patch,
				});
				const updated = getTask(getMeepoDb(), params.id)!;
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatTaskDetails(updated, getTaskLinkedAgents(updated.id), listTaskEvents(getMeepoDb(), { taskIds: [updated.id], limit: 10 }), {}, getTaskInteractions(updated.id)) }],
					details: { task: updated },
				};
			},
		});

	registerTool({
			name: "task_move",
			label: "Task Move",
			description: "Move a tracked task between board columns.",
			promptSnippet: "Move a task to todo, blocked, in_progress, in_review, or done with optional blockers or review summaries.",
			promptGuidelines: [
				"Use task_move for persistent board state transitions.",
				"When moving a prerequisite to done, newly unblocked dependency-ready tickets can auto-dispatch if recommendedProfile is set.",
				"Use blocked + waitingOn instead of introducing extra swim lanes.",
			],
			parameters: TaskMoveParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const moved = moveTaskById(params.id, {
					status: params.status as TaskState,
					reason: params.reason,
					waitingOn: params.waitingOn as TaskWaitingOn | undefined,
					blockedReason: params.blockedReason,
					reviewSummary: params.reviewSummary,
					finalSummary: params.finalSummary,
					force: params.force,
				});
				const dependentSourceIds = params.status === "done"
					? [...new Set(listTaskLinks(getMeepoDb(), { targetTaskIds: [moved.id], linkTypes: ["depends_on"], includeResolved: true, limit: 500 }).map((link) => link.sourceTaskId))]
					: [];
				const readyDependents = dependentSourceIds.length > 0
					? listTaskReadiness(getMeepoDb(), { ids: dependentSourceIds, includeDone: false, limit: dependentSourceIds.length }).filter((item) => item.ready)
					: [];
				const dispatchResult = params.status === "done" && (params.autoDispatchReadyDependents ?? true) && readyDependents.length > 0
					? await dispatchReadyTasks(pi, ctx, readyDependents, { fallbackProfile: params.fallbackProfile, maxDispatch: params.maxDispatch, dryRun: false })
					: null;
				const dependencyText = readyDependents.length > 0 ? `\n\nnewlyReadyDependents:\n${readyDependents.map(formatTaskReadinessLine).join("\n")}` : "";
				const dispatchText = dispatchResult ? `\n\n${buildTaskDispatchText(dispatchResult, false)}` : "";
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${formatTaskDetails(moved, getTaskLinkedAgents(moved.id), listTaskEvents(getMeepoDb(), { taskIds: [moved.id], limit: 10 }), {}, getTaskInteractions(moved.id))}${dependencyText}${dispatchText}` }],
					details: { task: moved, readyDependents, dispatchResult },
				};
			},
		});

	registerTool({
			name: "task_note",
			label: "Task Note",
			description: "Append a structured task-level note or handoff event, optionally resolving one task interaction card.",
			promptSnippet: "Add a note to the task history without changing board state; pass resolveInteractionId to disposition a visible task interaction.",
			parameters: TaskNoteParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const task = getTask(getMeepoDb(), params.id);
				if (!task) throw new Error(`Unknown task id \"${params.id}\".`);
				const resolution = params.resolveInteractionId
					? resolveTaskInteractionWithNote(params.id, params.resolveInteractionId, params.resolutionKind ?? "resolved", params.resolutionSummary ?? params.summary)
					: null;
				if (params.resolveInteractionId && resolution?.changes === 0) {
					throw new Error(`No open task interaction ${params.resolveInteractionId} matched task ${params.id}.`);
				}
				createTaskEvent(getMeepoDb(), {
					id: randomUUID(),
					taskId: params.id,
					eventType: "note",
					summary: params.summary,
					payload: {
						details: params.details ?? null,
						files: params.files ?? [],
						resolvedInteractionId: params.resolveInteractionId ?? null,
						resolutionKind: params.resolveInteractionId ? params.resolutionKind ?? "resolved" : null,
						resolutionSummary: params.resolveInteractionId ? params.resolutionSummary ?? params.summary : null,
						resolutionChanges: resolution?.changes ?? 0,
					},
				});
				updateTask(getMeepoDb(), params.id, { updatedAt: Date.now(), files: params.files ? [...new Set([...task.files, ...params.files])] : task.files });
				updateFleetUi(ctx);
				const resolutionText = resolution ? ` and resolved ${resolution.changes} interaction(s)` : "";
				return {
					content: [{ type: "text", text: `Added note to ${task.id}: ${params.summary}${resolutionText}` }],
					details: { taskId: task.id, resolution },
				};
			},
		});

	registerTool({
			name: "task_link_agent",
			label: "Task Link Agent",
			description: "Link an existing agent to a tracked task.",
			promptSnippet: "Attach an agent to a task so the board reflects task ownership and execution.",
			parameters: TaskLinkAgentParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (params.active ?? true) {
					const unresolved = listUnresolvedTaskDependencies(getMeepoDb(), [params.taskId]).get(params.taskId) ?? [];
					if (unresolved.length > 0) {
						throw new Error(`Task ${params.taskId} has unresolved dependencies: ${unresolved.map((item) => item.targetTaskId).join(", ")}. Do not link an active agent until dependencies resolve.`);
					}
				}
				const link = linkTaskAgent(getMeepoDb(), {
					taskId: params.taskId,
					agentId: params.agentId,
					role: params.role,
					isActive: params.active,
					allowDuplicateOwner: params.allowDuplicateOwner,
				});
				if (params.active ?? true) {
					const linkedTask = getTask(getMeepoDb(), params.taskId);
					const status: TaskState = taskLeaseKindForProfile(link.role) === "review" && linkedTask?.status === "in_review" ? "in_review" : "in_progress";
					updateTask(getMeepoDb(), params.taskId, { status, waitingOn: null, blockedReason: null, updatedAt: Date.now() });
				}
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `Linked ${link.agentId} to ${link.taskId} as ${link.role}.` }],
					details: { link },
				};
			},
		});

	registerTool({
			name: "task_unlink_agent",
			label: "Task Unlink Agent",
			description: "Unlink an agent from a tracked task.",
			promptSnippet: "Remove the active task/agent link when execution ownership changes.",
			parameters: TaskUnlinkAgentParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const changes = unlinkTaskAgent(getMeepoDb(), params.taskId, params.agentId, params.reason);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: changes > 0 ? `Unlinked ${params.agentId} from ${params.taskId}.` : `No active link found for ${params.agentId} on ${params.taskId}.` }],
					details: { taskId: params.taskId, agentId: params.agentId, changes },
				};
			},
		});

	registerTool({
			name: "task_attention",
			label: "Task Attention",
			description: "List blocked and in-review tasks that need coordinator or user attention.",
			promptSnippet: "List task-level unresolved work such as blocked tasks and tasks waiting for review.",
			promptGuidelines: [
				"Use task_attention as the task-first unresolved queue.",
			],
			parameters: TaskAttentionParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
				const items = listTaskAttention(getMeepoDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: params.limit });
				const interactionsByTask = listTaskInteractionsForTaskIds(items.map((item) => item.taskId));
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildTaskAttentionText(items, interactionsByTask) }],
					details: { scope, items, interactionsByTask },
				};
			},
		});

	registerTool({
			name: "task_reconcile",
			label: "Task Reconcile",
			description: "Backfill or repair task records and task-agent links.",
			promptSnippet: "Reconcile task records, legacy backfills, and task-agent links.",
			parameters: TaskReconcileParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
				const result = reconcileTasks(getMeepoDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: params.limit });
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `Reconciled tasks · ${result.backfilled} backfilled · ${result.deactivatedLinks} links deactivated.` }],
					details: { scope, result },
				};
			},
		});

	registerTool({
			name: "task_link",
			label: "Task Link",
			description: "Create a first-class relationship between two task tickets, especially source depends_on target dependencies.",
			promptSnippet: "Record ticket dependencies such as task A depends_on task B before dispatching agents.",
			promptGuidelines: [
				"Use task_link when planning reveals that one ticket depends on another ticket.",
				"For depends_on, sourceTaskId is the dependent/blocked ticket and targetTaskId is the prerequisite ticket.",
				"Do not spawn an agent for a task with unresolved depends_on links.",
			],
			parameters: TaskLinkParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const link = createTaskLink(getMeepoDb(), {
					sourceTaskId: params.sourceTaskId,
					targetTaskId: params.targetTaskId,
					linkType: (params.linkType as TaskLinkType | undefined) ?? "depends_on",
					summary: params.summary,
					blockSource: params.blockSource,
				});
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: formatTaskLinkLine(link) }],
					details: { link },
				};
			},
		});

	registerTool({
			name: "task_unlink",
			label: "Task Unlink",
			description: "Cancel a first-class task relationship or dependency link.",
			promptSnippet: "Cancel a task dependency/relationship link when it no longer applies.",
			parameters: TaskUnlinkParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const links = cancelTaskLink(getMeepoDb(), {
					id: params.id,
					sourceTaskId: params.sourceTaskId,
					targetTaskId: params.targetTaskId,
					linkType: params.linkType as TaskLinkType | undefined,
					reason: params.reason,
				});
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: links.length === 0 ? "No matching active task link found." : links.map((link) => formatTaskLinkLine(link)).join("\n") }],
					details: { links },
				};
			},
		});

	registerTool({
			name: "task_links",
			label: "Task Links",
			description: "List first-class task dependency and relationship links.",
			promptSnippet: "Inspect task dependencies and dependents/blocking relationships.",
			promptGuidelines: [
				"Use task_links to decide which tickets are blocked by unresolved dependencies and which tickets become ready after a prerequisite completes.",
			],
			parameters: TaskLinksParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: params.limit });
				const links = listTaskLinks(getMeepoDb(), {
					taskIds: params.taskId ? [params.taskId] : filters.ids,
					sourceTaskIds: params.sourceTaskId ? [params.sourceTaskId] : undefined,
					targetTaskIds: params.targetTaskId ? [params.targetTaskId] : undefined,
					projectKey: params.taskId || params.sourceTaskId || params.targetTaskId ? undefined : filters.projectKey,
					spawnSessionId: filters.spawnSessionId,
					spawnSessionFile: filters.spawnSessionFile,
					linkTypes: params.linkTypes as TaskLinkType[] | undefined,
					states: params.states as TaskLinkState[] | undefined,
					includeResolved: params.includeResolved,
					limit: params.limit,
				});
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildTaskLinksText(links) }],
					details: { scope, links },
				};
			},
		});

	registerTool({
			name: "task_ready",
			label: "Task Ready",
			description: "List tasks that are dependency-ready for agent dispatch, with reasons for blocked tasks when requested.",
			promptSnippet: "Find dependency-free ready tickets before spawning agents.",
			promptGuidelines: [
				"Use task_ready after planning and after moving dependencies to done.",
				"Spawn agents for ready tickets; do not spawn agents for tasks with unresolved dependencies.",
			],
			parameters: TaskReadyParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveTaskFilters(ctx, scope, {
					statuses: params.includeBlocked ? undefined : ["todo"],
					recommendedProfile: params.recommendedProfile,
					includeDone: false,
					limit: params.limit,
				});
				if (params.ids && params.ids.length > 0) filters.ids = params.ids;
				const items = listTaskReadiness(getMeepoDb(), filters);
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildTaskReadyText(items, params.includeBlocked ?? false) }],
					details: { scope, items },
				};
			},
		});

	registerTool({
			name: "task_dispatch_ready",
			label: "Task Dispatch Ready",
			description: "Spawn agents for dependency-ready tasks using each task's recommendedProfile or a fallback profile.",
			promptSnippet: "Launch one agent for each dependency-free ready ticket, subject to limits.",
			promptGuidelines: [
				"Use task_dispatch_ready after planning decomposes work or after a prerequisite task reaches done.",
				"Tasks without recommendedProfile are skipped unless fallbackProfile is provided.",
				"This is dependency-aware and will not spawn agents for tickets with unresolved depends_on links.",
			],
			parameters: TaskDispatchReadyParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const ready = getReadyTasksForDispatch(ctx, { scope: params.scope, ids: params.ids, limit: params.ids?.length ?? 100 });
				const result = await dispatchReadyTasks(pi, ctx, ready, {
					fallbackProfile: params.fallbackProfile,
					maxDispatch: params.maxDispatch,
					dryRun: params.dryRun ?? false,
				});
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: buildTaskDispatchText(result, params.dryRun ?? false) }],
					details: { ready, result },
				};
			},
		});

	registerTool({
			name: "task_subtree_control",
			label: "Task Subtree Control",
			description: "Preview and optionally apply safe pause/resume/cancel-like controls across a parent/child task subtree.",
			promptSnippet: "Preview a task family before pausing, resuming, or cancelling its tasks and linked agents.",
			promptGuidelines: [
				"Use a dry-run first (target action with confirm=false, or action=preview for read-only inspection) to inspect the recursive parentTaskId subtree, linked agents, blockers, attention, and cleanup candidates.",
				"Pause/resume/cancel require confirm=true plus the previewToken returned by the prior dry-run preview for that same action/selection.",
				"If previewComplete is no, the tool refuses to apply so large task families are not partially controlled from truncated data.",
				"Pause/cancel use graceful subagent stop requests for active linked agents and write durable task events; they never force-kill or cleanup host targets.",
				"Resume only unblocks tasks previously marked with [subtree paused] and does not spawn agents automatically.",
			],
			parameters: TaskSubtreeControlParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { taskId?: string; id?: string };
				if (typeof input.taskId === "string" && typeof input.id !== "string") return { ...args, id: input.taskId };
				return args;
			},
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const action = (params.action ?? "preview") as TaskSubtreeControlAction;
				const preview = await buildTaskSubtreeControlPreview(ctx, params.id, action, { includeRoot: params.includeRoot, reason: params.reason });
				if (action === "preview" || !(params.confirm ?? false)) {
					const confirmationText = action === "preview" ? "" : `\n\nConfirmation required: rerun with confirm=true previewToken=${preview.previewToken} to apply this bulk action.`;
					updateFleetUi(ctx);
					return {
						content: [{ type: "text", text: `${formatTaskSubtreeControlPreview(preview)}${confirmationText}` }],
						details: {
							dryRun: true,
							action,
							previewToken: preview.previewToken,
							isComplete: preview.isComplete,
							truncationWarnings: preview.truncationWarnings,
							rootTask: preview.rootTask,
							tasks: preview.tasks,
							taskIdsToUpdate: preview.taskIdsToUpdate,
							linkedAgents: preview.linkedAgents,
							activeAgents: preview.activeAgents,
							agentIdsToStop: preview.agentIdsToStop,
							attentionItems: preview.attentionItems,
							agentAttentionItems: preview.agentAttentionItems,
							cleanupCandidates: preview.cleanupCandidates,
						},
					};
				}
				const result = await applyTaskSubtreeControl(ctx, params.id, action as Exclude<TaskSubtreeControlAction, "preview">, { includeRoot: params.includeRoot, reason: params.reason, previewToken: params.previewToken });
				updateFleetUi(ctx);
				return {
					content: [{ type: "text", text: `${formatTaskSubtreeControlPreview(preview)}\n\n---\n\n${formatTaskSubtreeControlApplyResult(result)}` }],
					details: {
						dryRun: false,
						action,
						previewToken: result.preview.previewToken,
						rootTask: result.preview.rootTask,
						updatedTasks: result.updatedTasks,
						stopResults: result.stopResults,
						stopErrors: result.stopErrors,
						taskEventsCreated: result.taskEventsCreated,
					},
				};
			},
		});

}
