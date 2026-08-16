/**
 * Host display-name helpers (not ProcessHost I/O).
 * Slug + uniqueness live beside the host per contract #18 / policy #19.
 */

import type { HostInventory } from "./process-host.js";

/** herdr 0.8 names: `[a-z][a-z0-9_-]{0,31}` (32 chars). */
export const HERDR_HOST_NAME_MAX_LEN = 32;

export function slugifyHostName(title: string, maxLen = HERDR_HOST_NAME_MAX_LEN): string {
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

function withReservedSuffix(base: string, suffix: string, maxLen: number): string {
	const clean = suffix.toLowerCase().replace(/[^a-z0-9]+/g, "") || "x";
	const room = Math.max(1, maxLen - clean.length - 1);
	return `${base.slice(0, room)}-${clean}`.slice(0, maxLen);
}

/**
 * Ensure name is unique among live host display names.
 * Collision: entity-id tail, then -2, -3… Suffix budget is reserved before truncation.
 */
export function allocateUniqueHostName(options: {
	desired: string;
	entityId: string;
	inventory: HostInventory;
	maxLen?: number;
}): string {
	const maxLen = options.maxLen ?? HERDR_HOST_NAME_MAX_LEN;
	const live = options.inventory.displayNames;
	const desired = options.desired.slice(0, maxLen);
	if (!live.has(desired)) return desired;

	const entityTail = options.entityId.replace(/[^a-zA-Z0-9]/g, "").slice(-6).toLowerCase() || "x";
	const withEntity = withReservedSuffix(desired, entityTail, maxLen);
	if (!live.has(withEntity)) return withEntity;

	let n = 2;
	while (n < 1000) {
		const numbered = withReservedSuffix(withEntity, String(n), maxLen);
		if (!live.has(numbered)) return numbered;
		n += 1;
	}
	return withReservedSuffix(withEntity, Date.now().toString(36).toLowerCase(), maxLen);
}

export function fallbackAgentHostName(title: string, entityId: string, inventory: HostInventory): string {
	const desired = slugifyHostName(title) || `agent-${entityId.slice(-6)}`;
	return allocateUniqueHostName({ desired, entityId, inventory });
}

export function fallbackServiceHostName(title: string, entityId: string, inventory: HostInventory): string {
	const desired = serviceHostName(title);
	return allocateUniqueHostName({ desired, entityId, inventory });
}
