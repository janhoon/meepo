import { DatabaseSync } from "node:sqlite";
import { ensureTmuxAgentsRuntimePaths } from "./paths.js";
import { SERVICE_STATES } from "./service-types.js";
import { TASK_LINK_STATES, TASK_LINK_TYPES, TASK_STATES, TASK_WAITING_ON_VALUES } from "./task-types.js";
import {
	AGENT_ACCESS_GRANT_KINDS,
	AGENT_ACCESS_GRANT_STATES,
	AGENT_ATTENTION_V2_KINDS,
	AGENT_ATTENTION_V2_STATES,
	AGENT_EDGE_STATES,
	AGENT_EDGE_TYPES,
	AGENT_HIERARCHY_STATES,
	AGENT_MESSAGE_ACTOR_KINDS,
	AGENT_MESSAGE_RECIPIENT_DELIVERY_MODES,
	AGENT_MESSAGE_RECIPIENT_STATUSES,
	AGENT_MESSAGE_ROUTE_DECISIONS,
	AGENT_MESSAGE_ROUTE_KINDS,
	AGENT_MESSAGE_TRANSPORT_KINDS,
	AGENT_MESSAGE_V2_KINDS,
	AGENT_ORG_STATES,
	AGENT_RECIPIENT_KINDS,
	AGENT_ROLE_VISIBILITY_SCOPES,
	AGENT_STATES,
	AGENT_SYSTEM_ACTOR_KINDS,
	AGENT_THREAD_KINDS,
	AGENT_THREAD_STATES,
	AGENT_TRANSPORT_KINDS,
	AGENT_TRANSPORT_STATES,
	ATTENTION_ITEM_AUDIENCES,
	ATTENTION_ITEM_KINDS,
	ATTENTION_ITEM_STATES,
	DELIVERY_MODES,
	DOWNWARD_ACTION_POLICIES,
	MESSAGE_KINDS,
	MESSAGE_STATUSES,
	MESSAGE_TARGET_KINDS,
} from "./types.js";

interface Migration {
	version: number;
	name: string;
	sql: string;
}

const quotedStates = AGENT_STATES.map((value) => `'${value}'`).join(", ");
const quotedTransportKinds = AGENT_TRANSPORT_KINDS.map((value) => `'${value}'`).join(", ");
const quotedTransportStates = AGENT_TRANSPORT_STATES.map((value) => `'${value}'`).join(", ");
const quotedServiceStates = SERVICE_STATES.map((value) => `'${value}'`).join(", ");
const quotedTargetKinds = MESSAGE_TARGET_KINDS.map((value) => `'${value}'`).join(", ");
const quotedMessageKinds = MESSAGE_KINDS.map((value) => `'${value}'`).join(", ");
const quotedDeliveryModes = DELIVERY_MODES.map((value) => `'${value}'`).join(", ");
const quotedMessageStatuses = MESSAGE_STATUSES.map((value) => `'${value}'`).join(", ");
const quotedAttentionItemKinds = ATTENTION_ITEM_KINDS.map((value) => `'${value}'`).join(", ");
const quotedAttentionItemAudiences = ATTENTION_ITEM_AUDIENCES.map((value) => `'${value}'`).join(", ");
const quotedAttentionItemStates = ATTENTION_ITEM_STATES.map((value) => `'${value}'`).join(", ");
const quotedRoleVisibilityScopes = AGENT_ROLE_VISIBILITY_SCOPES.map((value) => `'${value}'`).join(", ");
const quotedOrgStates = AGENT_ORG_STATES.map((value) => `'${value}'`).join(", ");
const quotedHierarchyStates = AGENT_HIERARCHY_STATES.map((value) => `'${value}'`).join(", ");
const quotedEdgeTypes = AGENT_EDGE_TYPES.map((value) => `'${value}'`).join(", ");
const quotedEdgeStates = AGENT_EDGE_STATES.map((value) => `'${value}'`).join(", ");
const quotedSystemActorKinds = AGENT_SYSTEM_ACTOR_KINDS.map((value) => `'${value}'`).join(", ");
const quotedMessageActorKinds = AGENT_MESSAGE_ACTOR_KINDS.map((value) => `'${value}'`).join(", ");
const quotedRecipientKinds = AGENT_RECIPIENT_KINDS.map((value) => `'${value}'`).join(", ");
const quotedAccessGrantKinds = AGENT_ACCESS_GRANT_KINDS.map((value) => `'${value}'`).join(", ");
const quotedAccessGrantStates = AGENT_ACCESS_GRANT_STATES.map((value) => `'${value}'`).join(", ");
const quotedThreadKinds = AGENT_THREAD_KINDS.map((value) => `'${value}'`).join(", ");
const quotedThreadStates = AGENT_THREAD_STATES.map((value) => `'${value}'`).join(", ");
const quotedMessageV2Kinds = AGENT_MESSAGE_V2_KINDS.map((value) => `'${value}'`).join(", ");
const quotedMessageRecipientDeliveryModes = AGENT_MESSAGE_RECIPIENT_DELIVERY_MODES.map((value) => `'${value}'`).join(", ");
const quotedMessageRecipientStatuses = AGENT_MESSAGE_RECIPIENT_STATUSES.map((value) => `'${value}'`).join(", ");
const quotedMessageTransportKinds = AGENT_MESSAGE_TRANSPORT_KINDS.map((value) => `'${value}'`).join(", ");
const quotedRouteKinds = AGENT_MESSAGE_ROUTE_KINDS.map((value) => `'${value}'`).join(", ");
const quotedRouteDecisions = AGENT_MESSAGE_ROUTE_DECISIONS.map((value) => `'${value}'`).join(", ");
const quotedAttentionV2Kinds = AGENT_ATTENTION_V2_KINDS.map((value) => `'${value}'`).join(", ");
const quotedAttentionV2States = AGENT_ATTENTION_V2_STATES.map((value) => `'${value}'`).join(", ");
const quotedDownwardActionPolicies = DOWNWARD_ACTION_POLICIES.map((value) => `'${value}'`).join(", ");
const quotedTaskStates = TASK_STATES.map((value) => `'${value}'`).join(", ");
const quotedTaskWaitingOn = TASK_WAITING_ON_VALUES.map((value) => `'${value}'`).join(", ");
const quotedTaskLinkTypes = TASK_LINK_TYPES.map((value) => `'${value}'`).join(", ");
const quotedTaskLinkStates = TASK_LINK_STATES.map((value) => `'${value}'`).join(", ");

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
	{
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
	},
	{
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
	},
	{
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
	},
	{
		version: 6,
		name: "hierarchy-communication-foundation",
		sql: `
CREATE TABLE IF NOT EXISTS agent_roles (
	role_key TEXT PRIMARY KEY,
	label TEXT NOT NULL,
	authority_rank INTEGER NOT NULL,
	default_visibility_scope TEXT NOT NULL CHECK (default_visibility_scope IN (${quotedRoleVisibilityScopes})),
	can_spawn_children INTEGER NOT NULL DEFAULT 0,
	can_admin_override INTEGER NOT NULL DEFAULT 0,
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_roles_rank
	ON agent_roles(authority_rank ASC);

CREATE TABLE IF NOT EXISTS agent_role_edge_policies (
	id TEXT PRIMARY KEY,
	parent_role_key TEXT NOT NULL REFERENCES agent_roles(role_key) ON DELETE CASCADE,
	child_role_key TEXT NOT NULL REFERENCES agent_roles(role_key) ON DELETE CASCADE,
	edge_type TEXT NOT NULL CHECK (edge_type IN (${quotedEdgeTypes})),
	allow_spawn INTEGER NOT NULL DEFAULT 0,
	allow_parent_to_child_message INTEGER NOT NULL DEFAULT 1,
	allow_child_to_parent_message INTEGER NOT NULL DEFAULT 1,
	allow_parent_inspect_child INTEGER NOT NULL DEFAULT 1,
	allow_child_inspect_parent INTEGER NOT NULL DEFAULT 1,
	allow_parent_inspect_subtree INTEGER NOT NULL DEFAULT 0,
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	UNIQUE(parent_role_key, child_role_key, edge_type)
);

CREATE INDEX IF NOT EXISTS idx_agent_role_edge_policies_child
	ON agent_role_edge_policies(child_role_key, edge_type);
CREATE INDEX IF NOT EXISTS idx_agent_role_edge_policies_parent
	ON agent_role_edge_policies(parent_role_key, edge_type);

CREATE TABLE IF NOT EXISTS agent_orgs (
	id TEXT PRIMARY KEY,
	project_key TEXT NOT NULL,
	root_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	title TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedOrgStates})) DEFAULT 'active',
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	archived_at INTEGER NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_orgs_project_state_updated
	ON agent_orgs(project_key, state, updated_at DESC);

ALTER TABLE agents ADD COLUMN org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN role_key TEXT NULL REFERENCES agent_roles(role_key) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN spawned_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL;
ALTER TABLE agents ADD COLUMN hierarchy_state TEXT NOT NULL DEFAULT 'attached' CHECK (hierarchy_state IN (${quotedHierarchyStates}));

CREATE INDEX IF NOT EXISTS idx_agents_org_role_updated
	ON agents(org_id, role_key, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_hierarchy_state_updated
	ON agents(hierarchy_state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agents_spawned_by_updated
	ON agents(spawned_by_agent_id, updated_at DESC);

INSERT OR IGNORE INTO agent_events
	(id, agent_id, event_type, summary, payload_json, created_at)
SELECT
	'event:hierarchy-missing-parent-detached:' || agents.id,
	agents.id,
	'hierarchy_missing_parent_detached',
	'Detached during hierarchy migration because parent_agent_id does not reference an existing agent: ' || agents.parent_agent_id,
	'{"source":"migration_6","reason":"missing_parent_agent_id"}',
	unixepoch('now') * 1000
FROM agents
WHERE agents.parent_agent_id IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM agents parent WHERE parent.id = agents.parent_agent_id);

UPDATE agents
SET parent_agent_id = NULL,
	hierarchy_state = 'detached'
WHERE parent_agent_id IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM agents parent WHERE parent.id = agents.parent_agent_id);

INSERT OR IGNORE INTO agent_events
	(id, agent_id, event_type, summary, payload_json, created_at)
SELECT
	'event:hierarchy-self-parent-detached:' || agents.id,
	agents.id,
	'hierarchy_self_parent_detached',
	'Detached during hierarchy migration because parent_agent_id pointed at the same agent',
	'{"source":"migration_6","reason":"self_parent_agent_id"}',
	unixepoch('now') * 1000
FROM agents
WHERE agents.parent_agent_id = agents.id;

UPDATE agents
SET hierarchy_state = 'detached'
WHERE parent_agent_id = id;

WITH RECURSIVE parent_walk(start_agent_id, current_agent_id, parent_agent_id, path) AS (
	SELECT
		child.id,
		child.id,
		child.parent_agent_id,
		'|' || child.id || '|'
	FROM agents child
	WHERE child.parent_agent_id IS NOT NULL
		AND child.parent_agent_id <> child.id
		AND child.hierarchy_state = 'attached'
		AND EXISTS (SELECT 1 FROM agents parent WHERE parent.id = child.parent_agent_id)
	UNION ALL
	SELECT
		parent_walk.start_agent_id,
		parent.id,
		parent.parent_agent_id,
		parent_walk.path || parent.id || '|'
	FROM parent_walk
	JOIN agents parent ON parent.id = parent_walk.parent_agent_id
	WHERE parent_walk.parent_agent_id IS NOT NULL
		AND instr(parent_walk.path, '|' || parent.id || '|') = 0
), cycle_affected_agents AS (
	SELECT DISTINCT parent_walk.start_agent_id AS agent_id
	FROM parent_walk
	JOIN agents next_parent ON next_parent.id = parent_walk.parent_agent_id
	WHERE parent_walk.parent_agent_id IS NOT NULL
		AND instr(parent_walk.path, '|' || next_parent.id || '|') > 0
)
INSERT OR IGNORE INTO agent_events
	(id, agent_id, event_type, summary, payload_json, created_at)
SELECT
	'event:hierarchy-cycle-detached:' || cycle_affected_agents.agent_id,
	cycle_affected_agents.agent_id,
	'hierarchy_cycle_detached',
	'Detached during hierarchy migration because the parent_agent_id chain contains a cycle',
	'{"source":"migration_6","reason":"cyclic_parent_agent_id"}',
	unixepoch('now') * 1000
FROM cycle_affected_agents;

WITH RECURSIVE parent_walk(start_agent_id, current_agent_id, parent_agent_id, path) AS (
	SELECT
		child.id,
		child.id,
		child.parent_agent_id,
		'|' || child.id || '|'
	FROM agents child
	WHERE child.parent_agent_id IS NOT NULL
		AND child.parent_agent_id <> child.id
		AND child.hierarchy_state = 'attached'
		AND EXISTS (SELECT 1 FROM agents parent WHERE parent.id = child.parent_agent_id)
	UNION ALL
	SELECT
		parent_walk.start_agent_id,
		parent.id,
		parent.parent_agent_id,
		parent_walk.path || parent.id || '|'
	FROM parent_walk
	JOIN agents parent ON parent.id = parent_walk.parent_agent_id
	WHERE parent_walk.parent_agent_id IS NOT NULL
		AND instr(parent_walk.path, '|' || parent.id || '|') = 0
), cycle_affected_agents AS (
	SELECT DISTINCT parent_walk.start_agent_id AS agent_id
	FROM parent_walk
	JOIN agents next_parent ON next_parent.id = parent_walk.parent_agent_id
	WHERE parent_walk.parent_agent_id IS NOT NULL
		AND instr(parent_walk.path, '|' || next_parent.id || '|') > 0
)
UPDATE agents
SET hierarchy_state = 'detached'
WHERE id IN (SELECT agent_id FROM cycle_affected_agents);

WITH RECURSIVE detached_descendants(agent_id, path) AS (
	SELECT
		child.id,
		'|' || child.id || '|'
	FROM agents child
	JOIN agents parent ON parent.id = child.parent_agent_id
	WHERE child.hierarchy_state = 'attached'
		AND parent.hierarchy_state = 'detached'
	UNION ALL
	SELECT
		child.id,
		detached_descendants.path || child.id || '|'
	FROM agents child
	JOIN detached_descendants ON child.parent_agent_id = detached_descendants.agent_id
	WHERE child.hierarchy_state = 'attached'
		AND instr(detached_descendants.path, '|' || child.id || '|') = 0
)
INSERT OR IGNORE INTO agent_events
	(id, agent_id, event_type, summary, payload_json, created_at)
SELECT
	'event:hierarchy-detached-parent-detached:' || detached_descendants.agent_id,
	detached_descendants.agent_id,
	'hierarchy_detached_parent_detached',
	'Detached during hierarchy migration because the parent_agent_id chain depends on a detached agent',
	'{"source":"migration_6","reason":"detached_parent_agent_id"}',
	unixepoch('now') * 1000
FROM detached_descendants;

WITH RECURSIVE detached_descendants(agent_id, path) AS (
	SELECT
		child.id,
		'|' || child.id || '|'
	FROM agents child
	JOIN agents parent ON parent.id = child.parent_agent_id
	WHERE child.hierarchy_state = 'attached'
		AND parent.hierarchy_state = 'detached'
	UNION ALL
	SELECT
		child.id,
		detached_descendants.path || child.id || '|'
	FROM agents child
	JOIN detached_descendants ON child.parent_agent_id = detached_descendants.agent_id
	WHERE child.hierarchy_state = 'attached'
		AND instr(detached_descendants.path, '|' || child.id || '|') = 0
)
UPDATE agents
SET hierarchy_state = 'detached'
WHERE id IN (SELECT agent_id FROM detached_descendants);

CREATE TABLE IF NOT EXISTS agent_edges (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
	parent_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	child_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	edge_type TEXT NOT NULL CHECK (edge_type IN (${quotedEdgeTypes})),
	role_policy_id TEXT NULL REFERENCES agent_role_edge_policies(id) ON DELETE SET NULL,
	task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedEdgeStates})) DEFAULT 'active',
	created_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	created_by_kind TEXT NOT NULL CHECK (created_by_kind IN (${quotedSystemActorKinds})),
	reason TEXT NULL,
	metadata_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	ended_at INTEGER NULL,
	CHECK (parent_agent_id <> child_agent_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_edges_active_reports_child
	ON agent_edges(child_agent_id, edge_type)
	WHERE state = 'active' AND edge_type = 'reports_to';
CREATE INDEX IF NOT EXISTS idx_agent_edges_parent_active
	ON agent_edges(parent_agent_id, state, edge_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_edges_child_active
	ON agent_edges(child_agent_id, state, edge_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_edges_org_active
	ON agent_edges(org_id, state, edge_type, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_edges_policy_active
	ON agent_edges(role_policy_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_hierarchy_closure (
	org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
	ancestor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	descendant_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	depth INTEGER NOT NULL,
	through_edge_id TEXT NULL REFERENCES agent_edges(id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (org_id, ancestor_agent_id, descendant_agent_id),
	CHECK (depth >= 0)
);

CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_descendant_depth
	ON agent_hierarchy_closure(descendant_agent_id, depth ASC);
CREATE INDEX IF NOT EXISTS idx_agent_hierarchy_ancestor_depth
	ON agent_hierarchy_closure(ancestor_agent_id, depth ASC);

CREATE TABLE IF NOT EXISTS agent_access_grants (
	id TEXT PRIMARY KEY,
	org_id TEXT NOT NULL REFERENCES agent_orgs(id) ON DELETE CASCADE,
	grantee_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
	subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE CASCADE,
	subject_task_id TEXT NULL REFERENCES tasks(id) ON DELETE CASCADE,
	grant_kind TEXT NOT NULL CHECK (grant_kind IN (${quotedAccessGrantKinds})),
	granted_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	granted_by_kind TEXT NOT NULL CHECK (granted_by_kind IN (${quotedSystemActorKinds})),
	reason TEXT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedAccessGrantStates})) DEFAULT 'active',
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	expires_at INTEGER NULL,
	revoked_at INTEGER NULL,
	CHECK (subject_agent_id IS NOT NULL OR subject_task_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_access_grants_grantee_active
	ON agent_access_grants(grantee_agent_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_access_grants_subject_agent_active
	ON agent_access_grants(subject_agent_id, state, expires_at);
CREATE INDEX IF NOT EXISTS idx_agent_access_grants_subject_task_active
	ON agent_access_grants(subject_task_id, state, expires_at);

CREATE TABLE IF NOT EXISTS agent_threads (
	id TEXT PRIMARY KEY,
	org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
	project_key TEXT NOT NULL,
	task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
	subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	parent_thread_id TEXT NULL REFERENCES agent_threads(id) ON DELETE SET NULL,
	kind TEXT NOT NULL CHECK (kind IN (${quotedThreadKinds})),
	title TEXT NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedThreadStates})) DEFAULT 'open',
	created_by_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	created_by_kind TEXT NOT NULL CHECK (created_by_kind IN (${quotedMessageActorKinds})),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	resolved_at INTEGER NULL,
	metadata_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_threads_org_state_updated
	ON agent_threads(org_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_threads_task_state_updated
	ON agent_threads(task_id, state, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_threads_subject_state_updated
	ON agent_threads(subject_agent_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages_v2 (
	id TEXT PRIMARY KEY,
	thread_id TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
	org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
	project_key TEXT NOT NULL,
	sender_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	sender_kind TEXT NOT NULL CHECK (sender_kind IN (${quotedMessageActorKinds})),
	kind TEXT NOT NULL CHECK (kind IN (${quotedMessageV2Kinds})),
	summary TEXT NOT NULL,
	body_markdown TEXT NULL,
	payload_json TEXT NULL,
	action_policy TEXT NULL CHECK (action_policy IN (${quotedDownwardActionPolicies})),
	priority INTEGER NOT NULL DEFAULT 3,
	requires_response INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL,
	supersedes_message_id TEXT NULL REFERENCES agent_messages_v2(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_thread_created
	ON agent_messages_v2(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_sender_created
	ON agent_messages_v2(sender_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_project_created
	ON agent_messages_v2(project_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_messages_v2_kind_priority_created
	ON agent_messages_v2(kind, priority ASC, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_message_recipients (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES agent_messages_v2(id) ON DELETE CASCADE,
	recipient_agent_id TEXT NULL REFERENCES agents(id) ON DELETE CASCADE,
	recipient_kind TEXT NOT NULL CHECK (recipient_kind IN (${quotedRecipientKinds})),
	delivery_mode TEXT NOT NULL CHECK (delivery_mode IN (${quotedMessageRecipientDeliveryModes})),
	status TEXT NOT NULL CHECK (status IN (${quotedMessageRecipientStatuses})) DEFAULT 'queued',
	transport_kind TEXT NULL CHECK (transport_kind IN (${quotedMessageTransportKinds})),
	route_id TEXT NULL,
	queued_at INTEGER NOT NULL,
	notified_at INTEGER NULL,
	read_at INTEGER NULL,
	acked_at INTEGER NULL,
	failed_at INTEGER NULL,
	expired_at INTEGER NULL,
	failure_summary TEXT NULL,
	metadata_json TEXT NULL,
	CHECK (recipient_kind <> 'agent' OR recipient_agent_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_recipients_unique
	ON agent_message_recipients(message_id, recipient_kind, COALESCE(recipient_agent_id, ''));
CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_agent_unread
	ON agent_message_recipients(recipient_agent_id, status, queued_at ASC)
	WHERE recipient_kind = 'agent' AND status IN ('queued', 'notified');
CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_root_unread
	ON agent_message_recipients(recipient_kind, status, queued_at ASC)
	WHERE recipient_kind = 'root' AND status IN ('queued', 'notified');
CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_message_status
	ON agent_message_recipients(message_id, status, queued_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_message_recipients_route
	ON agent_message_recipients(route_id);

CREATE TABLE IF NOT EXISTS agent_message_routes (
	id TEXT PRIMARY KEY,
	message_id TEXT NOT NULL REFERENCES agent_messages_v2(id) ON DELETE CASCADE,
	org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
	from_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	to_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	from_kind TEXT NOT NULL CHECK (from_kind IN (${quotedMessageActorKinds})),
	to_kind TEXT NOT NULL CHECK (to_kind IN (${quotedRecipientKinds})),
	route_kind TEXT NOT NULL CHECK (route_kind IN (${quotedRouteKinds})),
	edge_id TEXT NULL REFERENCES agent_edges(id) ON DELETE SET NULL,
	policy_id TEXT NULL REFERENCES agent_role_edge_policies(id) ON DELETE SET NULL,
	grant_id TEXT NULL REFERENCES agent_access_grants(id) ON DELETE SET NULL,
	decision TEXT NOT NULL CHECK (decision IN (${quotedRouteDecisions})),
	decision_reason TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_message_routes_message
	ON agent_message_routes(message_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_agent_message_routes_to_created
	ON agent_message_routes(to_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_message_routes_from_created
	ON agent_message_routes(from_agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_message_routes_decision_created
	ON agent_message_routes(decision, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_attention_items_v2 (
	id TEXT PRIMARY KEY,
	message_id TEXT NULL REFERENCES agent_messages_v2(id) ON DELETE SET NULL,
	recipient_row_id TEXT NULL REFERENCES agent_message_recipients(id) ON DELETE SET NULL,
	org_id TEXT NULL REFERENCES agent_orgs(id) ON DELETE SET NULL,
	project_key TEXT NOT NULL,
	task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
	subject_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	owner_agent_id TEXT NULL REFERENCES agents(id) ON DELETE SET NULL,
	owner_kind TEXT NOT NULL CHECK (owner_kind IN (${quotedRecipientKinds})),
	kind TEXT NOT NULL CHECK (kind IN (${quotedAttentionV2Kinds})),
	priority INTEGER NOT NULL,
	state TEXT NOT NULL CHECK (state IN (${quotedAttentionV2States})),
	summary TEXT NOT NULL,
	payload_json TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	resolved_at INTEGER NULL,
	resolution_kind TEXT NULL,
	resolution_summary TEXT NULL,
	CHECK (owner_kind <> 'agent' OR owner_agent_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_agent_attention_owner_state_priority
	ON agent_attention_items_v2(owner_kind, owner_agent_id, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_attention_subject_state_priority
	ON agent_attention_items_v2(subject_agent_id, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_attention_task_state_priority
	ON agent_attention_items_v2(task_id, state, priority ASC, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_attention_message_updated
	ON agent_attention_items_v2(message_id, updated_at DESC);

INSERT OR IGNORE INTO agent_roles
	(role_key, label, authority_rank, default_visibility_scope, can_spawn_children, can_admin_override, metadata_json, created_at, updated_at)
VALUES
	('root', 'Root coordinator', 0, 'root', 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('ceo', 'CEO', 10, 'subtree', 1, 0, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('cto', 'CTO', 20, 'subtree', 1, 0, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('engineer', 'Engineer', 30, 'self_parent', 0, 0, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('reviewer', 'Reviewer', 30, 'self_parent', 0, 0, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('qa-lead', 'QA lead', 30, 'self_parent', 0, 0, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000);

INSERT OR IGNORE INTO agent_roles
	(role_key, label, authority_rank, default_visibility_scope, can_spawn_children, can_admin_override, metadata_json, created_at, updated_at)
SELECT DISTINCT
	TRIM(profile),
	TRIM(profile),
	CASE TRIM(profile)
		WHEN 'root' THEN 0
		WHEN 'ceo' THEN 10
		WHEN 'cto' THEN 20
		ELSE 30
	END,
	CASE TRIM(profile)
		WHEN 'root' THEN 'root'
		WHEN 'ceo' THEN 'subtree'
		WHEN 'cto' THEN 'subtree'
		ELSE 'self_parent'
	END,
	CASE WHEN TRIM(profile) IN ('root', 'ceo', 'cto') THEN 1 ELSE 0 END,
	CASE WHEN TRIM(profile) = 'root' THEN 1 ELSE 0 END,
	'{"source":"agents.profile"}',
	unixepoch('now') * 1000,
	unixepoch('now') * 1000
FROM agents
WHERE TRIM(profile) <> '';

INSERT OR IGNORE INTO agent_role_edge_policies
	(id, parent_role_key, child_role_key, edge_type, allow_spawn, allow_parent_to_child_message, allow_child_to_parent_message, allow_parent_inspect_child, allow_child_inspect_parent, allow_parent_inspect_subtree, metadata_json, created_at, updated_at)
VALUES
	('role-edge:root:ceo:reports_to', 'root', 'ceo', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:ceo:cto:reports_to', 'ceo', 'cto', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:cto:engineer:reports_to', 'cto', 'engineer', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:cto:reviewer:reports_to', 'cto', 'reviewer', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:cto:qa-lead:reports_to', 'cto', 'qa-lead', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_6_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000);

INSERT OR IGNORE INTO agent_orgs
	(id, project_key, root_agent_id, title, state, metadata_json, created_at, updated_at, archived_at)
SELECT
	'org:backfill:' || project_key || ':session:' || COALESCE(spawn_session_id, '') || ':file:' || COALESCE(spawn_session_file, ''),
	project_key,
	NULL,
	CASE
		WHEN COALESCE(spawn_session_id, '') <> '' THEN 'Backfilled org for ' || project_key || ' session ' || spawn_session_id
		ELSE 'Backfilled org for ' || project_key
	END,
	'active',
	'{"source":"agents.project_session"}',
	MIN(created_at),
	MAX(updated_at),
	NULL
FROM agents
GROUP BY project_key, COALESCE(spawn_session_id, ''), COALESCE(spawn_session_file, '');

UPDATE agents
SET org_id = 'org:backfill:' || project_key || ':session:' || COALESCE(spawn_session_id, '') || ':file:' || COALESCE(spawn_session_file, '')
WHERE org_id IS NULL;

WITH RECURSIVE inherited_orgs(agent_id, inherited_org_id, depth, path) AS (
	SELECT
		a.id,
		a.org_id,
		0,
		'|' || a.id || '|'
	FROM agents a
	WHERE a.org_id IS NOT NULL
		AND (
			a.parent_agent_id IS NULL
			OR NOT EXISTS (SELECT 1 FROM agents parent WHERE parent.id = a.parent_agent_id)
		)
	UNION ALL
	SELECT
		child.id,
		inherited_orgs.inherited_org_id,
		inherited_orgs.depth + 1,
		inherited_orgs.path || child.id || '|'
	FROM agents child
	JOIN inherited_orgs ON child.parent_agent_id = inherited_orgs.agent_id
	WHERE instr(inherited_orgs.path, '|' || child.id || '|') = 0
)
UPDATE agents
SET org_id = (
	SELECT inherited_org_id
	FROM inherited_orgs
	WHERE inherited_orgs.agent_id = agents.id
	ORDER BY depth DESC
	LIMIT 1
)
WHERE id IN (SELECT agent_id FROM inherited_orgs)
	AND org_id IS NOT (
		SELECT inherited_org_id
		FROM inherited_orgs
		WHERE inherited_orgs.agent_id = agents.id
		ORDER BY depth DESC
		LIMIT 1
	);

UPDATE agents
SET role_key = CASE
	WHEN TRIM(profile) = 'principal-engineer' THEN 'reviewer'
	ELSE TRIM(profile)
END
WHERE role_key IS NULL
	AND EXISTS (
		SELECT 1
		FROM agent_roles
		WHERE agent_roles.role_key = CASE
			WHEN TRIM(agents.profile) = 'principal-engineer' THEN 'reviewer'
			ELSE TRIM(agents.profile)
		END
	);

UPDATE agents
SET spawned_by_agent_id = parent_agent_id
WHERE spawned_by_agent_id IS NULL
	AND parent_agent_id IS NOT NULL
	AND EXISTS (SELECT 1 FROM agents parent WHERE parent.id = agents.parent_agent_id);

UPDATE agent_orgs
SET root_agent_id = (
		SELECT a.id
		FROM agents a
		WHERE a.org_id = agent_orgs.id
			AND a.hierarchy_state = 'attached'
		ORDER BY
			CASE
				WHEN a.parent_agent_id IS NULL THEN 0
				WHEN NOT EXISTS (SELECT 1 FROM agents parent WHERE parent.id = a.parent_agent_id AND parent.org_id = a.org_id) THEN 0
				ELSE 1
			END,
			a.created_at ASC,
			a.id ASC
		LIMIT 1
	),
	updated_at = unixepoch('now') * 1000
WHERE EXISTS (
		SELECT 1
		FROM agents a
		WHERE a.org_id = agent_orgs.id
			AND a.hierarchy_state = 'attached'
	)
	AND root_agent_id IS NULL;

INSERT OR IGNORE INTO agent_edges
	(id, org_id, parent_agent_id, child_agent_id, edge_type, role_policy_id, task_id, state, created_by_agent_id, created_by_kind, reason, metadata_json, created_at, updated_at, ended_at)
SELECT
	'edge:reports_to:' || parent.id || ':' || child.id,
	child.org_id,
	parent.id,
	child.id,
	'reports_to',
	policy.id,
	CASE WHEN child.task_id IS NOT NULL AND EXISTS (SELECT 1 FROM tasks WHERE tasks.id = child.task_id) THEN child.task_id ELSE NULL END,
	'active',
	NULL,
	'system',
	'Backfilled from agents.parent_agent_id',
	'{"source":"agents.parent_agent_id"}',
	child.created_at,
	child.updated_at,
	NULL
FROM agents child
JOIN agents parent ON parent.id = child.parent_agent_id
LEFT JOIN agent_role_edge_policies policy
	ON policy.parent_role_key = parent.role_key
	AND policy.child_role_key = child.role_key
	AND policy.edge_type = 'reports_to'
WHERE child.org_id IS NOT NULL
	AND child.hierarchy_state = 'attached'
	AND parent.hierarchy_state = 'attached'
	AND child.parent_agent_id IS NOT NULL
	AND child.parent_agent_id <> child.id
	AND parent.org_id = child.org_id;

INSERT OR IGNORE INTO agent_hierarchy_closure
	(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
SELECT
	agents.org_id,
	agents.id,
	agents.id,
	0,
	NULL,
	unixepoch('now') * 1000
FROM agents
WHERE agents.org_id IS NOT NULL;

WITH RECURSIVE hierarchy_paths(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, path) AS (
	SELECT
		edges.org_id,
		edges.parent_agent_id,
		edges.child_agent_id,
		1,
		edges.id,
		'|' || edges.parent_agent_id || '|' || edges.child_agent_id || '|'
	FROM agent_edges edges
	WHERE edges.state = 'active'
		AND edges.edge_type = 'reports_to'
	UNION ALL
	SELECT
		hierarchy_paths.org_id,
		hierarchy_paths.ancestor_agent_id,
		edges.child_agent_id,
		hierarchy_paths.depth + 1,
		edges.id,
		hierarchy_paths.path || edges.child_agent_id || '|'
	FROM hierarchy_paths
	JOIN agent_edges edges
		ON edges.org_id = hierarchy_paths.org_id
		AND edges.parent_agent_id = hierarchy_paths.descendant_agent_id
	WHERE edges.state = 'active'
		AND edges.edge_type = 'reports_to'
		AND instr(hierarchy_paths.path, '|' || edges.child_agent_id || '|') = 0
)
INSERT OR IGNORE INTO agent_hierarchy_closure
	(org_id, ancestor_agent_id, descendant_agent_id, depth, through_edge_id, created_at)
SELECT
	org_id,
	ancestor_agent_id,
	descendant_agent_id,
	MIN(depth),
	MIN(through_edge_id),
	unixepoch('now') * 1000
FROM hierarchy_paths
GROUP BY org_id, ancestor_agent_id, descendant_agent_id;
`,
	},
	{
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
	},
	{
		version: 8,
		name: "coo-orchestration-role-policies",
		sql: `
INSERT OR IGNORE INTO agent_roles
	(role_key, label, authority_rank, default_visibility_scope, can_spawn_children, can_admin_override, metadata_json, created_at, updated_at)
VALUES
	('coo', 'COO', 15, 'subtree', 1, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('planner', 'Planner', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('scout', 'Scout', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('worker', 'Worker', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('design-lead', 'Design lead', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('cso', 'CSO', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('coordinator-helper', 'Coordinator helper', 30, 'self_parent', 0, 0, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000);

UPDATE agent_roles
SET can_spawn_children = 1,
	default_visibility_scope = 'subtree',
	updated_at = unixepoch('now') * 1000
WHERE role_key = 'coo';

INSERT OR IGNORE INTO agent_role_edge_policies
	(id, parent_role_key, child_role_key, edge_type, allow_spawn, allow_parent_to_child_message, allow_child_to_parent_message, allow_parent_inspect_child, allow_child_inspect_parent, allow_parent_inspect_subtree, metadata_json, created_at, updated_at)
VALUES
	('role-edge:root:coo:reports_to', 'root', 'coo', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:ceo:reports_to', 'coo', 'ceo', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:cto:reports_to', 'coo', 'cto', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:engineer:reports_to', 'coo', 'engineer', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:reviewer:reports_to', 'coo', 'reviewer', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:qa-lead:reports_to', 'coo', 'qa-lead', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:planner:reports_to', 'coo', 'planner', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:scout:reports_to', 'coo', 'scout', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:worker:reports_to', 'coo', 'worker', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:design-lead:reports_to', 'coo', 'design-lead', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:cso:reports_to', 'coo', 'cso', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000),
	('role-edge:coo:coordinator-helper:reports_to', 'coo', 'coordinator-helper', 'reports_to', 1, 1, 1, 1, 1, 1, '{"source":"migration_8_seed"}', unixepoch('now') * 1000, unixepoch('now') * 1000);

UPDATE agents
SET role_key = CASE
	WHEN TRIM(profile) = 'principal-engineer' THEN 'reviewer'
	ELSE TRIM(profile)
END,
	updated_at = unixepoch('now') * 1000
WHERE role_key IS NULL
	AND EXISTS (
		SELECT 1
		FROM agent_roles
		WHERE agent_roles.role_key = CASE
			WHEN TRIM(agents.profile) = 'principal-engineer' THEN 'reviewer'
			ELSE TRIM(agents.profile)
		END
	);
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
