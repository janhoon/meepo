import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, type Migration } from "./migrations/index.js";

const require = createRequire(import.meta.url);

function loadPaths(): { ensureMeepoRuntimePaths: () => { databasePath: string } } {
	return require("./paths.js") as { ensureMeepoRuntimePaths: () => { databasePath: string } };
}

function applyPragmas(db: DatabaseSync): void {
	db.exec("PRAGMA journal_mode = WAL;");
	db.exec("PRAGMA synchronous = NORMAL;");
	db.exec("PRAGMA foreign_keys = ON;");
	db.exec("PRAGMA busy_timeout = 5000;");
	db.exec("PRAGMA temp_store = MEMORY;");
}

function ensureMigrationTable(db: DatabaseSync): void {
	db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
	version INTEGER PRIMARY KEY,
	name TEXT NOT NULL,
	applied_at INTEGER NOT NULL
);
`);
}

function getAppliedVersions(db: DatabaseSync): Set<number> {
	const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all() as Array<{
		version: number;
	}>;
	return new Set(rows.map((row) => row.version));
}

function applyMigration(db: DatabaseSync, migration: Migration): void {
	const now = Date.now();
	db.exec("BEGIN IMMEDIATE;");
	try {
		db.exec(migration.sql);
		db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
			migration.version,
			migration.name,
			now,
		);
		db.exec("COMMIT;");
	} catch (error) {
		try {
			db.exec("ROLLBACK;");
		} catch {
			// Ignore rollback errors.
		}
		throw error;
	}
}

function bootstrapDatabase(db: DatabaseSync): void {
	ensureMigrationTable(db);
	const appliedVersions = getAppliedVersions(db);
	for (const migration of MIGRATIONS) {
		if (!appliedVersions.has(migration.version)) {
			applyMigration(db, migration);
		}
	}
}

/** Apply pragmas + migrations to an arbitrary DB (tests, one-off tools). */
export function bootstrapMeepoDatabase(db: DatabaseSync): void {
	applyPragmas(db);
	bootstrapDatabase(db);
}

let openConnection: { path: string; db: DatabaseSync } | undefined;

export function getMeepoDb(): DatabaseSync {
	// Lazy import keeps migration bootstrap usable in unit tests without Pi package resolution.
	const { ensureMeepoRuntimePaths } = loadPaths();
	const { databasePath } = ensureMeepoRuntimePaths();
	if (openConnection && openConnection.path === databasePath) {
		return openConnection.db;
	}

	if (openConnection) {
		try {
			openConnection.db.close();
		} catch {
			// Ignore close errors while rotating connections.
		}
		openConnection = undefined;
	}

	const db = new DatabaseSync(databasePath);
	applyPragmas(db);
	bootstrapDatabase(db);
	openConnection = { path: databasePath, db };
	return db;
}

export function closeMeepoDb(): void {
	if (!openConnection) return;
	try {
		openConnection.db.close();
	} catch {
		// Ignore close errors on shutdown.
	}
	openConnection = undefined;
}
