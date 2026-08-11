import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFullDefaultConfig, loadMeepoConfig } from "./config.js";
import { evaluateHierarchySpawn } from "./hierarchy-policy.js";

describe("hierarchy policy config defaults", () => {
	it("full/default uses enforce", () => {
		assert.equal(loadMeepoConfig({ env: {}, preset: "full" }).policies.hierarchy, "enforce");
		assert.equal(loadMeepoConfig({ env: {} }).policies.hierarchy, "off");
		assert.equal(createFullDefaultConfig().policies.hierarchy, "enforce");
	});
});

describe("evaluateHierarchySpawn", () => {
	const base = {
		parentAgentId: "sa_parent",
		parentRoleKey: "cto",
		childRoleKey: "engineer",
	};

	it("off: missing edge policy does not hard-fail", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "off",
			edgePolicy: null,
		});
		assert.equal(decision.outcome, "allow");
	});

	it("off: missing roles does not hard-fail", () => {
		const decision = evaluateHierarchySpawn({
			mode: "off",
			parentAgentId: "sa_parent",
			parentRoleKey: null,
			childRoleKey: null,
			edgePolicy: null,
		});
		assert.equal(decision.outcome, "allow");
	});

	it("advisory: missing edge is allowed with observable note", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "advisory",
			edgePolicy: null,
		});
		assert.equal(decision.outcome, "advisory");
		if (decision.outcome === "advisory") {
			assert.match(decision.note, /No reports_to role edge policy/);
		}
	});

	it("advisory: allow_spawn=0 is allowed with note", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "advisory",
			edgePolicy: { id: "role-edge:cto:engineer:reports_to", allowSpawn: false },
		});
		assert.equal(decision.outcome, "advisory");
		if (decision.outcome === "advisory") {
			assert.match(decision.note, /does not allow spawning/);
		}
	});

	it("enforce: missing edge denies (current behavior)", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "enforce",
			edgePolicy: null,
		});
		assert.equal(decision.outcome, "deny");
		if (decision.outcome === "deny") {
			assert.match(decision.reason, /No reports_to role edge policy/);
		}
	});

	it("enforce: allow_spawn=0 denies", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "enforce",
			edgePolicy: { id: "edge-1", allowSpawn: false },
		});
		assert.equal(decision.outcome, "deny");
	});

	it("enforce: missing parent role denies", () => {
		const decision = evaluateHierarchySpawn({
			mode: "enforce",
			parentAgentId: "sa_parent",
			parentRoleKey: null,
			childRoleKey: "engineer",
			edgePolicy: null,
		});
		assert.equal(decision.outcome, "deny");
		if (decision.outcome === "deny") {
			assert.match(decision.reason, /parent role is missing/);
		}
	});

	it("enforce: matching allow_spawn=1 allows", () => {
		const decision = evaluateHierarchySpawn({
			...base,
			mode: "enforce",
			edgePolicy: { id: "edge-ok", allowSpawn: true },
		});
		assert.equal(decision.outcome, "allow");
	});
});
