import type { Migration } from "./types.js";
import {
	quotedTaskLinkStates,
	quotedTaskLinkTypes,
} from "./quotes.js";

export const migration: Migration = {
	version: 7,
	name: "task-dependency-links",
	sql: `
ALTER TABLE tasks ADD COLUMN recommended_profile TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_recommended_profile_status
	ON tasks(recommended_profile, status, priority ASC, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_links (
	id TEXT PRIMARY KEY,
	source_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	target_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	link_type TEXT NOT NULL CHECK (link_type IN (${quotedTaskLinkTypes})),
	state TEXT NOT NULL CHECK (state IN (${quotedTaskLinkStates})) DEFAULT 'active',
	summary TEXT NULL,
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	resolved_at INTEGER NULL,
	CHECK (source_task_id <> target_task_id)
);

CREATE INDEX IF NOT EXISTS idx_task_links_source_state_type
	ON task_links(source_task_id, state, link_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_links_target_state_type
	ON task_links(target_task_id, state, link_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_links_type_state_updated
	ON task_links(link_type, state, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_links_active_unique
	ON task_links(source_task_id, target_task_id, link_type)
	WHERE state = 'active';
`,
};
