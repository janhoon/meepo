import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureTmuxAgentsRuntimePaths } from "./paths.js";
import { createAgent, createAgentEvent, createArtifact, updateAgent } from "./registry.js";
import type { CreateAgentInput, SessionChildLinkEntryData, SpawnSubagentInput, SpawnSubagentResult, SubagentProfile } from "./types.js";
import { getTmuxAgentsDb } from "./db.js";
import { getProjectKey } from "./project.js";

const DETACHED_SESSION_NAME = "pi-subagents";
const TMUX_OUTPUT_FORMAT = "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}";

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
	return [
		`# ${options.title}`,
		"",
		`Child id: ${options.agentId}`,
		`Profile: ${options.profile.name}`,
		`Working directory: ${options.spawnCwd}`,
		options.priority ? `Priority: ${options.priority}` : null,
		"",
		"## Task",
		options.task,
		"",
		"## Coordination requirements",
		"- Use exact file paths in every substantive update.",
		"- Use `subagent_publish` for milestones, blockers, questions, and completion handoffs.",
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
		`Spawn session id: ${options.spawnSessionId ?? "none"}`,
		`Spawn session file: ${options.spawnSessionFile ?? "none"}`,
		"",
		"Reporting contract:",
		"- The runtime marks you started automatically when work begins.",
		"- Use `subagent_publish` whenever you hit a milestone, blocker, question, or completion handoff.",
		"- Include concise summaries and exact file paths when relevant.",
		"- For blockers, include what you tried and the exact answer you need.",
		"- For user-facing clarification, publish `question_for_user`.",
		"- For coordinator clarification, publish `question`.",
		"- For completion, include completed work, files changed/files involved, blockers remaining, and a recommended next action.",
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
	]
		.join("\n");
}

function buildLaunchScriptContent(
	options: CreateRunArtifactsOptions,
	paths: { sessionFile: string; taskFile: string; runtimeAppendixFile: string },
): string {
	const args = [
		shellQuote(resolvePiCommand()),
		"--session",
		shellQuote(paths.sessionFile),
		"--tools",
		shellQuote(options.tools.join(",")),
		"--append-system-prompt",
		shellQuote(options.profile.filePath),
		"--append-system-prompt",
		shellQuote(paths.runtimeAppendixFile),
	];
	if (options.model) {
		args.push("--model", shellQuote(options.model));
	}
	args.push(shellQuote(`@${paths.taskFile}`));
	return [
		"#!/usr/bin/env bash",
		"set -euo pipefail",
		`cd ${shellQuote(options.spawnCwd)}`,
		`export PI_TMUX_AGENTS_CHILD=1`,
		`export PI_TMUX_AGENTS_CHILD_ID=${shellQuote(options.agentId)}`,
		`export PI_TMUX_AGENTS_RUN_DIR=${shellQuote(dirname(paths.sessionFile))}`,
		`export PI_TMUX_AGENTS_PROFILE=${shellQuote(options.profile.name)}`,
		`export PI_TMUX_AGENTS_ALLOWED_TOOLS=${shellQuote(options.tools.join(","))}`,
		`export PI_TMUX_AGENTS_PARENT_AGENT_ID=${shellQuote(options.parentAgentId ?? "")}`,
		`export PI_TMUX_AGENTS_SPAWN_SESSION_ID=${shellQuote(options.spawnSessionId ?? "")}`,
		`export PI_TMUX_AGENTS_SPAWN_SESSION_FILE=${shellQuote(options.spawnSessionFile ?? "")}`,
		`exec ${args.join(" ")}`,
	].join("\n");
}

function writeRunArtifacts(options: CreateRunArtifactsOptions): {
	runDir: string;
	taskFile: string;
	runtimeAppendixFile: string;
	launchScript: string;
	sessionFile: string;
	latestStatusFile: string;
	eventsFile: string;
	debugLogFile: string;
} {
	const { runsDir } = ensureTmuxAgentsRuntimePaths();
	const runDir = join(runsDir, options.agentId);
	mkdirSync(runDir, { recursive: true });
	const taskFile = join(runDir, "task.md");
	const runtimeAppendixFile = join(runDir, "runtime-appendix.md");
	const launchScript = join(runDir, "launch.sh");
	const sessionFile = join(runDir, "session.jsonl");
	const latestStatusFile = join(runDir, "latest-status.json");
	const eventsFile = join(runDir, "events.jsonl");
	const debugLogFile = join(runDir, "debug.log");
	writeFileSync(taskFile, buildTaskFileContent(options));
	writeFileSync(runtimeAppendixFile, buildRuntimeAppendixContent(options, sessionFile, runDir));
	writeFileSync(launchScript, buildLaunchScriptContent(options, { sessionFile, taskFile, runtimeAppendixFile }));
	chmodSync(launchScript, 0o755);
	writeFileSync(
		latestStatusFile,
		`${JSON.stringify(
			{
				agentId: options.agentId,
				profile: options.profile.name,
				state: "launching",
				title: options.title,
				task: options.task,
				updatedAt: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(eventsFile, "");
	writeFileSync(debugLogFile, "");
	return { runDir, taskFile, runtimeAppendixFile, launchScript, sessionFile, latestStatusFile, eventsFile, debugLogFile };
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
	const createRunOptions: CreateRunArtifactsOptions = {
		agentId,
		title: input.title,
		task: input.task,
		profile: input.profile,
		spawnCwd,
		model: input.model,
		tools,
		priority: input.priority,
		parentAgentId: input.parentAgentId,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
	};
	const runArtifacts = writeRunArtifacts(createRunOptions);
	const db = getTmuxAgentsDb();
	const agentRecord: CreateAgentInput = {
		id: agentId,
		parentAgentId: input.parentAgentId,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		spawnCwd,
		projectKey: getProjectKey(spawnCwd),
		profile: input.profile.name,
		title: input.title,
		task: input.task,
		state: "launching",
		model: input.model,
		tools,
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
	});
	let tmuxTarget: TmuxTarget;
	try {
		tmuxTarget = spawnTmuxWindow(runArtifacts.launchScript, input.title, agentId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		updateAgent(db, agentId, { state: "error", lastError: message, updatedAt: Date.now() });
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
		tmuxSessionId: tmuxTarget.sessionId,
		tmuxSessionName: tmuxTarget.sessionName,
		tmuxWindowId: tmuxTarget.windowId,
		tmuxPaneId: tmuxTarget.paneId,
		createdAt: now,
	};
	return {
		agentId,
		profile: input.profile.name,
		title: input.title,
		spawnCwd,
		runDir: runArtifacts.runDir,
		sessionFile: runArtifacts.sessionFile,
		tmuxSessionId: tmuxTarget.sessionId,
		tmuxSessionName: tmuxTarget.sessionName,
		tmuxWindowId: tmuxTarget.windowId,
		tmuxPaneId: tmuxTarget.paneId,
		sessionLinkData,
	};
}
