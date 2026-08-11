import type { Migration } from "./types.js";
import {
	quotedServiceStates,
} from "./quotes.js";

export const migration: Migration = {
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
};
