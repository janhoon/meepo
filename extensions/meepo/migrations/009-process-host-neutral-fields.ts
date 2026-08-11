import type { Migration } from "./types.js";

export const migration: Migration = {
	version: 9,
	name: "process-host-neutral-fields",
	sql: `
ALTER TABLE agents ADD COLUMN host_kind TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE agents ADD COLUMN host_primary_id TEXT NULL;
ALTER TABLE agents ADD COLUMN host_display_name TEXT NULL;
ALTER TABLE agents ADD COLUMN host_target_json TEXT NULL;

ALTER TABLE tmux_services ADD COLUMN host_kind TEXT NOT NULL DEFAULT 'tmux';
ALTER TABLE tmux_services ADD COLUMN host_primary_id TEXT NULL;
ALTER TABLE tmux_services ADD COLUMN host_display_name TEXT NULL;
ALTER TABLE tmux_services ADD COLUMN host_target_json TEXT NULL;

-- Backfill primary id from legacy pane/window when present.
UPDATE agents
SET host_primary_id = COALESCE(tmux_pane_id, tmux_window_id, tmux_session_id),
	host_target_json = json_object(
		'sessionId', tmux_session_id,
		'sessionName', tmux_session_name,
		'windowId', tmux_window_id,
		'paneId', tmux_pane_id
	)
WHERE host_primary_id IS NULL
	AND (tmux_pane_id IS NOT NULL OR tmux_window_id IS NOT NULL OR tmux_session_id IS NOT NULL);

UPDATE tmux_services
SET host_primary_id = COALESCE(tmux_pane_id, tmux_window_id, tmux_session_id),
	host_target_json = json_object(
		'sessionId', tmux_session_id,
		'sessionName', tmux_session_name,
		'windowId', tmux_window_id,
		'paneId', tmux_pane_id
	)
WHERE host_primary_id IS NULL
	AND (tmux_pane_id IS NOT NULL OR tmux_window_id IS NOT NULL OR tmux_session_id IS NOT NULL);
`,
};
