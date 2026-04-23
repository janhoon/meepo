import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const SESSION_CHILD_LINK_ENTRY_TYPE = "tmux-agents-child-link";

export interface SubagentRunPaths {
	runDir: string;
	taskFile: string;
	runtimeAppendixFile: string;
	launchScript: string;
	sessionFile: string;
	latestStatusFile: string;
	eventsFile: string;
	debugLogFile: string;
	bridgeConfigFile: string;
	bridgeStatusFile: string;
	bridgeEventsFile: string;
	bridgeLogFile: string;
	bridgePidFile: string;
	bridgeSocketPath: string;
}

export interface TmuxAgentsRuntimePaths {
	agentDir: string;
	databasePath: string;
	subagentsDir: string;
	runsDir: string;
	servicesDir: string;
	serviceRunsDir: string;
}

export function getTmuxAgentsRuntimePaths(agentDir = getAgentDir()): TmuxAgentsRuntimePaths {
	return {
		agentDir,
		databasePath: join(agentDir, "subagents.db"),
		subagentsDir: join(agentDir, "subagents"),
		runsDir: join(agentDir, "subagents", "runs"),
		servicesDir: join(agentDir, "services"),
		serviceRunsDir: join(agentDir, "services", "runs"),
	};
}

export function ensureTmuxAgentsRuntimePaths(agentDir = getAgentDir()): TmuxAgentsRuntimePaths {
	const paths = getTmuxAgentsRuntimePaths(agentDir);
	mkdirSync(paths.agentDir, { recursive: true });
	mkdirSync(paths.subagentsDir, { recursive: true });
	mkdirSync(paths.runsDir, { recursive: true });
	mkdirSync(paths.servicesDir, { recursive: true });
	mkdirSync(paths.serviceRunsDir, { recursive: true });
	return paths;
}

function resolveBridgeSocketPath(runDir: string): string {
	const runDirSocketPath = join(runDir, "bridge.sock");
	if (runDirSocketPath.length <= 100) return runDirSocketPath;
	const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim() || "/tmp";
	const shortId = basename(runDir).slice(-24) || "bridge";
	return join(runtimeDir, `pi-${shortId}.sock`);
}

export function getSubagentRunPaths(runDir: string): SubagentRunPaths {
	return {
		runDir,
		taskFile: join(runDir, "task.md"),
		runtimeAppendixFile: join(runDir, "runtime-appendix.md"),
		launchScript: join(runDir, "launch.sh"),
		sessionFile: join(runDir, "session.jsonl"),
		latestStatusFile: join(runDir, "latest-status.json"),
		eventsFile: join(runDir, "events.jsonl"),
		debugLogFile: join(runDir, "debug.log"),
		bridgeConfigFile: join(runDir, "bridge-config.json"),
		bridgeStatusFile: join(runDir, "bridge-status.json"),
		bridgeEventsFile: join(runDir, "bridge-events.jsonl"),
		bridgeLogFile: join(runDir, "bridge.log"),
		bridgePidFile: join(runDir, "bridge.pid"),
		bridgeSocketPath: resolveBridgeSocketPath(runDir),
	};
}
