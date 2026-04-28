import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ensureTmuxAgentsRuntimePaths, getSubagentRunPaths, type SubagentRunPaths } from "./paths.js";
import { createAgent, createAgentEvent, createArtifact, updateAgent } from "./registry.js";
import { getTask } from "./task-registry.js";
import type { TaskRecord } from "./task-types.js";
import type {
	CreateAgentInput,
	RpcBridgeConfig,
	SessionChildLinkEntryData,
	SpawnSubagentInput,
	SpawnSubagentResult,
	SubagentProfile,
} from "./types.js";
import { getTmuxAgentsDb } from "./db.js";
import { getProjectKey } from "./project.js";

const DETACHED_SESSION_NAME = "pi-subagents";
const TMUX_OUTPUT_FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}";
const RPC_BRIDGE_ENTRY_SCRIPT = fileURLToPath(new URL("./rpc-bridge.mjs", import.meta.url));

interface TmuxTarget {
	sessionId: string;
	sessionName: string;
	windowId: string;
	paneId: string;
}

interface CreateRunArtifactsOptions {
	agentId: string;
	title: string;
	task: string;
	profile: SubagentProfile;
	spawnCwd: string;
	model: string | null;
	tools: string[];
	priority: string | null;
	taskId: string | null;
	taskRecord?: TaskRecord | null;
	workspaceStrategy?: TaskRecord["workspaceStrategy"] | null;
	worktreeId?: string | null;
	worktreeCwd?: string | null;
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function commandExists(command: string): boolean {
	const result = spawnSync("bash", ["-lc", `command -v ${shellQuote(command)} >/dev/null 2>&1`], { stdio: "ignore" });
	return result.status === 0;
}

function resolvePiCommand(): string {
	const result = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
	const command = result.stdout?.trim();
	return command || "pi";
}

function parseTmuxTarget(output: string): TmuxTarget {
	const [sessionId, sessionName, windowId, paneId] = output.trim().split("\t");
	if (!sessionId || !sessionName || !windowId || !paneId) {
		throw new Error(`Unexpected tmux target output: ${JSON.stringify(output)}`);
	}
	return { sessionId, sessionName, windowId, paneId };
}

function runTmux(args: string[]): string {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `tmux ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
}

function getCurrentTmuxTarget(): TmuxTarget | null {
	if (!process.env.TMUX) return null;
	try {
		return parseTmuxTarget(runTmux(["display-message", "-p", TMUX_OUTPUT_FORMAT]));
	} catch {
		return null;
	}
}

function sanitizeWindowName(title: string, agentId: string): string {
	const safeTitle = title.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
	const base = safeTitle || "agent";
	return `${base.slice(0, 24)}-${agentId.slice(-6)}`;
}

function buildTaskFileContent(options: CreateRunArtifactsOptions): string {
	const taskRecord = options.taskRecord;
	return [
		`# ${options.title}`,
		"",
		`Child id: ${options.agentId}`,
		`Profile: ${options.profile.name}`,
		`Working directory: ${options.spawnCwd}`,
		options.priority ? `Priority: ${options.priority}` : null,
		options.taskId ? `Task id: ${options.taskId}` : null,
		taskRecord ? `Task status: ${taskRecord.status}` : null,
		options.workspaceStrategy ? `Workspace strategy: ${options.workspaceStrategy}` : null,
		options.worktreeId ? `Worktree id: ${options.worktreeId}` : null,
		options.worktreeCwd ? `Worktree cwd: ${options.worktreeCwd}` : null,
		"",
		taskRecord ? "## Linked task" : null,
		taskRecord ? taskRecord.title : null,
		taskRecord?.summary ? `Summary: ${taskRecord.summary}` : null,
		taskRecord?.description ? `Description: ${taskRecord.description}` : null,
		taskRecord && taskRecord.acceptanceCriteria.length > 0 ? "" : null,
		taskRecord && taskRecord.acceptanceCriteria.length > 0 ? "### Acceptance Criteria" : null,
		...(taskRecord?.acceptanceCriteria ?? []).map((item) => `- ${item}`),
		taskRecord && taskRecord.planSteps.length > 0 ? "" : null,
		taskRecord && taskRecord.planSteps.length > 0 ? "### Plan Steps" : null,
		...(taskRecord?.planSteps ?? []).map((item, index) => `${index + 1}. ${item}`),
		taskRecord && taskRecord.validationSteps.length > 0 ? "" : null,
		taskRecord && taskRecord.validationSteps.length > 0 ? "### Validation" : null,
		...(taskRecord?.validationSteps ?? []).map((item) => `- ${item}`),
		taskRecord && taskRecord.files.length > 0 ? "" : null,
		taskRecord && taskRecord.files.length > 0 ? "### Relevant Files" : null,
		...(taskRecord?.files ?? []).map((item) => `- ${item}`),
		"",
		"## Delegated task",
		options.task,
		"",
		"## Coordination requirements",
		"- Use exact file paths in every substantive update.",
		"- Use `subagent_publish` for milestones, blockers, questions, and completion handoffs.",
		"- Include a task-state recommendation in substantive completion or blocker updates when relevant.",
		"- Ask one concrete question at a time when clarification is required.",
		"- Do not use `find`; use `grep` and `bash` with `rg --files` instead.",
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function buildRuntimeAppendixContent(options: CreateRunArtifactsOptions, sessionFile: string, runDir: string): string {
	return [
		"# tmux-agents runtime appendix",
		"",
		`Child id: ${options.agentId}`,
		`Profile: ${options.profile.name}`,
		`Run directory: ${runDir}`,
		`Session file: ${sessionFile}`,
		`Parent agent id: ${options.parentAgentId ?? "none"}`,
		`Task id: ${options.taskId ?? "none"}`,
		`Spawn session id: ${options.spawnSessionId ?? "none"}`,
		`Spawn session file: ${options.spawnSessionFile ?? "none"}`,
		`Workspace strategy: ${options.workspaceStrategy ?? "none"}`,
		`Worktree id: ${options.worktreeId ?? "none"}`,
		`Worktree cwd: ${options.worktreeCwd ?? "none"}`,
		"",
		"Reporting contract:",
		"- The runtime marks you started automatically when work begins.",
		"- Use `subagent_publish` whenever you hit a milestone, blocker, question, or completion handoff.",
		"- Your updates are attached to a tracked task when a task id is present.",
		"- Include concise summaries and exact file paths when relevant.",
		"- For blockers, include what you tried and the exact answer you need.",
		"- For user-facing clarification, publish `question_for_user`.",
		"- For coordinator clarification, publish `question`.",
		"- For completion, include completed work, files changed/files involved, blockers remaining, a recommended next action, and the recommended task status when relevant.",
		"",
		"Search policy:",
		"- Never use `find`.",
		"- Use `grep` for content search.",
		"- Use `bash` with `rg --files`, `rg --files -g '<glob>'`, and `rg -n '<pattern>'` for discovery.",
		"- Use `read` for focused inspection.",
		"",
		"Question discipline:",
		"- Ask only one concrete question at a time.",
		"- Keep context minimal and path-specific.",
		"- Publish the question immediately instead of waiting silently.",
		"",
		"Downward message handling contract:",
		"- Coordinator messages are the primary control plane; do not rely on pane capture for coordination.",
		"- Messages may include an action policy:",
		"  - `fyi`: treat as context; continue unless it materially changes the plan.",
		"  - `resume_if_blocked`: if this resolves your blocker/wait, resume immediately and publish a brief note.",
		"  - `replan`: revise your plan before more substantive work and publish a brief note if the plan changes.",
		"  - `interrupt_and_replan`: stop the current approach, replan now, and publish a brief note.",
		"  - `stop`: stop current work gracefully and publish a completion-style handoff or cancellation summary.",
		"- After acting on an answer, redirect, cancel, or priority message, publish a concise note or completion update with exact file paths when relevant.",
	]
		.join("\n");
}

// The child reporting tool must always be permitted through the pi CLI --tools
// allowlist; otherwise pi filters the extension-registered tool out of the
// session registry and the child has no way to publish updates upward.
const CHILD_REPORTING_TOOL_NAME = "subagent_publish";

function buildPiAllowedToolsArg(userTools: readonly string[]): string {
	const merged = new Set<string>(userTools);
	merged.add(CHILD_REPORTING_TOOL_NAME);
	return Array.from(merged).join(",");
}

function buildBridgeConfig(options: CreateRunArtifactsOptions, paths: SubagentRunPaths): RpcBridgeConfig {
	const piToolsArg = buildPiAllowedToolsArg(options.tools);
	const piArgs = [
		"--mode",
		"rpc",
		"--session",
		paths.sessionFile,
		"--tools",
		piToolsArg,
		"--append-system-prompt",
		options.profile.filePath,
		"--append-system-prompt",
		paths.runtimeAppendixFile,
	];
	if (options.model) {
		piArgs.push("--model", options.model);
	}
	return {
		agentId: options.agentId,
		title: options.title,
		spawnCwd: options.spawnCwd,
		runDir: paths.runDir,
		sessionFile: paths.sessionFile,
		taskFile: paths.taskFile,
		profileFile: options.profile.filePath,
		runtimeAppendixFile: paths.runtimeAppendixFile,
		allowedTools: [...options.tools],
		model: options.model,
		piCommand: resolvePiCommand(),
		piArgs,
		bridgeSocketPath: paths.bridgeSocketPath,
		bridgeStatusFile: paths.bridgeStatusFile,
		bridgeEventsFile: paths.bridgeEventsFile,
		bridgeLogFile: paths.bridgeLogFile,
		bridgePidFile: paths.bridgePidFile,
		latestStatusFile: paths.latestStatusFile,
		debugLogFile: paths.debugLogFile,
		childEnv: {
			PI_TMUX_AGENTS_CHILD: "1",
			PI_TMUX_AGENTS_CHILD_ID: options.agentId,
			PI_TMUX_AGENTS_RUN_DIR: paths.runDir,
			PI_TMUX_AGENTS_PROFILE: options.profile.name,
			PI_TMUX_AGENTS_ALLOWED_TOOLS: options.tools.join(","),
			PI_TMUX_AGENTS_TASK_ID: options.taskId ?? "",
			PI_TMUX_AGENTS_PARENT_AGENT_ID: options.parentAgentId ?? "",
			PI_TMUX_AGENTS_SPAWN_SESSION_ID: options.spawnSessionId ?? "",
			PI_TMUX_AGENTS_SPAWN_SESSION_FILE: options.spawnSessionFile ?? "",
			PI_TMUX_AGENTS_WORKSPACE_STRATEGY: options.workspaceStrategy ?? "",
			PI_TMUX_AGENTS_WORKTREE_ID: options.worktreeId ?? "",
			PI_TMUX_AGENTS_WORKTREE_CWD: options.worktreeCwd ?? "",
			PI_TMUX_AGENTS_TRANSPORT_KIND: "rpc_bridge",
			PI_TMUX_AGENTS_BRIDGE_STATUS_FILE: paths.bridgeStatusFile,
		},
		createdAt: Date.now(),
	};
}

function buildLaunchScriptContent(options: CreateRunArtifactsOptions, paths: SubagentRunPaths): string {
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`cd ${shellQuote(options.spawnCwd)}`,
		`exec ${shellQuote(process.execPath)} ${shellQuote(RPC_BRIDGE_ENTRY_SCRIPT)} --config ${shellQuote(paths.bridgeConfigFile)}`,
	].join("\n");
}

function writeRunArtifacts(options: CreateRunArtifactsOptions): SubagentRunPaths {
	const { runsDir } = ensureTmuxAgentsRuntimePaths();
	const runDir = join(runsDir, options.agentId);
	mkdirSync(runDir, { recursive: true });
	const paths = getSubagentRunPaths(runDir);
	writeFileSync(paths.taskFile, buildTaskFileContent(options));
	writeFileSync(paths.runtimeAppendixFile, buildRuntimeAppendixContent(options, paths.sessionFile, runDir));
	writeFileSync(paths.bridgeConfigFile, `${JSON.stringify(buildBridgeConfig(options, paths), null, 2)}\n`);
	writeFileSync(paths.launchScript, buildLaunchScriptContent(options, paths));
	chmodSync(paths.launchScript, 0o755);
	writeFileSync(
		paths.latestStatusFile,
		`${JSON.stringify(
			{
				agentId: options.agentId,
				profile: options.profile.name,
				state: "launching",
				title: options.title,
				task: options.task,
				taskId: options.taskId,
				updatedAt: Date.now(),
				source: "spawn",
				transportKind: "rpc_bridge",
				transportState: "launching",
				downwardDeliveryMode: "rpc_bridge",
				workspaceStrategy: options.workspaceStrategy ?? null,
				worktreeId: options.worktreeId ?? null,
				worktreeCwd: options.worktreeCwd ?? null,
				lastToolName: null,
				lastAssistantPreview: null,
				lastError: null,
				finalSummary: null,
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		paths.bridgeStatusFile,
		`${JSON.stringify(
			{
				agentId: options.agentId,
				transportKind: "rpc_bridge",
				transportState: "launching",
				updatedAt: Date.now(),
				bridgePid: null,
				childPid: null,
				socketPath: paths.bridgeSocketPath,
				connectedAt: null,
				lastError: null,
				lastEventType: null,
				isStreaming: false,
				pendingRequests: 0,
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(paths.eventsFile, "");
	writeFileSync(paths.debugLogFile, "");
	writeFileSync(paths.bridgeEventsFile, "");
	writeFileSync(paths.bridgeLogFile, "");
	writeFileSync(paths.bridgePidFile, "");
	return paths;
}

function appendRunEvent(runDir: string, eventType: string, summary: string, payload: unknown): void {
	appendFileSync(
		join(runDir, "events.jsonl"),
		`${JSON.stringify({ id: randomUUID(), eventType, summary, payload, createdAt: Date.now() })}\n`,
	);
}

function spawnTmuxWindow(launchScript: string, title: string, agentId: string): TmuxTarget {
	if (!commandExists("tmux")) {
		throw new Error("tmux is not installed or not on PATH.");
	}
	const currentTarget = getCurrentTmuxTarget();
	const windowName = sanitizeWindowName(title, agentId);
	const launchCommand = `exec ${shellQuote(launchScript)}`;
	if (currentTarget) {
		return parseTmuxTarget(
			runTmux(["new-window", "-t", currentTarget.sessionId, "-P", "-F", TMUX_OUTPUT_FORMAT, "-n", windowName, launchCommand]),
		);
	}
	const hasDetachedSession = spawnSync("tmux", ["has-session", "-t", DETACHED_SESSION_NAME], { stdio: "ignore" }).status === 0;
	if (hasDetachedSession) {
		return parseTmuxTarget(
			runTmux(["new-window", "-t", DETACHED_SESSION_NAME, "-P", "-F", TMUX_OUTPUT_FORMAT, "-n", windowName, launchCommand]),
		);
	}
	return parseTmuxTarget(
		runTmux(["new-session", "-d", "-P", "-F", TMUX_OUTPUT_FORMAT, "-s", DETACHED_SESSION_NAME, "-n", windowName, launchCommand]),
	);
}

export function spawnSubagent(input: SpawnSubagentInput): SpawnSubagentResult {
	const now = Date.now();
	const agentId = input.agentId ?? `sa_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
	const spawnCwd = resolve(input.spawnCwd);
	const tools = [...input.tools];
	const db = getTmuxAgentsDb();
	const createRunOptions: CreateRunArtifactsOptions = {
		agentId,
		title: input.title,
		task: input.task,
		profile: input.profile,
		spawnCwd,
		model: input.model,
		tools,
		priority: input.priority,
		taskId: input.taskId,
		taskRecord: input.taskId ? getTask(db, input.taskId) : null,
		parentAgentId: input.parentAgentId,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		workspaceStrategy: input.workspaceStrategy ?? null,
		worktreeId: input.worktreeId ?? null,
		worktreeCwd: input.worktreeCwd ?? null,
	};
	if (input.taskId && !createRunOptions.taskRecord) {
		throw new Error(`Unknown task id \"${input.taskId}\".`);
	}
	const runArtifacts = writeRunArtifacts(createRunOptions);
	const agentRecord: CreateAgentInput = {
		id: agentId,
		parentAgentId: input.parentAgentId,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		spawnCwd,
		projectKey: getProjectKey(spawnCwd),
		taskId: input.taskId,
		workspaceStrategy: input.workspaceStrategy ?? null,
		worktreeId: input.worktreeId ?? null,
		worktreeCwd: input.worktreeCwd ?? null,
		profile: input.profile.name,
		title: input.title,
		task: input.task,
		state: "launching",
		transportKind: "rpc_bridge",
		transportState: "launching",
		model: input.model,
		tools,
		bridgeSocketPath: runArtifacts.bridgeSocketPath,
		bridgeStatusFile: runArtifacts.bridgeStatusFile,
		bridgeLogFile: runArtifacts.bridgeLogFile,
		bridgeEventsFile: runArtifacts.bridgeEventsFile,
		bridgeUpdatedAt: now,
		runDir: runArtifacts.runDir,
		sessionFile: runArtifacts.sessionFile,
		createdAt: now,
		updatedAt: now,
	};
	createAgent(db, agentRecord);
	createAgentEvent(db, {
		id: randomUUID(),
		agentId,
		eventType: "spawn_requested",
		summary: `Spawn requested for ${input.profile.name}`,
		payload: {
			title: input.title,
			task: input.task,
			spawnCwd,
			priority: input.priority,
			workspaceStrategy: input.workspaceStrategy ?? null,
			worktreeId: input.worktreeId ?? null,
			worktreeCwd: input.worktreeCwd ?? null,
		},
		createdAt: now,
	});
	for (const artifact of [
		{ kind: "task", path: runArtifacts.taskFile },
		{ kind: "runtime_appendix", path: runArtifacts.runtimeAppendixFile },
		{ kind: "launch_script", path: runArtifacts.launchScript },
		{ kind: "session", path: runArtifacts.sessionFile },
		{ kind: "latest_status", path: runArtifacts.latestStatusFile },
		{ kind: "events", path: runArtifacts.eventsFile },
		{ kind: "debug_log", path: runArtifacts.debugLogFile },
		{ kind: "bridge_config", path: runArtifacts.bridgeConfigFile },
		{ kind: "bridge_status", path: runArtifacts.bridgeStatusFile },
		{ kind: "bridge_events", path: runArtifacts.bridgeEventsFile },
		{ kind: "bridge_log", path: runArtifacts.bridgeLogFile },
		{ kind: "bridge_pid", path: runArtifacts.bridgePidFile },
		{ kind: "bridge_socket", path: runArtifacts.bridgeSocketPath },
	]) {
		createArtifact(db, {
			id: randomUUID(),
			agentId,
			kind: artifact.kind,
			path: artifact.path,
			createdAt: now,
		});
	}
	appendRunEvent(runArtifacts.runDir, "spawn_requested", `Spawn requested for ${input.profile.name}`, {
		title: input.title,
		task: input.task,
		spawnCwd,
		workspaceStrategy: input.workspaceStrategy ?? null,
		worktreeId: input.worktreeId ?? null,
		worktreeCwd: input.worktreeCwd ?? null,
	});
	let tmuxTarget: TmuxTarget;
	try {
		tmuxTarget = spawnTmuxWindow(runArtifacts.launchScript, input.title, agentId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateAgent(db, agentId, {
			state: "error",
			transportKind: "rpc_bridge",
			transportState: "error",
			bridgeLastError: message,
			bridgeUpdatedAt: Date.now(),
			lastError: message,
			updatedAt: Date.now(),
		});
		createAgentEvent(db, {
			id: randomUUID(),
			agentId,
			eventType: "spawn_failed",
			summary: message,
			payload: { error: message },
		});
		appendRunEvent(runArtifacts.runDir, "spawn_failed", message, { error: message });
		throw error;
	}
	updateAgent(db, agentId, {
		tmuxSessionId: tmuxTarget.sessionId,
		tmuxSessionName: tmuxTarget.sessionName,
		tmuxWindowId: tmuxTarget.windowId,
		tmuxPaneId: tmuxTarget.paneId,
		transportKind: "rpc_bridge",
		transportState: "launching",
		bridgeUpdatedAt: Date.now(),
		updatedAt: Date.now(),
	});
	createAgentEvent(db, {
		id: randomUUID(),
		agentId,
		eventType: "tmux_spawned",
		summary: `Spawned in tmux ${tmuxTarget.sessionName}`,
		payload: tmuxTarget,
	});
	appendRunEvent(runArtifacts.runDir, "tmux_spawned", `Spawned in tmux ${tmuxTarget.sessionName}`, tmuxTarget);
	const sessionLinkData: SessionChildLinkEntryData = {
		childId: agentId,
		title: input.title,
		profile: input.profile.name,
		task: input.task,
		runDir: runArtifacts.runDir,
		sessionFile: runArtifacts.sessionFile,
		transportKind: "rpc_bridge",
		transportState: "launching",
		bridgeSocketPath: runArtifacts.bridgeSocketPath,
		bridgeStatusFile: runArtifacts.bridgeStatusFile,
		tmuxSessionId: tmuxTarget.sessionId,
		tmuxSessionName: tmuxTarget.sessionName,
		tmuxWindowId: tmuxTarget.windowId,
		tmuxPaneId: tmuxTarget.paneId,
		taskId: input.taskId,
		workspaceStrategy: input.workspaceStrategy ?? null,
		worktreeId: input.worktreeId ?? null,
		worktreeCwd: input.worktreeCwd ?? null,
		createdAt: now,
	};
	return {
		agentId,
		profile: input.profile.name,
		title: input.title,
		spawnCwd,
		runDir: runArtifacts.runDir,
		sessionFile: runArtifacts.sessionFile,
		taskId: input.taskId,
		workspaceStrategy: input.workspaceStrategy ?? null,
		worktreeId: input.worktreeId ?? null,
		worktreeCwd: input.worktreeCwd ?? null,
		transportKind: "rpc_bridge",
		transportState: "launching",
		bridgeSocketPath: runArtifacts.bridgeSocketPath,
		bridgeStatusFile: runArtifacts.bridgeStatusFile,
		bridgeLogFile: runArtifacts.bridgeLogFile,
		tmuxSessionId: tmuxTarget.sessionId,
		tmuxSessionName: tmuxTarget.sessionName,
		tmuxWindowId: tmuxTarget.windowId,
		tmuxPaneId: tmuxTarget.paneId,
		sessionLinkData,
	};
}
