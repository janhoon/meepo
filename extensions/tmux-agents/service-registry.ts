import type { DatabaseSync } from "node:sqlite";
import type {
	CreateServiceInput,
	ListServicesFilters,
	ServiceState,
	ServiceSummary,
	UpdateServiceInput,
} from "./service-types.js";

const ACTIVE_SERVICE_STATES: ServiceState[] = ["launching", "running"];

const SERVICE_FIELD_TO_COLUMN: Record<keyof UpdateServiceInput, string> = {
	spawnSessionId: "spawn_session_id",
	spawnSessionFile: "spawn_session_file",
	spawnCwd: "spawn_cwd",
	projectKey: "project_key",
	title: "title",
	command: "command",
	env: "env_json",
	readySubstring: "ready_substring",
	readyMatchedAt: "ready_matched_at",
	state: "state",
	tmuxSessionId: "tmux_session_id",
	tmuxSessionName: "tmux_session_name",
	tmuxWindowId: "tmux_window_id",
	tmuxPaneId: "tmux_pane_id",
	runDir: "run_dir",
	logFile: "log_file",
	latestStatusFile: "latest_status_file",
	lastExitCode: "last_exit_code",
	lastError: "last_error",
	updatedAt: "updated_at",
	finishedAt: "finished_at",
};

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
	if (!value) return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

function makePlaceholders(count: number): string {
	return new Array(count).fill("?").join(", ");
}

function addSessionScopeFilter(
	where: string[],
	params: unknown[],
	spawnSessionId: string | undefined,
	spawnSessionFile: string | undefined,
	alias = "s",
): void {
	if (spawnSessionId && spawnSessionFile) {
		where.push(`(${alias}.spawn_session_id = ? OR ${alias}.spawn_session_file = ?)`);
		params.push(spawnSessionId, spawnSessionFile);
		return;
	}
	if (spawnSessionId) {
		where.push(`${alias}.spawn_session_id = ?`);
		params.push(spawnSessionId);
		return;
	}
	if (spawnSessionFile) {
		where.push(`${alias}.spawn_session_file = ?`);
		params.push(spawnSessionFile);
	}
}

function toServiceSummary(row: Record<string, unknown>): ServiceSummary {
	return {
		id: row.id as string,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		spawnCwd: row.spawn_cwd as string,
		projectKey: row.project_key as string,
		title: row.title as string,
		command: row.command as string,
		env: safeJsonParse(row.env_json as string | null, null),
		readySubstring: (row.ready_substring as string | null) ?? null,
		readyMatchedAt: (row.ready_matched_at as number | null) ?? null,
		state: row.state as ServiceSummary["state"],
		tmuxSessionId: (row.tmux_session_id as string | null) ?? null,
		tmuxSessionName: (row.tmux_session_name as string | null) ?? null,
		tmuxWindowId: (row.tmux_window_id as string | null) ?? null,
		tmuxPaneId: (row.tmux_pane_id as string | null) ?? null,
		runDir: row.run_dir as string,
		logFile: row.log_file as string,
		latestStatusFile: row.latest_status_file as string,
		lastExitCode: (row.last_exit_code as number | null) ?? null,
		lastError: (row.last_error as string | null) ?? null,
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
		finishedAt: (row.finished_at as number | null) ?? null,
	};
}

export function createService(db: DatabaseSync, input: CreateServiceInput): void {
	const createdAt = input.createdAt ?? Date.now();
	const updatedAt = input.updatedAt ?? createdAt;
	db.prepare(
		`INSERT INTO tmux_services (
			id,
			spawn_session_id,
			spawn_session_file,
			spawn_cwd,
			project_key,
			title,
			command,
			env_json,
			ready_substring,
			ready_matched_at,
			state,
			tmux_session_id,
			tmux_session_name,
			tmux_window_id,
			tmux_pane_id,
			run_dir,
			log_file,
			latest_status_file,
			last_exit_code,
			last_error,
			created_at,
			updated_at,
			finished_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		input.spawnSessionId ?? null,
		input.spawnSessionFile ?? null,
		input.spawnCwd,
		input.projectKey,
		input.title,
		input.command,
		input.env === undefined ? null : JSON.stringify(input.env),
		input.readySubstring ?? null,
		input.readyMatchedAt ?? null,
		input.state,
		input.tmuxSessionId ?? null,
		input.tmuxSessionName ?? null,
		input.tmuxWindowId ?? null,
		input.tmuxPaneId ?? null,
		input.runDir,
		input.logFile,
		input.latestStatusFile,
		input.lastExitCode ?? null,
		input.lastError ?? null,
		createdAt,
		updatedAt,
		input.finishedAt ?? null,
	);
}

export function updateService(db: DatabaseSync, id: string, patch: UpdateServiceInput): void {
	const assignments: string[] = [];
	const params: unknown[] = [];
	for (const [field, value] of Object.entries(patch) as Array<[keyof UpdateServiceInput, UpdateServiceInput[keyof UpdateServiceInput]]>) {
		if (value === undefined) continue;
		const column = SERVICE_FIELD_TO_COLUMN[field];
		if (!column) continue;
		assignments.push(`${column} = ?`);
		if (field === "env") params.push(JSON.stringify(value));
		else params.push(value);
	}
	if (assignments.length === 0) return;
	params.push(id);
	db.prepare(`UPDATE tmux_services SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
}

export function listServices(db: DatabaseSync, filters: ListServicesFilters = {}): ServiceSummary[] {
	const where: string[] = [];
	const params: unknown[] = [];
	if (filters.ids && filters.ids.length === 0) return [];
	if (filters.ids && filters.ids.length > 0) {
		where.push(`s.id IN (${makePlaceholders(filters.ids.length)})`);
		params.push(...filters.ids);
	}
	if (filters.projectKey) {
		where.push("s.project_key = ?");
		params.push(filters.projectKey);
	}
	addSessionScopeFilter(where, params, filters.spawnSessionId, filters.spawnSessionFile);
	if (filters.activeOnly) {
		where.push(`s.state IN (${makePlaceholders(ACTIVE_SERVICE_STATES.length)})`);
		params.push(...ACTIVE_SERVICE_STATES);
	}
	const limit = Math.max(1, Math.min(filters.limit ?? 50, 200));
	params.push(limit);
	const sql = `
SELECT
	s.*
FROM tmux_services s
${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
ORDER BY
	CASE WHEN s.state IN ('launching', 'running') THEN 0 ELSE 1 END,
	s.updated_at DESC
LIMIT ?`;
	const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
	return rows.map(toServiceSummary);
}

export function getService(db: DatabaseSync, id: string): ServiceSummary | null {
	return listServices(db, { ids: [id], limit: 1 })[0] ?? null;
}
