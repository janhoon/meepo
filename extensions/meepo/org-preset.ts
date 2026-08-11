import type { DatabaseSync } from "node:sqlite";
import type { MeepoConfig } from "./config.js";

export interface OrgRoleSeed {
	roleKey: string;
	label: string;
	authorityRank: number;
	defaultVisibilityScope: "root" | "subtree" | "self_parent" | "project" | "direct_children";
	canSpawnChildren: boolean;
	canAdminOverride: boolean;
}

export interface OrgEdgeSeed {
	id: string;
	parentRoleKey: string;
	childRoleKey: string;
	edgeType: "reports_to";
	allowSpawn: boolean;
	allowParentToChildMessage: boolean;
	allowChildToParentMessage: boolean;
	allowParentInspectChild: boolean;
	allowChildInspectParent: boolean;
	allowParentInspectSubtree: boolean;
}

/** Opinionated full-meepo org chart (was migration_6_seed). Preset-owned going forward. */
export const FULL_ORG_ROLE_SEEDS: OrgRoleSeed[] = [
	{
		roleKey: "root",
		label: "Root coordinator",
		authorityRank: 0,
		defaultVisibilityScope: "root",
		canSpawnChildren: true,
		canAdminOverride: true,
	},
	{
		roleKey: "ceo",
		label: "CEO",
		authorityRank: 10,
		defaultVisibilityScope: "subtree",
		canSpawnChildren: true,
		canAdminOverride: false,
	},
	{
		roleKey: "cto",
		label: "CTO",
		authorityRank: 20,
		defaultVisibilityScope: "subtree",
		canSpawnChildren: true,
		canAdminOverride: false,
	},
	{
		roleKey: "engineer",
		label: "Engineer",
		authorityRank: 30,
		defaultVisibilityScope: "self_parent",
		canSpawnChildren: false,
		canAdminOverride: false,
	},
	{
		roleKey: "reviewer",
		label: "Reviewer",
		authorityRank: 30,
		defaultVisibilityScope: "self_parent",
		canSpawnChildren: false,
		canAdminOverride: false,
	},
	{
		roleKey: "qa-lead",
		label: "QA lead",
		authorityRank: 30,
		defaultVisibilityScope: "self_parent",
		canSpawnChildren: false,
		canAdminOverride: false,
	},
];

export const FULL_ORG_EDGE_SEEDS: OrgEdgeSeed[] = [
	{
		id: "role-edge:root:ceo:reports_to",
		parentRoleKey: "root",
		childRoleKey: "ceo",
		edgeType: "reports_to",
		allowSpawn: true,
		allowParentToChildMessage: true,
		allowChildToParentMessage: true,
		allowParentInspectChild: true,
		allowChildInspectParent: true,
		allowParentInspectSubtree: true,
	},
	{
		id: "role-edge:ceo:cto:reports_to",
		parentRoleKey: "ceo",
		childRoleKey: "cto",
		edgeType: "reports_to",
		allowSpawn: true,
		allowParentToChildMessage: true,
		allowChildToParentMessage: true,
		allowParentInspectChild: true,
		allowChildInspectParent: true,
		allowParentInspectSubtree: true,
	},
	{
		id: "role-edge:cto:engineer:reports_to",
		parentRoleKey: "cto",
		childRoleKey: "engineer",
		edgeType: "reports_to",
		allowSpawn: true,
		allowParentToChildMessage: true,
		allowChildToParentMessage: true,
		allowParentInspectChild: true,
		allowChildInspectParent: true,
		allowParentInspectSubtree: true,
	},
	{
		id: "role-edge:cto:reviewer:reports_to",
		parentRoleKey: "cto",
		childRoleKey: "reviewer",
		edgeType: "reports_to",
		allowSpawn: true,
		allowParentToChildMessage: true,
		allowChildToParentMessage: true,
		allowParentInspectChild: true,
		allowChildInspectParent: true,
		allowParentInspectSubtree: true,
	},
	{
		id: "role-edge:cto:qa-lead:reports_to",
		parentRoleKey: "cto",
		childRoleKey: "qa-lead",
		edgeType: "reports_to",
		allowSpawn: true,
		allowParentToChildMessage: true,
		allowChildToParentMessage: true,
		allowParentInspectChild: true,
		allowChildInspectParent: true,
		allowParentInspectSubtree: true,
	},
];

export interface OrgSeedApplyResult {
	rolesInsertedOrPresent: number;
	edgesInsertedOrPresent: number;
	source: "full-org-preset";
}

/**
 * Idempotently ensure full-org role/edge seeds exist.
 * Safe on existing DBs that already received migration_6_seed rows (INSERT OR IGNORE).
 */
export function applyFullOrgPresetSeeds(db: DatabaseSync, now = Date.now()): OrgSeedApplyResult {
	const roleStmt = db.prepare(`
		INSERT OR IGNORE INTO agent_roles
			(role_key, label, authority_rank, default_visibility_scope, can_spawn_children, can_admin_override, metadata_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const role of FULL_ORG_ROLE_SEEDS) {
		roleStmt.run(
			role.roleKey,
			role.label,
			role.authorityRank,
			role.defaultVisibilityScope,
			role.canSpawnChildren ? 1 : 0,
			role.canAdminOverride ? 1 : 0,
			JSON.stringify({ source: "full-org-preset" }),
			now,
			now,
		);
	}

	const edgeStmt = db.prepare(`
		INSERT OR IGNORE INTO agent_role_edge_policies
			(id, parent_role_key, child_role_key, edge_type, allow_spawn, allow_parent_to_child_message, allow_child_to_parent_message, allow_parent_inspect_child, allow_child_inspect_parent, allow_parent_inspect_subtree, metadata_json, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const edge of FULL_ORG_EDGE_SEEDS) {
		edgeStmt.run(
			edge.id,
			edge.parentRoleKey,
			edge.childRoleKey,
			edge.edgeType,
			edge.allowSpawn ? 1 : 0,
			edge.allowParentToChildMessage ? 1 : 0,
			edge.allowChildToParentMessage ? 1 : 0,
			edge.allowParentInspectChild ? 1 : 0,
			edge.allowChildInspectParent ? 1 : 0,
			edge.allowParentInspectSubtree ? 1 : 0,
			JSON.stringify({ source: "full-org-preset" }),
			now,
			now,
		);
	}

	return {
		rolesInsertedOrPresent: FULL_ORG_ROLE_SEEDS.length,
		edgesInsertedOrPresent: FULL_ORG_EDGE_SEEDS.length,
		source: "full-org-preset",
	};
}

/** Whether this config should apply the opinionated org chart seeder. */
export function shouldApplyFullOrgPreset(config: MeepoConfig): boolean {
	// Full preset keeps operator org chart. Core / hierarchy-off consumers skip doctrine seeds.
	if (config.preset === "full") return true;
	if (config.policies.hierarchy === "enforce" && config.preset !== "core") return true;
	return false;
}

export function countOrgRoleSeeds(db: DatabaseSync, roleKeys: string[]): number {
	if (roleKeys.length === 0) return 0;
	const placeholders = roleKeys.map(() => "?").join(", ");
	const row = db
		.prepare(`SELECT COUNT(*) AS c FROM agent_roles WHERE role_key IN (${placeholders})`)
		.get(...roleKeys) as { c: number };
	return Number(row.c);
}

export function countOrgEdgeSeeds(db: DatabaseSync, edgeIds: string[]): number {
	if (edgeIds.length === 0) return 0;
	const placeholders = edgeIds.map(() => "?").join(", ");
	const row = db
		.prepare(`SELECT COUNT(*) AS c FROM agent_role_edge_policies WHERE id IN (${placeholders})`)
		.get(...edgeIds) as { c: number };
	return Number(row.c);
}
