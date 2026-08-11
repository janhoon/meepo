import type { Migration } from "./types.js";
import {
	quotedDeliveryModes,
	quotedMessageKinds,
	quotedMessageStatuses,
	quotedStates,
	quotedTargetKinds,
} from "./quotes.js";

export const migration: Migration = {
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
};
