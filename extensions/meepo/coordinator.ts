/**
 * Meepo coordinator: tool modules + commands/shortcuts + lifecycle hooks.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { LEGACY_SERVICE_TOOL_ALIASES, loadMeepoConfig } from "./config.js";
import type { MeepoRuntime } from "./runtime.js";
import { registerChildRuntime } from "./child-runtime.js";
import { configureSubtreeControlDeps } from "./subtree-control.js";
import { closeMeepoDb, getMeepoDb } from "./db.js";
import { getProjectKey } from "./project.js";
import { openAgentsBoard } from "./board.js";
import { openAgentsDashboard } from "./dashboard.js";
import {
	applyNoWaitSystemPrompt,
	getBashCommandFromToolInput,
	noWaitBashBlockReason,
} from "./no-wait-policy.js";
import { getSubagentProfile, listSubagentProfiles } from "./profiles.js";
import {
	getAgent,
	listAgents,
	listAttentionItems,
	listInboxMessages,
	markAgentMessages,
	resolveAgentActorContext,
} from "./registry.js";
import {
	createTask,
	createTaskEvent,
	getTask,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTasks,
	reconcileTasks,
	unlinkTaskAgent,
	updateTask,
} from "./task-registry.js";
import { register as registerAgentTools } from "./tools/agent-tools.js";
import { register as registerTaskTools } from "./tools/task-tools.js";
import { register as registerServiceTools } from "./tools/service-tools.js";
import {
	ATTENTION_WAKE_POLL_MS,
	attentionWakePoll,
	buildStandupText,
	captureAgentById,
	captureServiceById,
	childRuntimeEnvironment,
	cleanupAgentTarget,
	confirmTaskLeaseOverride,
	focusAgentById,
	focusServiceById,
	formatReconcileResult,
	formatServiceReconcileResult,
	getTaskInteractions,
	getTaskLinkedAgents,
	lastFocusedActiveAgentId,
	listCleanupCandidates,
	listTaskInteractionsForTaskIds,
	moveTaskById,
	reconcileAgents,
	reconcileServices,
	resolveServiceFilters,
	resolveTaskFilters,
	runAgentsBoard,
	runAgentsDashboard,
	runServiceSpawnWizard,
	runSpawnWizard,
	runTaskCreateWizard,
	runTaskMoveFlow,
	runTaskSpawnWizard,
	setActiveMeepoRuntime,
	setAttentionWakePoll,
	setLastFocusedActiveAgentId,
	stopAgentById,
	stopServiceById,
	summarizeServiceFilters,
	updateFleetUi,
	wakeCoordinatorFromAttention,
} from "./coordinator-helpers.js";

export * from "./coordinator-helpers.js";

export function registerMeepoCoordinatorTools(pi: ExtensionAPI, runtime: MeepoRuntime): void {
	setActiveMeepoRuntime(runtime);
	configureSubtreeControlDeps({ stopAgentById, listCleanupCandidates });
	const registerTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0]): void => {
		pi.registerTool(tool);
		const legacy = (Object.entries(LEGACY_SERVICE_TOOL_ALIASES) as Array<[string, string]>).find(
			([, canonical]) => canonical === tool.name,
		)?.[0];
		if (legacy) {
			pi.registerTool({
				...tool,
				name: legacy,
				label: `${typeof tool.label === "string" ? tool.label : legacy} (legacy alias)`,
			});
		}
	};
	const noWaitMode = runtime.config.policies.noWait;
	if (childRuntimeEnvironment) {
		registerChildRuntime(pi, childRuntimeEnvironment, { noWaitMode });
	} else {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: applyNoWaitSystemPrompt(event.systemPrompt, noWaitMode),
		}));
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") return;
			const command = getBashCommandFromToolInput(event.input);
			if (!command) return;
			const reason = noWaitBashBlockReason(command, noWaitMode);
			if (!reason) return;
			return { block: true, reason };
		});
	}

	let dashboardState: AgentsDashboardState = {
		scope: "current_project",
		sort: "priority",
		activeOnly: false,
		blockedOnly: false,
		unreadOnly: false,
	};
	let boardState: AgentsBoardState = {
		scope: "current_project",
	};

	async function cycleActiveAgent(ctx: ExtensionContext, direction: 1 | -1): Promise<void> {
		const agents = listAgents(getMeepoDb(), { projectKey: getProjectKey(ctx.cwd), activeOnly: true, limit: 200 });
		if (agents.length === 0) {
			ctx.ui.notify("No active child agents to focus.", "warning");
			return;
		}
		const currentIndex = lastFocusedActiveAgentId ? agents.findIndex((agent) => agent.id === lastFocusedActiveAgentId) : -1;
		const nextIndex = currentIndex === -1 ? 0 : (currentIndex + direction + agents.length) % agents.length;
		const target = agents[nextIndex] ?? agents[0]!;
		try {
			const { result } = await focusAgentById(target.id);
			setLastFocusedActiveAgentId(target.id);
			ctx.ui.notify(result.focused ? `Focused ${target.id}.` : formatFocusResult(target, result), result.focused ? "info" : "warning");
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	}

	registerAgentTools(registerTool, pi);
	registerTaskTools(registerTool, pi);
	registerServiceTools(registerTool, pi);


pi.registerCommand("agents", {
		description: "Open the tmux subagents dashboard",
		handler: async (_args, ctx) => {
			dashboardState = await runAgentsDashboard(pi, ctx, dashboardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-board", {
		description: "Open the tracked task Kanban board",
		handler: async (_args, ctx) => {
			boardState = await runAgentsBoard(pi, ctx, boardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("standup", {
		description: "Show a Kanban standup digest for long-running task sessions",
		handler: async (args, ctx) => {
			const scopeArg = args?.trim() || "current_project";
			const scope = scopeArg as "all" | "current_project" | "current_session" | "descendants";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /standup [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const text = await buildStandupText(ctx, scope);
			if (ctx.hasUI) await ctx.ui.editor("standup", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("tasks", {
		description: "List tracked tasks",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /tasks [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const tasks = listTasks(getMeepoDb(), filters);
			const healthByTask = listTaskHealth(getMeepoDb(), tasks);
			const text = `${`scope=${summarizeTaskFilters(scope, filters)} · ${tasks.length} task${tasks.length === 1 ? "" : "s"}`}${tasks.length === 0 ? "\n\nNo tasks matched." : `\n\n${tasks.map((task) => formatTaskLine(task, getTaskLinkedAgents(task.id), undefined, healthByTask.get(task.id))).join("\n")}`}`;
			if (ctx.hasUI) await ctx.ui.editor("tasks", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-new", {
		description: "Create a tracked task",
		handler: async (_args, ctx) => {
			const created = await runTaskCreateWizard(ctx);
			if (created && ctx.hasUI) await ctx.ui.editor(`Task ${created.id}`, formatTaskDetails(created, [], [], {}, getTaskInteractions(created.id)));
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-open", {
		description: "Inspect a tracked task by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /task-open <id>", "warning");
				return;
			}
			const task = getTask(getMeepoDb(), id);
			if (!task) {
				ctx.ui.notify(`Unknown task id \"${id}\".`, "error");
				return;
			}
			const text = formatTaskDetails(task, getTaskLinkedAgents(task.id), listTaskEvents(getMeepoDb(), { taskIds: [task.id], limit: 20 }), {}, getTaskInteractions(task.id));
			if (ctx.hasUI) await ctx.ui.editor(`Task ${task.id}`, text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-move", {
		description: "Move a tracked task to a new board state",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const id = parts[0];
			const status = parts[1] as TaskState | undefined;
			if (!id) {
				ctx.ui.notify("Usage: /task-move <id> [todo|blocked|in_progress|in_review|done]", "warning");
				return;
			}
			if (status && ["todo", "blocked", "in_progress", "in_review", "done"].includes(status)) {
				const moved = moveTaskById(id, { status, force: true });
				ctx.ui.notify(`Moved ${moved.id} to ${moved.status}.`, "info");
			} else if (ctx.hasUI) {
				await runTaskMoveFlow(ctx, id);
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-note", {
		description: "Append a note to a task",
		handler: async (args, ctx) => {
			const [id, ...rest] = args?.trim().split(/\s+/) ?? [];
			const summary = rest.join(" ").trim();
			if (!id || !summary) {
				ctx.ui.notify("Usage: /task-note <id> <message>", "warning");
				return;
			}
			const task = getTask(getMeepoDb(), id);
			if (!task) {
				ctx.ui.notify(`Unknown task id \"${id}\".`, "error");
				return;
			}
			createTaskEvent(getMeepoDb(), { id: randomUUID(), taskId: id, eventType: "note", summary });
			updateTask(getMeepoDb(), id, { updatedAt: Date.now() });
			ctx.ui.notify(`Added note to ${task.id}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-link-agent", {
		description: "Link an existing agent to a task",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const taskId = parts[0];
			const agentId = parts[1];
			const role = parts[2];
			if (!taskId || !agentId) {
				ctx.ui.notify("Usage: /task-link-agent <task-id> <agent-id> [role]", "warning");
				return;
			}
			const agent = getAgent(getMeepoDb(), agentId);
			if (!agent) {
				ctx.ui.notify(`Unknown agent id \"${agentId}\".`, "error");
				return;
			}
			const allowDuplicateOwner = await confirmTaskLeaseOverride(ctx, taskId, role || agent.profile);
			const existingTask = getTask(getMeepoDb(), taskId);
			const link = linkTaskAgent(getMeepoDb(), { taskId, agentId, role, isActive: true, allowDuplicateOwner });
			const status: TaskState = taskLeaseKindForProfile(link.role) === "review" && existingTask?.status === "in_review" ? "in_review" : "in_progress";
			updateTask(getMeepoDb(), taskId, { status, waitingOn: null, blockedReason: null, updatedAt: Date.now() });
			ctx.ui.notify(`Linked ${link.agentId} to ${link.taskId}.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-unlink-agent", {
		description: "Unlink an agent from a task",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const taskId = parts[0];
			const agentId = parts[1];
			if (!taskId || !agentId) {
				ctx.ui.notify("Usage: /task-unlink-agent <task-id> <agent-id>", "warning");
				return;
			}
			const changes = unlinkTaskAgent(getMeepoDb(), taskId, agentId, "manual unlink");
			ctx.ui.notify(changes > 0 ? `Unlinked ${agentId} from ${taskId}.` : `No active link found for ${agentId} on ${taskId}.`, changes > 0 ? "info" : "warning");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-attention", {
		description: "List blocked and in-review tasks",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /task-attention [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const items = listTaskAttention(getMeepoDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: 200 });
			const interactionsByTask = listTaskInteractionsForTaskIds(items.map((item) => item.taskId));
			const text = buildTaskAttentionText(items, interactionsByTask);
			if (ctx.hasUI) await ctx.ui.editor("task attention", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-sync", {
		description: "Reconcile task records and task-agent links",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /task-sync [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveTaskFilters(ctx, scope, { includeDone: true, limit: 200 });
			const result = reconcileTasks(getMeepoDb(), { ids: filters.ids, projectKey: filters.projectKey, spawnSessionId: filters.spawnSessionId, spawnSessionFile: filters.spawnSessionFile, limit: 200 });
			ctx.ui.notify(`Reconciled tasks · ${result.backfilled} backfilled · ${result.deactivatedLinks} links deactivated.`, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-subtree", {
		description: "Preview or confirm safe task-family subtree controls",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const id = parts[0];
			const validActions = new Set<TaskSubtreeControlAction>(["preview", "pause", "resume", "cancel"]);
			const rawAction = parts[1] as TaskSubtreeControlAction | undefined;
			if (!id || (rawAction && !validActions.has(rawAction) && !rawAction.startsWith("--"))) {
				ctx.ui.notify("Usage: /task-subtree <task-id> [preview|pause|resume|cancel] [--confirm] [--preview-token=<token>] [reason...]", "warning");
				return;
			}
			const action = rawAction && validActions.has(rawAction) ? rawAction : "preview";
			const remaining = parts.slice(rawAction && validActions.has(rawAction) ? 2 : 1);
			const confirm = remaining.includes("--confirm") || remaining.includes("confirm");
			const previewToken = remaining.find((part) => part.startsWith("--preview-token="))?.slice("--preview-token=".length);
			const reason = remaining.filter((part) => part !== "--confirm" && part !== "confirm" && !part.startsWith("--preview-token=")).join(" ").trim() || undefined;
			try {
				const preview = await buildTaskSubtreeControlPreview(ctx, id, action, { reason });
				const previewText = formatTaskSubtreeControlPreview(preview);
				if (ctx.hasUI) await ctx.ui.editor(`Subtree ${action} preview`, previewText);
				else ctx.ui.notify(previewText, "info");
				if (action === "preview") {
					updateFleetUi(ctx);
					return;
				}
				let ok = confirm;
				if (!ok && ctx.hasUI) ok = await ctx.ui.confirm(`Confirm subtree ${action}`, formatTaskSubtreeControlConfirmation(preview));
				if (!ok) {
					ctx.ui.notify("Subtree control not applied; explicit confirmation is required.", "warning");
					updateFleetUi(ctx);
					return;
				}
				const result = await applyTaskSubtreeControl(ctx, id, action, { reason, previewToken: previewToken ?? (ctx.hasUI ? preview.previewToken : undefined) });
				const resultText = formatTaskSubtreeControlApplyResult(result);
				if (ctx.hasUI) await ctx.ui.editor(`Subtree ${action} result`, resultText);
				else ctx.ui.notify(resultText, result.stopErrors.length > 0 ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("task-spawn", {
		description: "Spawn a child agent against a task",
		handler: async (args, ctx) => {
			const id = args?.trim();
			await runTaskSpawnWizard(pi, ctx, id || undefined);
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-open", {
		description: "Focus a tracked tmux child by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /agent-open <id>", "warning");
				return;
			}
			try {
				const { agent, result } = await focusAgentById(id);
				setLastFocusedActiveAgentId(agent.id);
				ctx.ui.notify(result.focused ? `Focused ${agent.id}.` : formatFocusResult(agent, result), result.focused ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-message", {
		description: "Send a structured message to a tracked tmux child",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const kind = parts[1] as "answer" | "note" | "redirect" | "cancel" | "priority" | undefined;
			const validKinds = new Set(["answer", "note", "redirect", "cancel", "priority"]);
			const summary = parts.slice(2).join(" ").trim();
			if (!id || !kind || !validKinds.has(kind) || !summary) {
				ctx.ui.notify("Usage: /agent-message <id> <answer|note|redirect|cancel|priority> <message>", "warning");
				return;
			}
			try {
				const agent = getAgent(getMeepoDb(), id);
				if (!agent) throw new Error(`Unknown agent id \"${id}\".`);
				if (
					!(await getProcessHost().targetExists(hostTargetRefFromLegacy(agent)))
				) {
					throw new Error(missingHostTargetMessage(agent.id));
				}
				queueDownwardMessage(agent, kind, { summary }, "immediate");
				const liveDelivery = await deliverQueuedMessagesViaBridge(agent.id);
				ctx.ui.notify(
					liveDelivery.delivered > 0 ? `Queued ${kind} for ${id} and delivered via RPC bridge.` : `Queued ${kind} for ${id}.`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-capture", {
		description: "Debug-capture recent host pane output for a tracked child",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const lines = parts[1] ? Number(parts[1]) : 200;
			if (!id) {
				ctx.ui.notify("Usage: /agent-capture <id> [lines]", "warning");
				return;
			}
			try {
				const capture = await captureAgentById(id, Number.isFinite(lines) && lines > 0 ? lines : 200);
				await ctx.ui.editor(`Capture ${capture.agent.id}`, capture.content || "(empty capture)");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-stop", {
		description: "Stop a tracked tmux child by id",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const force = parts.includes("force") || parts.includes("--force");
			if (!id) {
				ctx.ui.notify("Usage: /agent-stop <id> [force]", "warning");
				return;
			}
			try {
				const { agent, result } = await stopAgentById(id, force);
				ctx.ui.notify(formatStopResult(agent, result, force), force ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-sync", {
		description: "Refresh tmux subagent status from the global registry",
		handler: async (_args, ctx) => {
			try {
				const result = await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 });
				updateFleetUi(ctx);
				ctx.ui.notify(formatReconcileResult(result), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("agent-attention", {
		description: "List unresolved subagent attention items",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | "descendants" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session", "descendants"].includes(scope)) {
				ctx.ui.notify("Usage: /agent-attention [all|current_project|current_session|descendants]", "warning");
				return;
			}
			const filters = resolveAttentionFilters(ctx, scope, { limit: 200 });
			const items = listAttentionItems(getMeepoDb(), filters);
			const agentsById = new Map(
				listAgents(getMeepoDb(), { ids: [...new Set(items.map((item) => item.agentId))], limit: 200 }).map((agent) => [agent.id, agent]),
			);
			const text = buildAttentionText(items, agentsById, false);
			if (ctx.hasUI) await ctx.ui.editor("subagent attention", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("agent-cleanup", {
		description: "Clean up completed/terminal child host targets",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/).filter(Boolean) ?? [];
			const force = parts.includes("force") || parts.includes("--force");
			const scope = parts.find((part) => ["all", "current_project", "current_session", "descendants"].includes(part)) as
				| "all"
				| "current_project"
				| "current_session"
				| "descendants"
				| undefined;
			const id = parts.find((part) => !["all", "current_project", "current_session", "descendants", "force", "--force"].includes(part));
			if (parts.length > 0 && !scope && !id && !force) {
				ctx.ui.notify("Usage: /agent-cleanup [<id>|all|current_project|current_session|descendants] [force]", "warning");
				return;
			}
			const candidates = await listCleanupCandidates(ctx, { scope: scope ?? "current_project", ids: id ? [id] : undefined, force, limit: 200 });
			if (candidates.length === 0) {
				ctx.ui.notify("No terminal agents matched for cleanup.", "info");
				updateFleetUi(ctx);
				return;
			}
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Cleanup terminal agents", `${formatCleanupCandidates(candidates, true)}\n\nProceed?`);
				if (!ok) return;
			}
			const ready = candidates.filter((candidate) => candidate.cleanupAllowed);
			const skipped = candidates.filter((candidate) => !candidate.cleanupAllowed);
			const results = await Promise.all(ready.map((candidate) => cleanupAgentTarget(candidate, force)));
			const text = formatCleanupResults(results, skipped);
			if (ctx.hasUI) await ctx.ui.editor("subagent cleanup", text);
			else ctx.ui.notify(text, "info");
			updateFleetUi(ctx);
		},
	});

	pi.registerCommand("service-start", {
		description: "Interactive tmux service spawn wizard",
		handler: async (_args, ctx) => {
			await runServiceSpawnWizard(ctx);
		},
	});

	pi.registerCommand("services", {
		description: "List tracked tmux services",
		handler: async (args, ctx) => {
			const scope = (args?.trim() as "all" | "current_project" | "current_session" | undefined) ?? "current_project";
			if (!["all", "current_project", "current_session"].includes(scope)) {
				ctx.ui.notify("Usage: /services [all|current_project|current_session]", "warning");
				return;
			}
			const filters = resolveServiceFilters(ctx, scope, { activeOnly: false, limit: 200 });
			const services = listServices(getMeepoDb(), filters);
			const text = `${`scope=${summarizeServiceFilters(scope, filters)} · ${services.length} service${services.length === 1 ? "" : "s"}`}${services.length === 0 ? "\n\nNo services matched." : `\n\n${services.map(formatServiceLine).join("\n")}`}`;
			if (ctx.hasUI) await ctx.ui.editor("tmux services", text);
			else ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("service-open", {
		description: "Focus a tracked tmux service by id",
		handler: async (args, ctx) => {
			const id = args?.trim();
			if (!id) {
				ctx.ui.notify("Usage: /service-open <id>", "warning");
				return;
			}
			try {
				const { service, result } = await focusServiceById(id);
				ctx.ui.notify(result.focused ? `Focused ${service.id}.` : formatServiceFocusResult(service, result), result.focused ? "info" : "warning");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-capture", {
		description: "Capture recent tmux service output",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const lines = parts[1] ? Number(parts[1]) : 200;
			if (!id) {
				ctx.ui.notify("Usage: /service-capture <id> [lines]", "warning");
				return;
			}
			try {
				const capture = await captureServiceById(id, Number.isFinite(lines) && lines > 0 ? lines : 200);
				await ctx.ui.editor(`Service capture ${capture.service.id}`, capture.content || "(empty capture)");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-stop", {
		description: "Stop a tracked tmux service by id",
		handler: async (args, ctx) => {
			const parts = args?.trim().split(/\s+/) ?? [];
			const id = parts[0];
			const force = parts.includes("force") || parts.includes("--force");
			if (!id) {
				ctx.ui.notify("Usage: /service-stop <id> [force]", "warning");
				return;
			}
			try {
				const { service, result } = await stopServiceById(id, force);
				ctx.ui.notify(formatServiceStopResult(service, result, force), force ? "warning" : "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("service-sync", {
		description: "Refresh tmux service status from the global registry",
		handler: async (_args, ctx) => {
			try {
				const result = await reconcileServices(ctx, { scope: "current_project", activeOnly: false, limit: 200 });
				ctx.ui.notify(formatServiceReconcileResult(result), "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerShortcut(Key.ctrlAlt("a"), {
		description: "Open tracked tmux agents dashboard",
		handler: async (ctx) => {
			dashboardState = await runAgentsDashboard(pi, ctx, dashboardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("b"), {
		description: "Open tracked task board",
		handler: async (ctx) => {
			boardState = await runAgentsBoard(pi, ctx, boardState);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("n"), {
		description: "Spawn a task-linked tmux child agent",
		handler: async (ctx) => {
			await runSpawnWizard(pi, ctx);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("j"), {
		description: "Focus next active child agent",
		handler: async (ctx) => {
			await cycleActiveAgent(ctx, 1);
			updateFleetUi(ctx);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("k"), {
		description: "Focus previous active child agent",
		handler: async (ctx) => {
			await cycleActiveAgent(ctx, -1);
			updateFleetUi(ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		const db = getMeepoDb();
		await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 }).catch(() => {});
		reconcileTasks(db, { projectKey: getProjectKey(ctx.cwd), limit: 500 });
		const activeAgents = listAgents(db, { projectKey: getProjectKey(ctx.cwd), activeOnly: true, limit: 200 });
		for (const agent of activeAgents) {
			if (agent.transportKind === "rpc_bridge") {
				void deliverQueuedMessagesViaBridge(agent.id);
			}
		}
		if (!childRuntimeEnvironment) {
			if (attentionWakePoll) clearInterval(attentionWakePoll);
			setAttentionWakePoll(setInterval(() => {
				void wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
			}, ATTENTION_WAKE_POLL_MS));
			await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		}
		updateFleetUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!childRuntimeEnvironment) {
			await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		}
		updateFleetUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		if (attentionWakePoll) clearInterval(attentionWakePoll);
		setAttentionWakePoll(undefined);
		closeMeepoDb();
	});
}

/**
 * Pi extension entrypoint. Boots MeepoRuntime with full-default config, then registers
 * today's coordinator/child surface. Capability gating uses the runtime plan in later tickets.
 */