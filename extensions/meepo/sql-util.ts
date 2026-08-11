/**
 * Shared SQL/JSON helpers for Meepo registry modules.
 * Keep these boring and dependency-free so agent/task/service stores can share one implementation.
 */

import type { DatabaseSync } from "node:sqlite";

export function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
	if (value == null || value === "") return fallback;
	try {
		return JSON.parse(value) as T;
	} catch {
		return fallback;
	}
}

export function toBoolean(value: unknown, fallback = false): boolean {
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "1" || normalized === "true") return true;
		if (normalized === "0" || normalized === "false") return false;
	}
	return fallback;
}

export function makePlaceholders(count: number): string {
	return Array.from({ length: count }, () => "?").join(", ");
}

/** Alias used by a few call sites that prefer sqlPlaceholders naming. */
export const sqlPlaceholders = makePlaceholders;

/**
 * Append session-scope filters against an agents-like table alias.
 * When both session id and file are present, match either (OR).
 */
export function addSessionScopeFilter(
	where: string[],
	params: unknown[],
	spawnSessionId: string | null | undefined,
	spawnSessionFile: string | null | undefined,
	alias = "a",
): void {
	const prefix = alias ? `${alias}.` : "";
	if (spawnSessionId && spawnSessionFile) {
		where.push(`(${prefix}spawn_session_id = ? OR ${prefix}spawn_session_file = ?)`);
		params.push(spawnSessionId, spawnSessionFile);
		return;
	}
	if (spawnSessionId) {
		where.push(`${prefix}spawn_session_id = ?`);
		params.push(spawnSessionId);
	}
	if (spawnSessionFile) {
		where.push(`${prefix}spawn_session_file = ?`);
		params.push(spawnSessionFile);
	}
}

/** BEGIN IMMEDIATE helper with rollback on error. */
export function runImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
	db.exec("BEGIN IMMEDIATE;");
	try {
		const result = callback();
		db.exec("COMMIT;");
		return result;
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Preserve the original error.
		}
		throw error;
	}
}
