import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	clearProfileCompatRegistry,
	buildProfileFieldsFromFrontmatter,
	getProfileCompatRegistry,
	parseProfileMetadataFields,
	registerFullMeepoProfileCompat,
	resolveProfileLeaseKind,
	resolveProfileRoleKey,
	toTaskLeaseKind,
} from "./profile-metadata.js";

beforeEach(() => {
	clearProfileCompatRegistry();
});

afterEach(() => {
	clearProfileCompatRegistry();
});

describe("parseProfileMetadataFields", () => {
	it("returns nulls when metadata is absent", () => {
		assert.deepEqual(parseProfileMetadataFields({ name: "worker", description: "x" }), {
			roleKey: null,
			lease: null,
			canSpawn: null,
		});
	});

	it("parses role, lease, and canSpawn", () => {
		assert.deepEqual(
			parseProfileMetadataFields({
				role: "implementer",
				lease: "review",
				canSpawn: "true",
			}),
			{ roleKey: "implementer", lease: "review", canSpawn: true },
		);
	});

	it("throws on invalid lease", () => {
		assert.throws(
			() => parseProfileMetadataFields({ lease: "owner" }),
			/Invalid profile frontmatter lease/,
		);
	});

	it("throws on invalid canSpawn", () => {
		assert.throws(
			() => parseProfileMetadataFields({ canSpawn: "maybe" }),
			/Invalid profile frontmatter canSpawn/,
		);
	});
});

describe("resolveProfileLeaseKind without hardcoded tables (contract)", () => {
	it("metadata-only custom profile is review without name-list membership", () => {
		assert.equal(getProfileCompatRegistry().reviewLeaseNames.size, 0);
		assert.equal(resolveProfileLeaseKind("security-auditor", "review"), "review");
		assert.equal(toTaskLeaseKind(resolveProfileLeaseKind("security-auditor", "review")), "review");
	});

	it("without compat registry, unknown names default to exclusive", () => {
		assert.equal(resolveProfileLeaseKind("principal-engineer", null), "exclusive");
		assert.equal(resolveProfileLeaseKind("reviewer", null), "exclusive");
		assert.equal(resolveProfileLeaseKind("qa-lead", null), "exclusive");
	});

	it("full-meepo compat registry restores historical name fallbacks", () => {
		registerFullMeepoProfileCompat();
		assert.equal(resolveProfileLeaseKind("principal-engineer", null), "review");
		assert.equal(resolveProfileLeaseKind("reviewer", null), "review");
		assert.equal(resolveProfileLeaseKind("qa-lead", null), "review");
		assert.equal(resolveProfileLeaseKind("engineer", null), "exclusive");
	});

	it("metadata overrides compat registry", () => {
		registerFullMeepoProfileCompat();
		assert.equal(resolveProfileLeaseKind("engineer", "none"), "none");
		assert.equal(toTaskLeaseKind("none"), "review");
		assert.equal(toTaskLeaseKind("exclusive"), "exclusive");
	});
});

describe("resolveProfileRoleKey without buried aliases", () => {
	it("prefers metadata role", () => {
		assert.equal(resolveProfileRoleKey("principal-engineer", "staff-reviewer"), "staff-reviewer");
	});

	it("without compat, principal-engineer is not aliased", () => {
		assert.equal(resolveProfileRoleKey("principal-engineer", null), "principal-engineer");
	});

	it("full-meepo compat registers principal-engineer → reviewer", () => {
		registerFullMeepoProfileCompat();
		assert.equal(resolveProfileRoleKey("principal-engineer", null), "reviewer");
	});

	it("defaults to profile name", () => {
		assert.equal(resolveProfileRoleKey("backend-dev", null), "backend-dev");
	});
});

describe("full-preset profile frontmatter parity", () => {
	it("principal-engineer frontmatter carries review lease + reviewer role", () => {
		const fields = buildProfileFieldsFromFrontmatter(
			{
				name: "principal-engineer",
				description: "Technical acceptance",
				lease: "review",
				role: "reviewer",
			},
			"Review code.",
		);
		assert.ok(fields);
		assert.equal(fields!.lease, "review");
		assert.equal(fields!.roleKey, "reviewer");
		// Metadata alone is enough — no compat registry required
		assert.equal(resolveProfileLeaseKind(fields!.name, fields!.lease), "review");
		assert.equal(resolveProfileRoleKey(fields!.name, fields!.roleKey), "reviewer");
	});

	it("custom metadata-only profile works without name-table membership", () => {
		const fields = buildProfileFieldsFromFrontmatter(
			{
				name: "security-auditor",
				description: "Security review",
				lease: "review",
				role: "reviewer",
			},
			"Audit.",
		);
		assert.ok(fields);
		assert.equal(resolveProfileLeaseKind(fields!.name, fields!.lease), "review");
		assert.equal(getProfileCompatRegistry().reviewLeaseNames.has("security-auditor"), false);
	});
});
