import type { Migration } from "./types.js";
import {
	quotedAttentionItemAudiences,
	quotedAttentionItemKinds,
	quotedAttentionItemStates,
} from "./quotes.js";

export const migration: Migration = {
	version: 3,
	name: "attention-items",
	sql: `
CREATE TABLE IF NOT EXISTS attention_items (
	id TEXT PRIMARY KEY,
	message_id TEXT NULL UNIQUE REFERENCES agent_messages(id) ON DELETE SET NULL,
	agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	thread_id TEXT NOT NULL,
	project_key TEXT NOT NULL,
	spawn_session_id TEXT NULL,
	spawn_session_file TEXT NULL,
	audience TEXT NOT NULL CHECK (audience IN (${quotedAttentionItemAudiences})),
	kind TEXT NOT NULL CHECK (kind IN (${quotedAttentionItemKinds})),
	priority INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedAttentionItemStates})),
	summary TEXT NOT NULL,
	payload_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	resolved_at INTEGER NULL,
	resolution_kind TEXT NULL,
	resolution_summary TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_attention_items_project_state_priority
	ON attention_items(project_key, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_items_session_state_priority
	ON attention_items(spawn_session_id, spawn_session_file, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_items_agent_state_priority
	ON attention_items(agent_id, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_items_audience_state_priority
	ON attention_items(audience, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_attention_items_kind_state_created
	ON attention_items(kind, state, created_at DESC);
`,
};
