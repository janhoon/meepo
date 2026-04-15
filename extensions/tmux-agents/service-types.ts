export const SERVICE_STATES = ["launching", "running", "stopped", "error", "lost"] as const;

export type ServiceState = (typeof SERVICE_STATES)[number];

export interface ServiceStatusSnapshot {
	serviceId: string;
	state: ServiceState;
	updatedAt: number;
	lastExitCode?: number | null;
	lastError?: string | null;
	finishedAt?: number | null;
}

export interface ServiceSummary {
	id: string;
	spawnSessionId: string | null;
	spawnSessionFile: string | null;
	spawnCwd: string;
	projectKey: string;
	title: string;
	command: string;
	env: Record<string, string> | null;
	readySubstring: string | null;
	readyMatchedAt: number | null;
	state: ServiceState;
	tmuxSessionId: string | null;
	tmuxSessionName: string | null;
	tmuxWindowId: string | null;
	tmuxPaneId: string | null;
	runDir: string;
	logFile: string;
	latestStatusFile: string;
	lastExitCode: number | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
	finishedAt: number | null;
}

export interface CreateServiceInput {
	id: string;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd: string;
	projectKey: string;
	title: string;
	command: string;
	env?: Record<string, string> | null;
	readySubstring?: string | null;
	readyMatchedAt?: number | null;
	state: ServiceState;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	runDir: string;
	logFile: string;
	latestStatusFile: string;
	lastExitCode?: number | null;
	lastError?: string | null;
	createdAt?: number;
	updatedAt?: number;
	finishedAt?: number | null;
}

export interface UpdateServiceInput {
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
	spawnCwd?: string;
	projectKey?: string;
	title?: string;
	command?: string;
	env?: Record<string, string> | null;
	readySubstring?: string | null;
	readyMatchedAt?: number | null;
	state?: ServiceState;
	tmuxSessionId?: string | null;
	tmuxSessionName?: string | null;
	tmuxWindowId?: string | null;
	tmuxPaneId?: string | null;
	runDir?: string;
	logFile?: string;
	latestStatusFile?: string;
	lastExitCode?: number | null;
	lastError?: string | null;
	updatedAt?: number;
	finishedAt?: number | null;
}

export interface ListServicesFilters {
	ids?: string[];
	projectKey?: string;
	spawnSessionId?: string;
	spawnSessionFile?: string;
	activeOnly?: boolean;
	limit?: number;
}

export interface SpawnServiceInput {
	id?: string;
	title: string;
	command: string;
	spawnCwd: string;
	env?: Record<string, string> | null;
	readySubstring?: string | null;
	readyTimeoutSec?: number | null;
	spawnSessionId?: string | null;
	spawnSessionFile?: string | null;
}

export interface SpawnServiceResult {
	serviceId: string;
	title: string;
	command: string;
	spawnCwd: string;
	runDir: string;
	logFile: string;
	latestStatusFile: string;
	readySubstring: string | null;
	readyMatched: boolean;
	readyTimedOut: boolean;
	state: ServiceState;
	statusSnapshot: ServiceStatusSnapshot | null;
	initialOutput: string;
	tmuxSessionId: string;
	tmuxSessionName: string;
	tmuxWindowId: string;
	tmuxPaneId: string;
}
