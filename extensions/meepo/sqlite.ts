/**
 * SQLite constructor compatible with Node (`node:sqlite`) and Bun (`bun:sqlite`).
 *
 * Compiled `pi` binaries are Bun and do not expose `node:sqlite`. A static
 * `import "node:sqlite"` therefore fails extension load with:
 *   ResolveMessage: No such built-in module: node:sqlite
 *
 * Specifiers are built at runtime so Bun/jiti cannot statically resolve them.
 */

import { createRequire } from "node:module";

export interface SqliteRunResult {
	changes?: number;
	lastInsertRowid?: number | bigint;
}

export interface SqliteStatement {
	run(...params: unknown[]): SqliteRunResult;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SqliteDatabase {
	exec(sql: string): unknown;
	prepare(sql: string): SqliteStatement;
	close(): void;
}

type DatabaseCtor = new (path: string) => SqliteDatabase;

const NODE_SQLITE = ["node", "sqlite"].join(":");
const BUN_SQLITE = ["bun", "sqlite"].join(":");

function requireModule(specifier: string): unknown {
	const require = createRequire(import.meta.url);
	return require(specifier);
}

function asDatabaseCtor(mod: unknown, exportName: "DatabaseSync" | "Database"): DatabaseCtor | undefined {
	if (!mod || typeof mod !== "object") return undefined;
	const ctor = (mod as Record<string, unknown>)[exportName];
	return typeof ctor === "function" ? (ctor as DatabaseCtor) : undefined;
}

function loadNativeDatabaseCtor(): DatabaseCtor {
	const isBun = typeof process.versions.bun === "string";
	const attempts: Array<{ specifier: string; exportName: "DatabaseSync" | "Database" }> = isBun
		? [
				{ specifier: BUN_SQLITE, exportName: "Database" },
				{ specifier: NODE_SQLITE, exportName: "DatabaseSync" },
			]
		: [
				{ specifier: NODE_SQLITE, exportName: "DatabaseSync" },
				{ specifier: BUN_SQLITE, exportName: "Database" },
			];

	const errors: unknown[] = [];
	for (const attempt of attempts) {
		try {
			const ctor = asDatabaseCtor(requireModule(attempt.specifier), attempt.exportName);
			if (ctor) return ctor;
			errors.push(new Error(`${attempt.specifier} loaded but missing ${attempt.exportName}`));
		} catch (error) {
			errors.push(error);
		}
	}

	throw new Error("Meepo requires SQLite via Node 22.5+ (node:sqlite) or Bun (bun:sqlite).", {
		cause: errors[0],
	});
}

const NativeDatabase = loadNativeDatabaseCtor();

/** Host-neutral DatabaseSync stand-in (Node DatabaseSync or Bun Database). */
export class DatabaseSync implements SqliteDatabase {
	readonly #db: SqliteDatabase;

	constructor(path: string) {
		this.#db = new NativeDatabase(path);
	}

	exec(sql: string): void {
		this.#db.exec(sql);
	}

	prepare(sql: string): SqliteStatement {
		return this.#db.prepare(sql);
	}

	close(): void {
		this.#db.close();
	}
}
