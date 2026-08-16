/**
 * Inbox interface: publish / list / mark on v2. Leftover legacy rows stay readable.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";
import { bootstrapMeepoDatabase } from "./db.js";
import { inboxEntryFromRecord, listInboxForChild, markInbox, publishDownward } from "./inbox.js";
import { createAgent, createRootActorContext, getAgent, listMessagesForRecipient } from "./registry.js";
import { DatabaseSync } from "./sqlite.js";

function seedAgent(db: DatabaseSync, id: string, projectKey = "test-project"): void {
	createAgent(db, {
		id,
		spawnCwd: "/tmp",
		projectKey,
		profile: "worker",
		title: id,
		task: "do work",
		state: "running",
		transportKind: "rpc_bridge",
		transportState: "live",
		runDir: `/tmp/${id}`,
		sessionFile: `/tmp/${id}/session.jsonl`,
	});
}

describe("inbox", () => {
	it("publishDownward writes v2 only and list/mark use one id", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const childId = `child_${randomUUID().slice(0, 8)}`;
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		seedAgent(db, childId, projectKey);
		const agent = getAgent(db, childId);
		assert.ok(agent);
		const published = publishDownward(db, {
			actor: createRootActorContext(),
			agent,
			kind: "answer",
			summary: "go",
			deliveryMode: "steer",
			actionPolicy: "resume_if_blocked",
		});
		assert.ok(published.messageId);
		assert.ok(published.recipientRowId);

		const queued = listInboxForChild(db, childId, { limit: 20 });
		assert.equal(queued.length, 1);
		assert.equal(queued[0]!.direction, "downward");
		assert.equal(queued[0]!.kind, "answer");
		assert.equal(queued[0]!.summary, "go");
		assert.equal(queued[0]!.childId, childId);
		assert.equal(queued[0]!.status, "queued");

		const records = listMessagesForRecipient(db, childId, { targetKind: "child", limit: 20 });
		assert.equal(records.length, 1);
		assert.equal(inboxEntryFromRecord(records[0]!).id, queued[0]!.id);

		const marked = markInbox(db, [queued[0]!.id], "acked", { childId, transportKind: "rpc_bridge" });
		assert.ok(marked >= 1);
		const after = listInboxForChild(db, childId, { includeDelivered: true, limit: 20 });
		assert.equal(after[0]!.status, "acked");
		const stillQueued = listInboxForChild(db, childId, { limit: 20 });
		assert.equal(stillQueued.length, 0);
	});
});
