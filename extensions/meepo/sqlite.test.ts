import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "./sqlite.js";

describe("sqlite adapter", () => {
	it("opens an in-memory database and supports exec/prepare/get/all/run/close", () => {
		const db = new DatabaseSync(":memory:");
		db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
		const insert = db.prepare("INSERT INTO items (name) VALUES (?)");
		const first = insert.run("alpha");
		insert.run("beta");
		assert.ok(Number(first.changes ?? 0) >= 1);

		const row = db.prepare("SELECT name FROM items WHERE id = ?").get(1) as { name?: string } | undefined;
		assert.equal(row?.name, "alpha");

		const rows = db.prepare("SELECT name FROM items ORDER BY id ASC").all() as Array<{ name: string }>;
		assert.deepEqual(rows.map((item) => item.name), ["alpha", "beta"]);
		db.close();
	});
});
