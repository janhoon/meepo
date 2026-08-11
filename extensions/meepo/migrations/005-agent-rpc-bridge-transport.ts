import type { Migration } from "./types.js";
import {
	quotedTransportKinds,
	quotedTransportStates,
} from "./quotes.js";

export const migration: Migration = {
	version: 5,
	name: "agent-rpc-bridge-transport",
	sql: `
ALTER TABLE agents ADD COLUMN transport_kind TEXT NOT NULL DEFAULT 'direct' CHECK (transport_kind IN (${quotedTransportKinds}));
ALTER TABLE agents ADD COLUMN transport_state TEXT NOT NULL DEFAULT 'legacy' CHECK (transport_state IN (${quotedTransportStates}));
ALTER TABLE agents ADD COLUMN bridge_socket_path TEXT NULL;
ALTER TABLE agents ADD COLUMN bridge_status_file TEXT NULL;
ALTER TABLE agents ADD COLUMN bridge_log_file TEXT NULL;
ALTER TABLE agents ADD COLUMN bridge_events_file TEXT NULL;
ALTER TABLE agents ADD COLUMN bridge_pid INTEGER NULL;
ALTER TABLE agents ADD COLUMN bridge_connected_at INTEGER NULL;
ALTER TABLE agents ADD COLUMN bridge_updated_at INTEGER NULL;
ALTER TABLE agents ADD COLUMN bridge_last_error TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_agents_transport_state_updated ON agents(transport_state, updated_at DESC);
`,
};
