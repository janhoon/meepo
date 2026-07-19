import type { ProfileLeaseKind } from "./types.js";

/** Historical name-table fallbacks (expand phase — keep until contract ticket removes them). */
export const LEGACY_REVIEW_LEASE_PROFILE_NAMES = new Set([
	"principal-engineer",
	"qa-lead",
	"reviewer",
]);

/** Historical role alias: profile name → role key when frontmatter role is absent. */
export const LEGACY_PROFILE_ROLE_ALIASES: Record<string, string> = {
	"principal-engineer": "reviewer",
};

export const PROFILE_LEASE_KINDS = ["exclusive", "review", "shared", "none"] as const satisfies readonly ProfileLeaseKind[];

export interface ProfileMetadataFields {
	roleKey: string | null;
	lease: ProfileLeaseKind | null;
	canSpawn: boolean | null;
}

/**
 * Parse optional lease/role/canSpawn frontmatter fields.
 * Throws on invalid non-empty lease values (clear load-time failure).
 */
export function parseProfileMetadataFields(frontmatter: Record<string, unknown>): ProfileMetadataFields {
	const roleRaw = stringifyFrontmatterValue(frontmatter.role ?? frontmatter.roleKey);
	const roleKey = roleRaw?.trim() ? roleRaw.trim() : null;

	const leaseRaw = stringifyFrontmatterValue(frontmatter.lease);
	let lease: ProfileLeaseKind | null = null;
	if (leaseRaw?.trim()) {
		const normalized = leaseRaw.trim().toLowerCase();
		if (!(PROFILE_LEASE_KINDS as readonly string[]).includes(normalized)) {
			throw new Error(
				`Invalid profile frontmatter lease "${leaseRaw}". Allowed: ${PROFILE_LEASE_KINDS.join(", ")}.`,
			);
		}
		lease = normalized as ProfileLeaseKind;
	}

	const canSpawnRaw = frontmatter.canSpawn ?? frontmatter.can_spawn;
	let canSpawn: boolean | null = null;
	if (canSpawnRaw !== undefined && canSpawnRaw !== null && String(canSpawnRaw).trim() !== "") {
		canSpawn = parseBooleanish(canSpawnRaw);
		if (canSpawn === null) {
			throw new Error(
				`Invalid profile frontmatter canSpawn "${String(canSpawnRaw)}". Use true/false.`,
			);
		}
	}

	return { roleKey, lease, canSpawn };
}

function stringifyFrontmatterValue(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function parseBooleanish(value: unknown): boolean | null {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") {
		if (value === 1) return true;
		if (value === 0) return false;
		return null;
	}
	const s = String(value).trim().toLowerCase();
	if (["true", "yes", "1", "on"].includes(s)) return true;
	if (["false", "no", "0", "off"].includes(s)) return false;
	return null;
}

/**
 * Resolve lease kind for a profile name + optional metadata lease.
 * Metadata wins; otherwise legacy name table; default exclusive.
 * Task registry uses exclusive|review only — shared/none map to exclusive for conflict checks
 * until a later ticket expands TaskLeaseKind (shared/none treated as non-exclusive for ownership).
 */
export function resolveProfileLeaseKind(
	profileName: string | null | undefined,
	metadataLease?: ProfileLeaseKind | null,
): ProfileLeaseKind {
	if (metadataLease) return metadataLease;
	const normalized = (profileName ?? "").trim().toLowerCase();
	if (LEGACY_REVIEW_LEASE_PROFILE_NAMES.has(normalized)) return "review";
	return "exclusive";
}

/**
 * Map profile lease to task-registry lease kinds currently supported (exclusive | review).
 * shared/none → exclusive for conflict purposes is wrong for "none"; treat none/shared as review-sibling
 * only when exclusive conflict should not apply: use "review" for shared/none so multiple can attach.
 */
export function toTaskLeaseKind(lease: ProfileLeaseKind): "exclusive" | "review" {
	return lease === "exclusive" ? "exclusive" : "review";
}

/**
 * Resolve hierarchy role key: metadata role wins; else legacy alias; else profile name.
 */
export function resolveProfileRoleKey(
	profileName: string,
	metadataRoleKey?: string | null,
): string {
	if (metadataRoleKey?.trim()) return metadataRoleKey.trim();
	const normalized = profileName.trim();
	return LEGACY_PROFILE_ROLE_ALIASES[normalized] ?? LEGACY_PROFILE_ROLE_ALIASES[normalized.toLowerCase()] ?? normalized;
}

export interface ProfileFrontmatterBuildInput {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	role?: unknown;
	roleKey?: unknown;
	lease?: unknown;
	canSpawn?: unknown;
	can_spawn?: unknown;
	[key: string]: unknown;
}

export interface BuiltProfileFields {
	name: string;
	description: string;
	toolNames: string[] | undefined;
	model: string | null;
	roleKey: string | null;
	lease: ProfileLeaseKind | null;
	canSpawn: boolean | null;
	systemPrompt: string;
}

/**
 * Pure profile field extraction from frontmatter + body (no filesystem, no Pi imports).
 * Returns null when name/description missing. Throws on invalid lease/canSpawn.
 */
export function buildProfileFieldsFromFrontmatter(
	frontmatter: ProfileFrontmatterBuildInput,
	body: string,
): BuiltProfileFields | null {
	const name = typeof frontmatter.name === "string" ? frontmatter.name.trim() : "";
	const description = typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
	if (!name || !description) return null;

	const toolsRaw =
		typeof frontmatter.tools === "string"
			? frontmatter.tools
					.split(",")
					.map((value) => value.trim())
					.filter(Boolean)
			: undefined;
	const model =
		typeof frontmatter.model === "string" && frontmatter.model.trim()
			? frontmatter.model.trim()
			: null;
	const meta = parseProfileMetadataFields(frontmatter);
	return {
		name,
		description,
		toolNames: toolsRaw,
		model,
		roleKey: meta.roleKey,
		lease: meta.lease,
		canSpawn: meta.canSpawn,
		systemPrompt: body.trim(),
	};
}
