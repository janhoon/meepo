/**
 * Characterization: upward publish is v2-canonical (no legacy dual-write).
 * Delivery readers project v2 into the AgentMessageRecord shape for bridge/inbox code.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { bootstrapMeepoDatabase } from "./db.js";
import {
	createAgent,
	createAgentAttentionItemV2,
	createMessageWithRecipients,
	getFleetSummary,
	listAgents,
	listInboxMessages,
	listAgentAttentionItemsV2,
	listAttentionItems,
} from "./registry.js";
import { legacyMessageIsV2Shadow, mergeDeliveryMessages } from "./message-adapters.js";
import type { AgentMessageRecord } from "./types.js";

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

describe("messaging single-path (v2 canonical)", () => {
	it("mergeDeliveryMessages drops legacy v2 shadows when v2 row is present", () => {
		const v2: AgentMessageRecord = {
			id: "recip-1",
			threadId: "t1",
			senderAgentId: "child",
			recipientAgentId: null,
			targetKind: "primary",
			kind: "question",
			deliveryMode: "immediate",
			payload: { summary: "hi", v2MessageId: "m1", v2RecipientRowId: "recip-1" },
			status: "queued",
			createdAt: 2,
			deliveredAt: null,
			ackedAt: null,
		};
		const legacyShadow: AgentMessageRecord = {
			id: "legacy-1",
			threadId: "child",
			senderAgentId: "child",
			recipientAgentId: null,
			targetKind: "primary",
			kind: "question",
			deliveryMode: "immediate",
			payload: { summary: "hi", v2MessageId: "m1", v2RecipientRowId: "recip-1" },
			status: "queued",
			createdAt: 1,
			deliveredAt: null,
			ackedAt: null,
		};
		const pureLegacy: AgentMessageRecord = {
			id: "down-1",
			threadId: "child",
			senderAgentId: null,
			recipientAgentId: "child",
			targetKind: "child",
			kind: "answer",
			deliveryMode: "steer",
			payload: { summary: "go" },
			status: "queued",
			createdAt: 3,
			deliveredAt: null,
			ackedAt: null,
		};
		assert.equal(legacyMessageIsV2Shadow(legacyShadow), true);
		assert.equal(legacyMessageIsV2Shadow(pureLegacy), false);
		const merged = mergeDeliveryMessages([v2], [legacyShadow, pureLegacy]);
		assert.equal(merged.length, 2);
		assert.equal(merged[0]!.id, "recip-1");
		assert.equal(merged[1]!.id, "down-1");
	});

	it("createMessageWithRecipients + v2 attention is enough for inbox and listAgents unread", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const childId = `child_${randomUUID().slice(0, 8)}`;
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		seedAgent(db, childId, projectKey);

		const actor = {
			kind: "agent" as const,
			agentId: childId,
			projectKey,
			spawnSessionId: null,
			spawnSessionFile: null,
			defaultVisibilityScope: "self_parent" as const,
			canAdminOverride: false,
		};
		const result = createMessageWithRecipients(db, {
			actor,
			recipients: [{ kind: "root", deliveryMode: "immediate" }],
			projectKey,
			subjectAgentId: childId,
			kind: "question",
			summary: "Need a decision",
			payload: { kind: "question", summary: "Need a decision" },
			priority: 1,
			requiresResponse: true,
			thread: { kind: "question", title: "Need a decision" },
			skipPermissionCheck: true,
		});
		createAgentAttentionItemV2(db, {
			messageId: result.message.id,
			recipientRowId: result.recipients[0]!.id,
			projectKey,
			subjectAgentId: childId,
			ownerKind: "root",
			ownerAgentId: null,
			kind: "question",
			priority: 1,
			state: "waiting_on_owner",
			summary: "Need a decision",
			payload: { summary: "Need a decision", v2MessageId: result.message.id },
		});

		const inbox = listInboxMessages(db, { projectKey, limit: 20 });
		assert.ok(
			inbox.some((m) => {
				const payload = m.payload as { v2MessageId?: string };
				return payload?.v2MessageId === result.message.id;
			}),
			"inbox should surface v2-only publish",
		);

		const agents = listAgents(db, { projectKey, unreadOnly: true, limit: 20 });
		assert.ok(agents.some((a) => a.id === childId), "listAgents unreadOnly should include v2 publisher");
		const child = agents.find((a) => a.id === childId)!;
		assert.ok(child.unreadCount >= 1);

		const v2Attention = listAgentAttentionItemsV2(db, { projectKey, states: ["waiting_on_owner"], limit: 20 });
		assert.ok(v2Attention.some((item) => item.messageId === result.message.id));

		// No legacy dual-write expected for this synthetic path.
		const legacyAttention = listAttentionItems(db, { projectKey, limit: 50 });
		assert.ok(
			!legacyAttention.some((item) => {
				const payload = item.payload as { v2MessageId?: string } | null;
				return payload?.v2MessageId === result.message.id;
			}),
		);

		const fleet = getFleetSummary(db, { projectKey });
		assert.ok(fleet.unread >= 1);
		assert.ok(fleet.attentionOpen >= 1);
	});
});
