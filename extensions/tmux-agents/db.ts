import { DatabaseSync } from "node:sqlite";
import { ensureTmuxAgentsRuntimePaths } from "./paths.js";
import { SERVICE_STATES } from "./service-types.js";
import { AGENT_STATES, DELIVERY_MODES, MESSAGE_STATUSES, MESSAGE_TARGET_KINDS, MESSAGE_KINDS } from "./types.js";

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const quotedStates = AGENT_STATES.map((value) => `'${value}'`).join(", ");
const quotedServiceStates = SERVICE_STATES.map((value) => `'${value}'`).join(", ");
const quotedTargetKinds = MESSAGE_TARGET_KINDS.map((value) => `'${value}'`).join(", ");
const quotedMessageKinds = MESSAGE_KINDS.map((value) => `'${value}'`).join(", ");
const quotedDeliveryModes = DELIVERY_MODES.map((value) => `'${value}'`).join(", ");
const quotedMessageStatuses = MESSAGE_STATUSES.map((value) => `'${value}'`).join(", ");

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: "initial-subagent-registry",
		sql: `
CREATE TABLE IF NOT EXISTS agents (
	id TEXT PRIMARY KEY,
	parent_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	spawn_session_id TEXT NULL,
	spawn_session_file TEXT NULL,
	spawn_cwd TEXT NOT NULL,
	project_key TEXT NOT NULL,
	profile TEXT NOT NULL,
	title TEXT NOT NULL,
	task TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedStates})),
	model TEXT NULL,
	tools_json TEXT NULL,
	tmux_session_id TEXT NULL,
	tmux_session_name TEXT NULL,
	tmux_window_id TEXT NULL,
	tmux_pane_id TEXT NULL,
	run_dir TEXT NOT NULL,
	session_file TEXT NOT NULL,
	last_tool_name TEXT NULL,
	last_assistant_preview TEXT NULL,
	last_error TEXT NULL,
	final_summary TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	finished_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_agents_project_updated ON agents(project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_state_updated ON agents(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_session_updated ON agents(spawn_session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_session_file_updated ON agents(spawn_session_file, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_parent_updated ON agents(parent_agent_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL,
	sender_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	recipient_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	target_kind TEXT NOT NULL CHECK (target_kind IN (${quotedTargetKinds})),
	kind TEXT NOT NULL CHECK (kind IN (${quotedMessageKinds})),
	delivery_mode TEXT NOT NULL CHECK (delivery_mode IN (${quotedDeliveryModes})),
	payload_json TEXT NOT NULL,
	status TEXT NOT NULL CHECK (status IN (${quotedMessageStatuses})),
	created_at INTEGER NOT NULL,
	delivered_at INTEGER NULL,
	acked_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_thread_created ON agent_messages(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_sender_created ON agent_messages(sender_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_recipient_created ON agent_messages(recipient_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_status_created ON agent_messages(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_target_status_created ON agent_messages(target_kind, status, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_events (
	id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	event_type TEXT NOT NULL,
	summary TEXT NULL,
	payload_json TEXT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_events_agent_created ON agent_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_events_type_created ON agent_events(event_type, created_at DESC);

CREATE TABLE IF NOT EXISTS artifacts (
	id TEXT PRIMARY KEY,
	agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,
	path TEXT NOT NULL,
	label TEXT NULL,
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_agent_created ON artifacts(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind_created ON artifacts(kind, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_agent_kind_path ON artifacts(agent_id, kind, path);
`,
	},
	{
		version: 2,
		name: "tracked-tmux-services",
		sql: `
CREATE TABLE IF NOT EXISTS tmux_services (
	id TEXT PRIMARY KEY,
	spawn_session_id TEXT NULL,
	spawn_session_file TEXT NULL,
	spawn_cwd TEXT NOT NULL,
	project_key TEXT NOT NULL,
	title TEXT NOT NULL,
	command TEXT NOT NULL,
	env_json TEXT NULL,
	ready_substring TEXT NULL,
	ready_matched_at INTEGER NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedServiceStates})),
	tmux_session_id TEXT NULL,
	tmux_session_name TEXT NULL,
	tmux_window_id TEXT NULL,
	tmux_pane_id TEXT NULL,
	run_dir TEXT NOT NULL,
	log_file TEXT NOT NULL,
	latest_status_file TEXT NOT NULL,
	last_exit_code INTEGER NULL,
	last_error TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	finished_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_tmux_services_project_updated ON tmux_services(project_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmux_services_state_updated ON tmux_services(state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmux_services_session_updated ON tmux_services(spawn_session_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmux_services_session_file_updated ON tmux_services(spawn_session_file, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tmux_services_ready_updated ON tmux_services(ready_matched_at, updated_at DESC);
`,
	},
];

let openConnection: { path: string; db: DatabaseSync } | undefined;

function applyPragmas(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA temp_store = MEMORY;");
}

function ensureMigrationTable(db: DatabaseSync): void {
	db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at INTEGER NOT NULL
);
`);
}

function getAppliedVersions(db: DatabaseSync): Set<number> {
	const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as Array<{
		version: number;
	}>;
	return new Set(rows.map((row) => row.version));
}

function applyMigration(db: DatabaseSync, migration: Migration): void {
	const now = Date.now();
	db.exec("BEGIN IMMEDIATE;");
	try {
		db.exec(migration.sql);
		db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
			migration.version,
			migration.name,
			now,
		);
		db.exec("COMMIT;");
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Ignore rollback errors.
		}
		throw error;
	}
}

function bootstrapDatabase(db: DatabaseSync): void {
	ensureMigrationTable(db);
	const appliedVersions = getAppliedVersions(db);
	for (const migration of MIGRATIONS) {
		if (!appliedVersions.has(migration.version)) {
			applyMigration(db, migration);
		}
	}
}

export function getTmuxAgentsDb(): DatabaseSync {
	const { databasePath } = ensureTmuxAgentsRuntimePaths();
	if (openConnection && openConnection.path === databasePath) {
		return openConnection.db;
	}

	if (openConnection) {
		try {
			openConnection.db.close();
		} catch {
			// Ignore close errors while rotating connections.
		}
		openConnection = undefined;
	}

	const db = new DatabaseSync(databasePath);
	applyPragmas(db);
	bootstrapDatabase(db);
	openConnection = { path: databasePath, db };
	return db;
}

export function closeTmuxAgentsDb(): void {
	if (!openConnection) return;
	try {
		openConnection.db.close();
	} catch {
		// Ignore close errors on shutdown.
	}
	openConnection = undefined;
}
