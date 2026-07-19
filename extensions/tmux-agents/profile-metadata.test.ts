import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	LEGACY_REVIEW_LEASE_PROFILE_NAMES,
	buildProfileFieldsFromFrontmatter,
	parseProfileMetadataFields,
	resolveProfileLeaseKind,
	resolveProfileRoleKey,
	toTaskLeaseKind,
} from "./profile-metadata.js";

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

describe("resolveProfileLeaseKind (metadata wins, name fallback)", () => {
	it("uses metadata lease for custom profiles not on the legacy name list", () => {
		assert.ok(!LEGACY_REVIEW_LEASE_PROFILE_NAMES.has("security-auditor"));
		assert.equal(resolveProfileLeaseKind("security-auditor", "review"), "review");
		assert.equal(toTaskLeaseKind(resolveProfileLeaseKind("security-auditor", "review")), "review");
	});

	it("falls back to legacy name table when metadata lease is absent", () => {
		assert.equal(resolveProfileLeaseKind("principal-engineer", null), "review");
		assert.equal(resolveProfileLeaseKind("reviewer", undefined), "review");
		assert.equal(resolveProfileLeaseKind("qa-lead"), "review");
		assert.equal(resolveProfileLeaseKind("engineer"), "exclusive");
		assert.equal(resolveProfileLeaseKind("worker"), "exclusive");
	});

	it("metadata overrides even when the name is not a legacy reviewer", () => {
		assert.equal(resolveProfileLeaseKind("engineer", "none"), "none");
		assert.equal(toTaskLeaseKind("none"), "review");
		assert.equal(toTaskLeaseKind("shared"), "review");
		assert.equal(toTaskLeaseKind("exclusive"), "exclusive");
	});
});

describe("resolveProfileRoleKey", () => {
	it("prefers metadata role", () => {
		assert.equal(resolveProfileRoleKey("principal-engineer", "staff-reviewer"), "staff-reviewer");
	});

	it("uses legacy principal-engineer → reviewer alias when metadata absent", () => {
		assert.equal(resolveProfileRoleKey("principal-engineer", null), "reviewer");
	});

	it("defaults to profile name", () => {
		assert.equal(resolveProfileRoleKey("backend-dev", null), "backend-dev");
	});
});

describe("buildProfileFieldsFromFrontmatter", () => {
	it("builds fields with lease/role metadata for a custom review profile", () => {
		const fields = buildProfileFieldsFromFrontmatter(
			{
				name: "security-auditor",
				description: "Security review",
				tools: "read, bash, grep",
				lease: "review",
				role: "reviewer",
			},
			"You audit security.",
		);
		assert.ok(fields);
		assert.equal(fields!.name, "security-auditor");
		assert.equal(fields!.lease, "review");
		assert.equal(fields!.roleKey, "reviewer");
		assert.equal(resolveProfileLeaseKind(fields!.name, fields!.lease), "review");
	});

	it("defaults metadata fields to null when omitted", () => {
		const fields = buildProfileFieldsFromFrontmatter(
			{ name: "worker", description: "Implement" },
			"Do the work.",
		);
		assert.ok(fields);
		assert.equal(fields!.lease, null);
		assert.equal(fields!.roleKey, null);
		assert.equal(fields!.canSpawn, null);
		assert.equal(resolveProfileLeaseKind(fields!.name, fields!.lease), "exclusive");
	});
});
