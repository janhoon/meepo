import type { Migration } from "./types.js";

export const migration: Migration = {
	version: 10,
	name: "host-target-token-backfill",
	sql: `
-- Fill remaining host_* from leftover tmux_* so TypeScript can stop reading tmux columns.
UPDATE agents
SET host_kind = COALESCE(NULLIF(host_kind, ''), 'tmux'),
	host_primary_id = COALESCE(host_primary_id, tmux_pane_id, tmux_window_id, tmux_session_id),
	host_display_name = COALESCE(host_display_name, tmux_session_name),
	host_target_json = COALESCE(
		NULLIF(host_target_json, ''),
		json_object(
			'sessionId', tmux_session_id,
			'sessionName', tmux_session_name,
			'windowId', tmux_window_id,
			'paneId', tmux_pane_id
		)
	)
WHERE host_primary_id IS NULL
	AND (tmux_pane_id IS NOT NULL OR tmux_window_id IS NOT NULL OR tmux_session_id IS NOT NULL);

UPDATE tmux_services
SET host_kind = COALESCE(NULLIF(host_kind, ''), 'tmux'),
	host_primary_id = COALESCE(host_primary_id, tmux_pane_id, tmux_window_id, tmux_session_id),
	host_display_name = COALESCE(host_display_name, tmux_session_name),
	host_target_json = COALESCE(
		NULLIF(host_target_json, ''),
		json_object(
			'sessionId', tmux_session_id,
			'sessionName', tmux_session_name,
			'windowId', tmux_window_id,
			'paneId', tmux_pane_id
		)
	)
WHERE host_primary_id IS NULL
	AND (tmux_pane_id IS NOT NULL OR tmux_window_id IS NOT NULL OR tmux_session_id IS NOT NULL);
`,
};
