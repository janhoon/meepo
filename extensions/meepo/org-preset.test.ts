import assert from "node:assert/strict";
import { DatabaseSync } from "./sqlite.js";
import { describe, it } from "node:test";
import { createCoreDefaultConfig, createFullDefaultConfig, loadMeepoConfig } from "./config.js";
import {
	FULL_ORG_EDGE_SEEDS,
	FULL_ORG_ROLE_SEEDS,
	applyFullOrgPresetSeeds,
	countOrgEdgeSeeds,
	countOrgRoleSeeds,
	shouldApplyFullOrgPreset,
} from "./org-preset.js";

function createMinimalOrgSchema(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(`
		CREATE TABLE agent_roles (
			role_key TEXT PRIMARY KEY,
			label TEXT NOT NULL,
			authority_rank INTEGER NOT NULL,
			default_visibility_scope TEXT NOT NULL,
			can_spawn_children INTEGER NOT NULL,
			can_admin_override INTEGER NOT NULL,
			metadata_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE agent_role_edge_policies (
			id TEXT PRIMARY KEY,
			parent_role_key TEXT NOT NULL,
			child_role_key TEXT NOT NULL,
			edge_type TEXT NOT NULL,
			allow_spawn INTEGER NOT NULL,
			allow_parent_to_child_message INTEGER NOT NULL,
			allow_child_to_parent_message INTEGER NOT NULL,
			allow_parent_inspect_child INTEGER NOT NULL,
			allow_child_inspect_parent INTEGER NOT NULL,
			allow_parent_inspect_subtree INTEGER NOT NULL,
			metadata_json TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
	`);
	return db;
}

describe("shouldApplyFullOrgPreset", () => {
	it("applies for full preset config", () => {
		assert.equal(shouldApplyFullOrgPreset(createFullDefaultConfig()), true);
		assert.equal(shouldApplyFullOrgPreset(loadMeepoConfig({ env: {}, preset: "full" })), true);
		assert.equal(shouldApplyFullOrgPreset(loadMeepoConfig({ env: {} })), false);
	});

	it("does not apply for core config", () => {
		assert.equal(shouldApplyFullOrgPreset(createCoreDefaultConfig()), false);
	});
});

describe("applyFullOrgPresetSeeds", () => {
	it("idempotently ensures CEO/CTO/engineer edge chart for full preset", () => {
		const db = createMinimalOrgSchema();
		const first = applyFullOrgPresetSeeds(db);
		assert.equal(first.rolesInsertedOrPresent, FULL_ORG_ROLE_SEEDS.length);
		assert.equal(first.edgesInsertedOrPresent, FULL_ORG_EDGE_SEEDS.length);

		const roleKeys = FULL_ORG_ROLE_SEEDS.map((r) => r.roleKey);
		const edgeIds = FULL_ORG_EDGE_SEEDS.map((e) => e.id);
		assert.equal(countOrgRoleSeeds(db, roleKeys), roleKeys.length);
		assert.equal(countOrgEdgeSeeds(db, edgeIds), edgeIds.length);

		// Idempotent: second apply does not error or drop rows
		applyFullOrgPresetSeeds(db);
		assert.equal(countOrgRoleSeeds(db, roleKeys), roleKeys.length);
		assert.equal(countOrgEdgeSeeds(db, edgeIds), edgeIds.length);

		const ctoEngineer = db
			.prepare(
				`SELECT allow_spawn FROM agent_role_edge_policies WHERE id = ?`,
			)
			.get("role-edge:cto:engineer:reports_to") as { allow_spawn: number };
		assert.equal(Number(ctoEngineer.allow_spawn), 1);
	});

	it("core path does not require org seeds (hierarchy off + no seeder)", () => {
		const core = createCoreDefaultConfig();
		assert.equal(core.policies.hierarchy, "off");
		assert.equal(shouldApplyFullOrgPreset(core), false);

		const db = createMinimalOrgSchema();
		// Core never calls seeder — roles/edges stay empty; spawn under hierarchy off still works
		// (covered by hierarchy-policy tests). Here we only assert seed absence.
		assert.equal(countOrgRoleSeeds(db, ["ceo", "cto", "engineer"]), 0);
		assert.equal(countOrgEdgeSeeds(db, ["role-edge:cto:engineer:reports_to"]), 0);
	});
});
