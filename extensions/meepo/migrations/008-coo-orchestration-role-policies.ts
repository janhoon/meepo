import type { Migration } from "./types.js";

export const migration: Migration = {
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
};
