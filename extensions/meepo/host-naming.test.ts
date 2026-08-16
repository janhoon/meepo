import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	HERDR_HOST_NAME_MAX_LEN,
	allocateUniqueHostName,
	fallbackAgentHostName,
	slugifyHostName,
} from "./host-naming.js";
import type { HostInventory } from "./process-host.js";

function inventory(names: string[]): HostInventory {
	return {
		primaryIds: new Set(),
		displayNames: new Set(names),
	};
}

describe("host naming", () => {
	it("slugs and caps at 32 chars", () => {
		assert.equal(slugifyHostName("Research herdr"), "research-herdr");
		assert.equal(slugifyHostName("thermo-nuclear-code-quality-review").length, HERDR_HOST_NAME_MAX_LEN);
		assert.match(slugifyHostName("thermo-nuclear-code-quality-review"), /^[a-z][a-z0-9-]{0,31}$/);
	});

	it("keeps 32-char collisions unique with reserved suffix budget", () => {
		const title = "thermo-nuclear-code-quality-review";
		const first = fallbackAgentHostName(title, "sa_aaaaaa", inventory([]));
		const second = fallbackAgentHostName(title, "sa_bbbbbb", inventory([first]));
		const third = fallbackAgentHostName(title, "sa_bbbbbb", inventory([first, second]));
		assert.equal(first.length, 32);
		assert.ok(second.length <= 32);
		assert.ok(third.length <= 32);
		assert.notEqual(first, second);
		assert.notEqual(second, third);
		assert.notEqual(first, third);
		assert.match(second, /bbbbbb/);
		assert.match(third, /-2$/);
	});

	it("numbered retries stay unique when the entity-suffix form is already 32 chars", () => {
		const desired = "a".repeat(32);
		const names = new Set<string>([desired]);
		const taken = inventory([...names]);
		const first = allocateUniqueHostName({ desired, entityId: "sa_xyzxyz", inventory: taken });
		taken.displayNames.add(first);
		const second = allocateUniqueHostName({ desired, entityId: "sa_xyzxyz", inventory: taken });
		assert.notEqual(first, desired);
		assert.notEqual(second, first);
		assert.ok(first.length <= 32);
		assert.ok(second.length <= 32);
	});
});
