/**
 * Task health counts Attention through Inbox once. Leftover + v2 shadows do not double-count.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bootstrapMeepoDatabase } from "./db.js";
import { listOpenAttention } from "./inbox.js";
import {
	createAgent,
	createAgentAttentionItemV2,
	createAttentionItem,
	createMessageWithRecipients,
	createRootActorContext,
} from "./registry.js";
import { DatabaseSync } from "./sqlite.js";
import { listTaskHealth } from "./task-health.js";
import { createTask, getTask, linkTaskAgent } from "./task-registry.js";

describe("listTaskHealth attention counts", () => {
	it("counts one Attention item even when a leftover row shadows the same v2 id", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const taskId = "task_health_1";
		const childId = "sa_health_1";
		createTask(db, {
			id: taskId,
			spawnCwd: "/tmp",
			projectKey: "proj",
			title: "health",
			status: "in_progress",
		});
		createAgent(db, {
			id: childId,
			spawnCwd: "/tmp",
			projectKey: "proj",
			taskId,
			profile: "worker",
			title: childId,
			task: "do work",
			state: "running",
			transportKind: "rpc_bridge",
			transportState: "live",
			runDir: "/tmp/sa_health_1",
			sessionFile: "/tmp/sa_health_1/session.jsonl",
		});
		linkTaskAgent(db, { taskId, agentId: childId, role: "worker", isActive: true });
		const published = createMessageWithRecipients(db, {
			actor: createRootActorContext(),
			recipients: [{ kind: "root", deliveryMode: "immediate" }],
			projectKey: "proj",
			taskId,
			subjectAgentId: childId,
			kind: "question",
			summary: "need a decision",
			payload: { taskId },
			skipPermissionCheck: true,
		});
		createAgentAttentionItemV2(db, {
			messageId: published.message.id,
			recipientRowId: published.recipients[0]!.id,
			projectKey: "proj",
			taskId,
			subjectAgentId: childId,
			ownerKind: "root",
			kind: "question",
			priority: 1,
			state: "waiting_on_owner",
			summary: "need a decision",
			payload: { taskId },
		});
		createAttentionItem(db, {
			id: "att_legacy_1",
			agentId: childId,
			threadId: childId,
			projectKey: "proj",
			audience: "coordinator",
			kind: "question",
			priority: 1,
			state: "waiting_on_coordinator",
			summary: "need a decision",
			payload: {
				taskId,
				v2MessageId: published.message.id,
				v2RecipientRowId: published.recipients[0]!.id,
			},
		});
		const open = listOpenAttention(db, { taskIds: [taskId] });
		assert.equal(open.length, 1);
		const task = getTask(db, taskId);
		assert.ok(task);
		const snapshot = listTaskHealth(db, [task]).get(taskId);
		assert.ok(snapshot);
		assert.equal(snapshot.signals.includes("approval_required"), false);
	});
});
