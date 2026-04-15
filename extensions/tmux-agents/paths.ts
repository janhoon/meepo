import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";

export const SESSION_CHILD_LINK_ENTRY_TYPE = "tmux-agents-child-link";

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
