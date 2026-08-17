/**
 * Shared SQL/JSON helpers for Meepo registry modules.
 * Keep these boring and dependency-free so agent/task/service stores can share one implementation.
 */

import type { DatabaseSync } from "./sqlite.js";

export function payloadObject(payload: unknown): Record<string, unknown> {
	return payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
}

export function payloadString(payload: unknown, key: string): string | undefined {
	const value = payloadObject(payload)[key];
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function payloadStringArray(payload: unknown, key: string): string[] {
	const value = payloadObject(payload)[key];
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

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

const transactionDepth = new WeakMap<object, number>();

/** BEGIN IMMEDIATE helper. Nested calls use SAVEPOINT so one outer rollback covers them. */
export function runImmediateTransaction<T>(db: DatabaseSync, callback: () => T): T {
	const depth = transactionDepth.get(db) ?? 0;
	if (depth === 0) {
		db.exec("BEGIN IMMEDIATE;");
	} else {
		db.exec(`SAVEPOINT meepo_tx_${depth};`);
	}
	transactionDepth.set(db, depth + 1);
	try {
		const result = callback();
		if (depth === 0) db.exec("COMMIT;");
		else db.exec(`RELEASE SAVEPOINT meepo_tx_${depth};`);
		return result;
	} catch (error) {
		try {
			if (depth === 0) db.exec("ROLLBACK;");
			else db.exec(`ROLLBACK TO SAVEPOINT meepo_tx_${depth};`);
		} catch {
			// Preserve the original error.
		}
		throw error;
	} finally {
		if (depth === 0) transactionDepth.delete(db);
		else transactionDepth.set(db, depth);
	}
}
