/**
 * Host display-name helpers (not ProcessHost I/O).
 * Slug + uniqueness live beside the host per contract #18 / policy #19.
 * Small-model English namer lands with HerdProcessHost (#22); this is the fallback path.
 */

import type { HostInventory } from "./process-host.js";

/** herdr 0.8 names: `[a-z][a-z0-9_-]{0,31}` (32 chars). */
const DEFAULT_MAX_LEN = 32;

export function slugifyHostName(title: string, maxLen = DEFAULT_MAX_LEN): string {
	const slug = title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
	return (slug || "agent").slice(0, maxLen);
}

export function serviceHostName(name: string): string {
	const bare = name.replace(/^svc-/, "");
	const slug = slugifyHostName(bare);
	return slug.startsWith("svc-") ? slug : `svc-${slug}`;
}

/**
 * Ensure name is unique among live host display names.
 * Collision: append -XXXXXX (entityId tail) then -2, -3…
 */
export function allocateUniqueHostName(options: {
	desired: string;
	entityId: string;
	inventory: HostInventory;
	maxLen?: number;
}): string {
	const maxLen = options.maxLen ?? DEFAULT_MAX_LEN;
	const live = options.inventory.displayNames;
	let candidate = options.desired.slice(0, maxLen);
	if (!live.has(candidate)) return candidate;

	const suffix = options.entityId.replace(/[^a-zA-Z0-9]/g, "").slice(-6) || "x";
	candidate = `${options.desired.slice(0, Math.max(1, maxLen - suffix.length - 1))}-${suffix}`;
	if (!live.has(candidate)) return candidate;

	let n = 2;
	while (n < 1000) {
		const numbered = `${candidate}-${n}`;
		if (!live.has(numbered.slice(0, maxLen))) return numbered.slice(0, maxLen);
		n += 1;
	}
	return `${candidate}-${Date.now().toString(36)}`.slice(0, maxLen);
}

export function fallbackAgentHostName(title: string, entityId: string, inventory: HostInventory): string {
	const desired = slugifyHostName(title) || `agent-${entityId.slice(-6)}`;
	return allocateUniqueHostName({ desired, entityId, inventory });
}

export function fallbackServiceHostName(title: string, entityId: string, inventory: HostInventory): string {
	const desired = serviceHostName(title);
	return allocateUniqueHostName({ desired, entityId, inventory });
}
