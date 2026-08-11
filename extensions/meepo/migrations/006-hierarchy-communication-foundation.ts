import type { Migration } from "./types.js";
import {
	quotedAccessGrantKinds,
	quotedAccessGrantStates,
	quotedAttentionV2Kinds,
	quotedAttentionV2States,
	quotedDownwardActionPolicies,
	quotedEdgeStates,
	quotedEdgeTypes,
	quotedHierarchyStates,
	quotedMessageActorKinds,
	quotedMessageRecipientDeliveryModes,
	quotedMessageRecipientStatuses,
	quotedMessageTransportKinds,
	quotedMessageV2Kinds,
	quotedOrgStates,
	quotedRecipientKinds,
	quotedRoleVisibilityScopes,
	quotedRouteDecisions,
	quotedRouteKinds,
	quotedSystemActorKinds,
	quotedThreadKinds,
	quotedThreadStates,
} from "./quotes.js";

export const migration: Migration = {
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

-- Historical migration_6 opinion seeds (INSERT OR IGNORE). Forward path is full-org-preset seeder
-- via MeepoRuntime (org-preset.ts). Kept for non-destructive upgrades of existing DBs.
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

-- Historical migration_6 edge seeds. Prefer full-org-preset seeder for new installs going forward.
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
};
