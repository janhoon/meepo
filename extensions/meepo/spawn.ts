import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ensureMeepoRuntimePaths, getSubagentRunPaths, type SubagentRunPaths } from "./paths.js";
import {
	createAgent,
	createAgentEvent,
	createAgentHierarchyEdge,
	createArtifact,
	ensureAgentHierarchySelfClosure,
	getAgent,
	getAgentOrg,
	getAgentRole,
	updateAgent,
	upsertAgentOrg,
} from "./registry.js";
import type { HierarchyPolicyMode } from "./config.js";
import { evaluateHierarchySpawn } from "./hierarchy-policy.js";
import { resolveProfileRoleKey } from "./profile-metadata.js";
import { assertTaskLeaseAvailable, getTask, linkTaskAgent, unlinkTaskAgent } from "./task-registry.js";
import type { TaskRecord } from "./task-types.js";
import type {
	CreateAgentInput,
	RpcBridgeConfig,
	SessionChildLinkEntryData,
	SpawnSubagentInput,
	SpawnSubagentResult,
	SubagentProfile,
} from "./types.js";
import { getMeepoDb } from "./db.js";
import { getProjectKey } from "./project.js";
import { getProcessHost, hostFieldsFromTarget } from "./process-host.js";
import { buildBridgeLaunchCommand } from "./rpc-bridge-control.js";

const RPC_BRIDGE_ENTRY_SCRIPT = fileURLToPath(new URL("./rpc-bridge.mjs", import.meta.url));

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
	parentAgentId: string | null;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvePiCommand(): string {
	const result = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
	const command = result.stdout?.trim();
	return command || "pi";
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
		"- Never use `sleep`, `watch`, `tail -f`, or shell polling loops to wait for other agents, inbox rows, attention, or review output.",
		"- Treat inbox/attention/capture reads as snapshots: after one pass, act, switch to other ready work, publish/return pending status, or end the turn.",
		"- Do not use `find`; use `grep` and `bash` with `rg --files` instead.",
	]
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function buildRuntimeAppendixContent(options: CreateRunArtifactsOptions, sessionFile: string, runDir: string): string {
	return [
		"# meepo runtime appendix",
		"",
		`Child id: ${options.agentId}`,
		`Profile: ${options.profile.name}`,
		`Run directory: ${runDir}`,
		`Session file: ${sessionFile}`,
		`Parent agent id: ${options.parentAgentId ?? "none"}`,
		`Task id: ${options.taskId ?? "none"}`,
		`Spawn session id: ${options.spawnSessionId ?? "none"}`,
		`Spawn session file: ${options.spawnSessionFile ?? "none"}`,
		"",
		"Reporting contract:",
		"- The runtime marks you started automatically when work begins.",
		"- Use `subagent_publish` whenever you hit a milestone, blocker, question, or completion handoff.",
		"- Your updates are attached to a tracked task when a task id is present.",
		"- Do not wait silently for another agent. If no update is available, publish or return a concise pending-status summary and yield.",
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
			PI_TMUX_AGENTS_TRANSPORT_KIND: "rpc_bridge",
			PI_TMUX_AGENTS_BRIDGE_STATUS_FILE: paths.bridgeStatusFile,
		},
		createdAt: Date.now(),
	};
}

function buildLaunchScriptContent(options: CreateRunArtifactsOptions, paths: SubagentRunPaths): string {
	// Identical launch contract on tmux and herdr (wayfinder #20/#24): bridge is pane main process.
	const launch = buildBridgeLaunchCommand({
		nodeExecutable: process.execPath,
		bridgeEntryScript: RPC_BRIDGE_ENTRY_SCRIPT,
		bridgeConfigFile: paths.bridgeConfigFile,
		shellQuote,
	});
	return ["#!/usr/bin/env bash", "set -euo pipefail", `cd ${shellQuote(options.spawnCwd)}`, launch].join("\n");
}

function writeRunArtifacts(options: CreateRunArtifactsOptions): SubagentRunPaths {
	const { runsDir } = ensureMeepoRuntimePaths();
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

function roleKeyForProfile(profileName: string, metadataRoleKey?: string | null): string {
	// Metadata role wins; optional full-preset name aliases (if registered) are consumer-compat only.
	return resolveProfileRoleKey(profileName, metadataRoleKey);
}

function existingRoleKeyForProfile(profileName: string, metadataRoleKey?: string | null): string | null {
	const db = getMeepoDb();
	const roleKey = roleKeyForProfile(profileName, metadataRoleKey);
	return getAgentRole(db, roleKey) ? roleKey : null;
}

function deterministicOrgId(projectKey: string, spawnSessionId: string | null, spawnSessionFile: string | null): string {
	return `org:spawn:${projectKey}:session:${spawnSessionId ?? ""}:file:${spawnSessionFile ?? ""}`;
}

function ensureSpawnOrg(input: SpawnSubagentInput, projectKey: string, parentAgentId: string | null): string {
	const db = getMeepoDb();
	const parent = parentAgentId ? getAgent(db, parentAgentId) : null;
	const orgId = parent?.orgId ?? deterministicOrgId(projectKey, input.spawnSessionId, input.spawnSessionFile);
	const existingOrg = getAgentOrg(db, orgId);
	upsertAgentOrg(db, {
		id: orgId,
		projectKey,
		rootAgentId: existingOrg?.rootAgentId ?? (parent && !parent.parentAgentId ? parent.id : null),
		title: existingOrg?.title ?? (parent
			? `Hierarchy for ${projectKey} under ${parent.id}`
			: `Hierarchy for ${projectKey}${input.spawnSessionId ? ` session ${input.spawnSessionId}` : ""}`),
		metadata: existingOrg?.metadata ?? { source: "spawn", spawnSessionId: input.spawnSessionId, spawnSessionFile: input.spawnSessionFile },
	});
	return orgId;
}

function ensureAgentRoleKey(agentId: string): string | null {
	const db = getMeepoDb();
	const agent = getAgent(db, agentId);
	if (!agent) throw new Error(`Unknown parent agent id "${agentId}".`);
	if (agent.roleKey) return agent.roleKey;
	const inferredRoleKey = existingRoleKeyForProfile(agent.profile);
	if (!inferredRoleKey) return null;
	updateAgent(db, agent.id, { roleKey: inferredRoleKey, updatedAt: Date.now() });
	return inferredRoleKey;
}

function lookupReportsToEdgePolicy(
	parentRoleKey: string,
	childRoleKey: string,
): { id: string; allowSpawn: boolean } | null {
	const db = getMeepoDb();
	const row = db
		.prepare(
			`SELECT id, allow_spawn
			 FROM agent_role_edge_policies
			 WHERE parent_role_key = ?
				AND child_role_key = ?
				AND edge_type = 'reports_to'
			 LIMIT 1`,
		)
		.get(parentRoleKey, childRoleKey) as { id: string; allow_spawn: number } | undefined;
	if (!row) return null;
	return { id: row.id, allowSpawn: Number(row.allow_spawn) !== 0 };
}

/**
 * Apply hierarchy spawn policy for parent→child.
 * Returns advisory notes for operator-visible logging when mode is advisory.
 */
function assertSpawnEdgePolicy(
	parentAgentId: string,
	childRoleKey: string | null,
	mode: HierarchyPolicyMode = "enforce",
): string | null {
	const parentRoleKey = ensureAgentRoleKey(parentAgentId);
	const edgePolicy =
		parentRoleKey && childRoleKey ? lookupReportsToEdgePolicy(parentRoleKey, childRoleKey) : null;
	const decision = evaluateHierarchySpawn({
		mode,
		parentAgentId,
		parentRoleKey,
		childRoleKey,
		edgePolicy,
	});
	if (decision.outcome === "deny") {
		throw new Error(decision.reason);
	}
	if (decision.outcome === "advisory") return decision.note;
	return decision.note ?? null;
}

export async function spawnSubagent(input: SpawnSubagentInput): Promise<SpawnSubagentResult> {
	const now = Date.now();
	const agentId = input.agentId ?? `sa_${now.toString(36)}_${randomUUID().slice(0, 8)}`;
	const spawnCwd = resolve(input.spawnCwd);
	const tools = [...input.tools];
	const db = getMeepoDb();
	const projectKey = getProjectKey(spawnCwd);
	const childRoleKey = existingRoleKeyForProfile(input.profile.name, input.profile.roleKey);
	const hierarchyMode: HierarchyPolicyMode = input.hierarchyMode ?? "enforce";
	let hierarchyAdvisory: string | null = null;
	if (input.parentAgentId) {
		hierarchyAdvisory = assertSpawnEdgePolicy(input.parentAgentId, childRoleKey, hierarchyMode);
	}
	const orgId = ensureSpawnOrg(input, projectKey, input.parentAgentId);
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
	};
	if (input.taskId && !createRunOptions.taskRecord) {
		throw new Error(`Unknown task id \"${input.taskId}\".`);
	}
	if (input.taskId) {
		assertTaskLeaseAvailable(db, {
			taskId: input.taskId,
			profile: input.profile.name,
			requesterAgentId: agentId,
			allowDuplicateOwner: input.allowDuplicateOwner,
		});
	}
	const runArtifacts = writeRunArtifacts(createRunOptions);
	const agentRecord: CreateAgentInput = {
		id: agentId,
		parentAgentId: input.parentAgentId,
		orgId,
		roleKey: childRoleKey,
		spawnedByAgentId: input.spawnedByAgentId ?? input.parentAgentId,
		hierarchyState: "attached",
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		spawnCwd,
		projectKey,
		taskId: null,
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
	let taskLeaseClaimed = false;
	try {
		if (input.taskId) {
			linkTaskAgent(db, {
				taskId: input.taskId,
				agentId,
				role: input.profile.name,
				isActive: true,
				summary: input.title,
				allowDuplicateOwner: input.allowDuplicateOwner,
				linkedAt: now,
			});
			taskLeaseClaimed = true;
		}
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
			eventType: "spawn_rejected",
			summary: message,
			payload: { error: message, taskId: input.taskId, profile: input.profile.name },
		});
		throw error;
	}
	if (input.parentAgentId) {
		createAgentHierarchyEdge(db, {
			orgId,
			parentAgentId: input.parentAgentId,
			childAgentId: agentId,
			edgeType: "reports_to",
			taskId: input.taskId,
			createdByAgentId: input.spawnedByAgentId ?? null,
			createdByKind: input.createdByKind ?? (input.spawnedByAgentId ? "agent" : "root"),
			reason: input.spawnedByAgentId ? "Spawned by child session delegation." : "Spawned by root/main session.",
			metadata: { source: "spawnSubagent", profile: input.profile.name },
			createdAt: now,
			updatedAt: now,
		});
	} else {
		ensureAgentHierarchySelfClosure(db, orgId, agentId, now);
		const org = getAgentOrg(db, orgId);
		if (org && !org.rootAgentId) {
			upsertAgentOrg(db, {
				id: org.id,
				projectKey: org.projectKey,
				rootAgentId: agentId,
				title: org.title,
				state: org.state,
				metadata: org.metadata,
				createdAt: org.createdAt,
				updatedAt: now,
				archivedAt: org.archivedAt,
			});
		}
	}
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
			hierarchyMode,
		},
		createdAt: now,
	});
	if (hierarchyAdvisory) {
		createAgentEvent(db, {
			id: randomUUID(),
			agentId,
			eventType: "hierarchy_policy_advisory",
			summary: hierarchyAdvisory,
			payload: {
				mode: hierarchyMode,
				parentAgentId: input.parentAgentId,
				childRoleKey,
			},
			createdAt: now,
		});
		appendRunEvent(runArtifacts.runDir, "hierarchy_policy_advisory", hierarchyAdvisory, {
			mode: hierarchyMode,
			parentAgentId: input.parentAgentId,
			childRoleKey,
		});
	}
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
	});
	const host = getProcessHost();
	let hostTarget;
	try {
		hostTarget = await host.spawnWindow({
			title: input.title,
			entityId: agentId,
			launchCommand: `exec ${shellQuote(runArtifacts.launchScript)}`,
			pool: "agents",
			cwd: spawnCwd,
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (taskLeaseClaimed && input.taskId) {
			unlinkTaskAgent(db, input.taskId, agentId, "spawn_failed");
			taskLeaseClaimed = false;
		}
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
	const fields = hostFieldsFromTarget(hostTarget);
	updateAgent(db, agentId, {
		tmuxSessionId: fields.tmuxSessionId,
		tmuxSessionName: fields.tmuxSessionName,
		tmuxWindowId: fields.tmuxWindowId,
		tmuxPaneId: fields.tmuxPaneId,
		hostKind: fields.hostKind,
		hostPrimaryId: fields.hostPrimaryId,
		hostDisplayName: fields.hostDisplayName,
		hostTargetJson: fields.hostTargetJson,
		transportKind: "rpc_bridge",
		transportState: "launching",
		bridgeUpdatedAt: Date.now(),
		updatedAt: Date.now(),
	});
	// Dual-write host_spawned + legacy tmux_spawned during transition.
	createAgentEvent(db, {
		id: randomUUID(),
		agentId,
		eventType: "host_spawned",
		summary: `Spawned on ${fields.hostKind} (${fields.hostDisplayName ?? fields.hostPrimaryId})`,
		payload: hostTarget,
	});
	createAgentEvent(db, {
		id: randomUUID(),
		agentId,
		eventType: "tmux_spawned",
		summary: `Spawned in ${fields.tmuxSessionName ?? fields.hostKind}`,
		payload: {
			sessionId: fields.tmuxSessionId,
			sessionName: fields.tmuxSessionName,
			windowId: fields.tmuxWindowId,
			paneId: fields.tmuxPaneId,
			hostKind: fields.hostKind,
			primaryId: fields.hostPrimaryId,
		},
	});
	appendRunEvent(runArtifacts.runDir, "host_spawned", `Spawned on ${fields.hostKind}`, hostTarget);
	appendRunEvent(runArtifacts.runDir, "tmux_spawned", `Spawned in ${fields.tmuxSessionName ?? fields.hostKind}`, {
		sessionId: fields.tmuxSessionId,
		sessionName: fields.tmuxSessionName,
		windowId: fields.tmuxWindowId,
		paneId: fields.tmuxPaneId,
	});
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
		tmuxSessionId: fields.tmuxSessionId,
		tmuxSessionName: fields.tmuxSessionName,
		tmuxWindowId: fields.tmuxWindowId,
		tmuxPaneId: fields.tmuxPaneId,
		taskId: input.taskId,
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
		transportKind: "rpc_bridge",
		transportState: "launching",
		bridgeSocketPath: runArtifacts.bridgeSocketPath,
		bridgeStatusFile: runArtifacts.bridgeStatusFile,
		bridgeLogFile: runArtifacts.bridgeLogFile,
		tmuxSessionId: fields.tmuxSessionId ?? "",
		tmuxSessionName: fields.tmuxSessionName ?? "",
		tmuxWindowId: fields.tmuxWindowId ?? "",
		tmuxPaneId: fields.tmuxPaneId ?? "",
		hostKind: fields.hostKind,
		hostPrimaryId: fields.hostPrimaryId,
		hostDisplayName: fields.hostDisplayName,
		sessionLinkData,
	};
}
