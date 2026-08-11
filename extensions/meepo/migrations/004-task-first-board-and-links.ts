import type { Migration } from "./types.js";
import {
	quotedTaskStates,
	quotedTaskWaitingOn,
} from "./quotes.js";

export const migration: Migration = {
	version: 4,
	name: "task-first-board-and-links",
	sql: `
CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY,
	parent_task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
	spawn_session_id TEXT NULL,
	spawn_session_file TEXT NULL,
	spawn_cwd TEXT NOT NULL,
	project_key TEXT NOT NULL,
	title TEXT NOT NULL,
	summary TEXT NULL,
	description TEXT NULL,
	status TEXT NOT NULL CHECK (status IN (${quotedTaskStates})),
	priority INTEGER NOT NULL DEFAULT 3,
	priority_label TEXT NULL,
	waiting_on TEXT NULL CHECK (waiting_on IN (${quotedTaskWaitingOn})),
	blocked_reason TEXT NULL,
	acceptance_criteria_json TEXT NULL,
	plan_steps_json TEXT NULL,
	validation_steps_json TEXT NULL,
	labels_json TEXT NULL,
	files_json TEXT NULL,
	review_summary TEXT NULL,
	final_summary TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	started_at INTEGER NULL,
	review_requested_at INTEGER NULL,
	finished_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status_priority_updated
	ON tasks(project_key, status, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_session_status_updated
	ON tasks(spawn_session_id, spawn_session_file, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_updated
	ON tasks(parent_task_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_events (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	event_type TEXT NOT NULL,
	summary TEXT NOT NULL,
	payload_json TEXT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_events_task_created
	ON task_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_events_agent_created
	ON task_events(agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_agent_links (
	id TEXT PRIMARY KEY,
	task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	role TEXT NOT NULL,
	is_active INTEGER NOT NULL DEFAULT 1,
	linked_at INTEGER NOT NULL,
	unlinked_at INTEGER NULL,
	summary TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_agent_links_task_active_linked
	ON task_agent_links(task_id, is_active, linked_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_agent_links_agent_linked
	ON task_agent_links(agent_id, linked_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_agent_links_active_pair
	ON task_agent_links(task_id, agent_id)
	WHERE is_active = 1;

ALTER TABLE agents ADD COLUMN task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_agents_task_updated ON agents(task_id, updated_at DESC);
`,
};
