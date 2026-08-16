/**
 * Parent-owned messaging: subagent mail is 1:1 with its parent only.
 * All isolation surfaces (wake/inbox/attention/board) must compose the same
 * ownership seam: computeParentOwnedAgentIds → resolveOwnedSubjectIdsFromParts.
 */
import assert from "node:assert/strict";
import { DatabaseSync } from "./sqlite.js";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { bootstrapMeepoDatabase } from "./db.js";
import {
	createAgent,
	createAgentAttentionItemV2,
	createMessageWithRecipients,
	createRootActorContext,
	fetchAgentInboxV2,
	listAgentAttentionItemsV2,
	listDescendantAgentIds,
	resolveAgentActorContext,
} from "./registry.js";
import {
	computeParentOwnedAgentIds,
	resolveOwnedSubjectIdsFromParts,
	ROOT_SURFACE_OWNER_KINDS,
	withOwnedSubjectPin,
	type OwnershipScope,
} from "./session-scope.js";
import { attentionOwnerKindsForAudience, attentionV2MatchesAudience } from "./task-interactions.js";

function seedAgent(
	db: DatabaseSync,
	input: {
		id: string;
		projectKey: string;
		parentAgentId?: string | null;
		spawnSessionId?: string | null;
		spawnSessionFile?: string | null;
	},
): void {
	createAgent(db, {
		id: input.id,
		spawnCwd: "/tmp",
		projectKey: input.projectKey,
		profile: "worker",
		title: input.id,
		task: "do work",
		state: "running",
		transportKind: "rpc_bridge",
		transportState: "live",
		runDir: `/tmp/${input.id}`,
		sessionFile: `/tmp/${input.id}/session.jsonl`,
		parentAgentId: input.parentAgentId ?? null,
		spawnSessionId: input.spawnSessionId ?? null,
		spawnSessionFile: input.spawnSessionFile ?? null,
	});
}

function publishToRecipient(
	db: DatabaseSync,
	input: {
		senderId: string;
		projectKey: string;
		recipient: { kind: "root" } | { kind: "agent"; agentId: string };
		summary: string;
	},
) {
	const actor = resolveAgentActorContext(db, { currentAgentId: input.senderId });
	const result = createMessageWithRecipients(db, {
		actor,
		recipients: [{ ...input.recipient, deliveryMode: "immediate" }],
		projectKey: input.projectKey,
		subjectAgentId: input.senderId,
		kind: "question",
		summary: input.summary,
		payload: { kind: "question", summary: input.summary },
		priority: 1,
		requiresResponse: true,
		thread: { kind: "question", title: input.summary },
		skipPermissionCheck: true,
	});
	createAgentAttentionItemV2(db, {
		messageId: result.message.id,
		recipientRowId: result.recipients[0]!.id,
		projectKey: input.projectKey,
		subjectAgentId: input.senderId,
		ownerKind: input.recipient.kind,
		ownerAgentId: input.recipient.kind === "agent" ? input.recipient.agentId : null,
		kind: "question",
		priority: 1,
		state: "waiting_on_owner",
		summary: input.summary,
		payload: { summary: input.summary, v2MessageId: result.message.id },
	});
	return result;
}

/**
 * Pure stand-in for resolveRootInboxSenderIds (ctx wrapper):
 * owned null (scope=all) → undefined (no pin); else owned ids (incl. [] fail-closed).
 */
function rootInboxSenderIdsFromOwned(owned: string[] | null): string[] | undefined {
	return owned === null ? undefined : owned;
}

/** Compose the same chain wake/inbox/attention use: owned ids → root inbox sender allow-list. */
function composeRootInboxSenderIds(
	db: DatabaseSync,
	scope: OwnershipScope,
	input: {
		actor: ReturnType<typeof createRootActorContext>;
		projectKey: string;
		spawnSessionId?: string | null;
		spawnSessionFile?: string | null;
		linkedChildIds?: string[];
	},
): string[] | undefined {
	const parentOwnedIds = computeParentOwnedAgentIds(db, {
		actor: input.actor,
		projectKey: input.projectKey,
		spawnSessionId: input.spawnSessionId,
		spawnSessionFile: input.spawnSessionFile,
		linkedChildIds: input.linkedChildIds,
	});
	return rootInboxSenderIdsFromOwned(
		resolveOwnedSubjectIdsFromParts(scope, {
			parentOwnedIds,
			linkedChildIds: input.linkedChildIds ?? [],
			listDescendants: (ids) => listDescendantAgentIds(db, ids),
		}),
	);
}

describe("computeParentOwnedAgentIds (pure ownership core)", () => {
	it("root owns session-spawned agents + linked children + descendants only", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const sessionA = `sess_a_${randomUUID().slice(0, 6)}`;
		const sessionB = `sess_b_${randomUUID().slice(0, 6)}`;
		const childA = `child_a_${randomUUID().slice(0, 6)}`;
		const grandA = `grand_a_${randomUUID().slice(0, 6)}`;
		const childB = `child_b_${randomUUID().slice(0, 6)}`;
		const linkedOnly = `linked_${randomUUID().slice(0, 6)}`;

		seedAgent(db, { id: childA, projectKey, spawnSessionId: sessionA, spawnSessionFile: `/tmp/${sessionA}.jsonl` });
		seedAgent(db, { id: grandA, projectKey, parentAgentId: childA, spawnSessionId: `other_${sessionA}` });
		seedAgent(db, { id: childB, projectKey, spawnSessionId: sessionB, spawnSessionFile: `/tmp/${sessionB}.jsonl` });
		seedAgent(db, { id: linkedOnly, projectKey, spawnSessionId: "unrelated" });

		const rootA = createRootActorContext({
			projectKey,
			spawnSessionId: sessionA,
			spawnSessionFile: `/tmp/${sessionA}.jsonl`,
		});
		const owned = computeParentOwnedAgentIds(db, {
			actor: rootA,
			projectKey,
			spawnSessionId: sessionA,
			spawnSessionFile: `/tmp/${sessionA}.jsonl`,
			linkedChildIds: [linkedOnly],
		});
		assert.ok(owned.includes(childA));
		assert.ok(owned.includes(grandA), "descendants of session-owned children are included");
		assert.ok(owned.includes(linkedOnly), "explicit linked children are included");
		assert.ok(!owned.includes(childB), "other session children must not be owned");
	});

	it("agent actor owns descendant subtree only", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const parentId = `parent_${randomUUID().slice(0, 6)}`;
		const childId = `child_${randomUUID().slice(0, 6)}`;
		const otherId = `other_${randomUUID().slice(0, 6)}`;
		seedAgent(db, { id: parentId, projectKey });
		seedAgent(db, { id: childId, projectKey, parentAgentId: parentId });
		seedAgent(db, { id: otherId, projectKey });

		const owned = computeParentOwnedAgentIds(db, {
			actor: resolveAgentActorContext(db, { currentAgentId: parentId }),
			projectKey,
		});
		assert.deepEqual(owned.sort(), [childId].sort());
	});
});

describe("resolveOwnedSubjectIdsFromParts (scope composition)", () => {
	it("maps scopes without fall-open", () => {
		const parentOwned = ["a", "b"];
		const linked = ["c"];
		const parts = {
			parentOwnedIds: parentOwned,
			linkedChildIds: linked,
			listDescendants: (ids: string[]) => (ids.includes("c") ? ["c-child"] : []),
		};
		assert.equal(resolveOwnedSubjectIdsFromParts("all", parts), null);
		assert.deepEqual(resolveOwnedSubjectIdsFromParts("current_project", parts), parentOwned);
		assert.deepEqual(resolveOwnedSubjectIdsFromParts("current_session", parts), parentOwned);
		assert.equal(
			resolveOwnedSubjectIdsFromParts("current_project", parts),
			resolveOwnedSubjectIdsFromParts("current_session", parts),
			"current_project ≡ current_session owned subject ids",
		);
		assert.deepEqual(resolveOwnedSubjectIdsFromParts("descendants", parts)?.sort(), ["c", "c-child"].sort());
		assert.deepEqual(
			resolveOwnedSubjectIdsFromParts("descendants", { ...parts, linkedChildIds: [] }),
			[],
			"empty linked must not fall open",
		);
		// resolveRootInboxSenderIds mapping: all → undefined (no pin); empty → [] fail-closed.
		assert.equal(rootInboxSenderIdsFromOwned(null), undefined);
		assert.deepEqual(rootInboxSenderIdsFromOwned([]), []);
		assert.deepEqual(rootInboxSenderIdsFromOwned(parentOwned), parentOwned);
	});
});

describe("parent-owned messaging isolation", () => {
	it("composed root inbox (current_project) cannot see another session's child mail", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const sessionA = `sess_a_${randomUUID().slice(0, 6)}`;
		const sessionB = `sess_b_${randomUUID().slice(0, 6)}`;
		const childA = `child_a_${randomUUID().slice(0, 6)}`;
		const childB = `child_b_${randomUUID().slice(0, 6)}`;
		seedAgent(db, { id: childA, projectKey, spawnSessionId: sessionA, spawnSessionFile: `/tmp/${sessionA}.jsonl` });
		seedAgent(db, { id: childB, projectKey, spawnSessionId: sessionB, spawnSessionFile: `/tmp/${sessionB}.jsonl` });

		publishToRecipient(db, { senderId: childA, projectKey, recipient: { kind: "root" }, summary: "from A" });
		publishToRecipient(db, { senderId: childB, projectKey, recipient: { kind: "root" }, summary: "from B" });

		const rootActor = createRootActorContext({ projectKey, spawnSessionId: sessionA, spawnSessionFile: `/tmp/${sessionA}.jsonl` });
		const ownedSenderIds = composeRootInboxSenderIds(db, "current_project", {
			actor: rootActor,
			projectKey,
			spawnSessionId: sessionA,
			spawnSessionFile: `/tmp/${sessionA}.jsonl`,
		});
		assert.ok(ownedSenderIds);
		const inboxA = fetchAgentInboxV2(db, {
			actor: rootActor,
			projectKey,
			senderAgentIds: ownedSenderIds!,
			markRead: false,
			limit: 20,
		});
		assert.equal(inboxA.length, 1);
		assert.equal(inboxA[0]!.message.summary, "from A");

		const empty = fetchAgentInboxV2(db, {
			actor: rootActor,
			projectKey,
			senderAgentIds: [],
			markRead: false,
			limit: 20,
		});
		assert.equal(empty.length, 0, "empty sender allow-list must not fall open");
	});

	it("composed root inbox (descendants) includes linked subtree only", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const linked = `linked_${randomUUID().slice(0, 6)}`;
		const grand = `grand_${randomUUID().slice(0, 6)}`;
		const outsider = `out_${randomUUID().slice(0, 6)}`;
		const sessionOwned = `sess_child_${randomUUID().slice(0, 6)}`;
		const sessionId = `sess_${randomUUID().slice(0, 6)}`;
		seedAgent(db, { id: linked, projectKey, spawnSessionId: "sess-linked" });
		seedAgent(db, { id: grand, projectKey, parentAgentId: linked, spawnSessionId: "sess-grand" });
		seedAgent(db, { id: outsider, projectKey, spawnSessionId: "sess-out" });
		seedAgent(db, { id: sessionOwned, projectKey, spawnSessionId: sessionId, spawnSessionFile: `/tmp/${sessionId}.jsonl` });

		publishToRecipient(db, { senderId: linked, projectKey, recipient: { kind: "root" }, summary: "linked" });
		publishToRecipient(db, { senderId: grand, projectKey, recipient: { kind: "root" }, summary: "grand" });
		publishToRecipient(db, { senderId: outsider, projectKey, recipient: { kind: "root" }, summary: "outsider" });
		publishToRecipient(db, { senderId: sessionOwned, projectKey, recipient: { kind: "root" }, summary: "session" });

		const rootActor = createRootActorContext({
			projectKey,
			spawnSessionId: sessionId,
			spawnSessionFile: `/tmp/${sessionId}.jsonl`,
		});
		// descendants scope must NOT expand to full parent-owned tree (session child stays out).
		const ownedSenderIds = composeRootInboxSenderIds(db, "descendants", {
			actor: rootActor,
			projectKey,
			spawnSessionId: sessionId,
			spawnSessionFile: `/tmp/${sessionId}.jsonl`,
			linkedChildIds: [linked],
		});
		assert.ok(ownedSenderIds);
		assert.ok(ownedSenderIds!.includes(linked));
		assert.ok(ownedSenderIds!.includes(grand));
		assert.ok(!ownedSenderIds!.includes(outsider));
		assert.ok(!ownedSenderIds!.includes(sessionOwned), "descendants scope ignores session-owned non-linked agents");

		const inbox = fetchAgentInboxV2(db, {
			actor: rootActor,
			projectKey,
			senderAgentIds: ownedSenderIds!,
			markRead: false,
			limit: 20,
		});
		assert.deepEqual(inbox.map((row) => row.message.summary).sort(), ["grand", "linked"]);
	});

	it("default audience owner kinds match root surface constant (fail-closed)", () => {
		assert.deepEqual(attentionOwnerKindsForAudience(undefined), [...ROOT_SURFACE_OWNER_KINDS]);
		assert.deepEqual(attentionOwnerKindsForAudience("coordinator"), ["root"]);
		assert.equal(attentionOwnerKindsForAudience("all"), undefined);
	});

	it("agent-parent attention is not root coordinator audience", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const parentId = `parent_${randomUUID().slice(0, 6)}`;
		const childId = `child_${randomUUID().slice(0, 6)}`;
		seedAgent(db, { id: parentId, projectKey });
		seedAgent(db, { id: childId, projectKey, parentAgentId: parentId });

		publishToRecipient(db, {
			senderId: childId,
			projectKey,
			recipient: { kind: "agent", agentId: parentId },
			summary: "for parent only",
		});

		const rootOwned = listAgentAttentionItemsV2(db, {
			projectKey,
			ownerKinds: attentionOwnerKindsForAudience(undefined),
			states: ["waiting_on_owner"],
			limit: 20,
		});
		assert.equal(rootOwned.length, 0, "root surface owner kinds must not include agent-owned attention");

		const parentOwned = listAgentAttentionItemsV2(db, {
			projectKey,
			ownerKind: "agent",
			ownerAgentId: parentId,
			states: ["waiting_on_owner"],
			limit: 20,
		});
		assert.equal(parentOwned.length, 1);
		assert.equal(attentionV2MatchesAudience(parentOwned[0]!, "coordinator"), false);

		const parentInbox = fetchAgentInboxV2(db, {
			actor: resolveAgentActorContext(db, { currentAgentId: parentId }),
			markRead: false,
			limit: 20,
		});
		assert.equal(parentInbox.length, 1);
		assert.equal(parentInbox[0]!.message.senderAgentId, childId);
	});

	it("wake/attention composition pins subjects via ownership seam", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const sessionA = `sess_a_${randomUUID().slice(0, 6)}`;
		const childA = `child_a_${randomUUID().slice(0, 6)}`;
		const childB = `child_b_${randomUUID().slice(0, 6)}`;
		seedAgent(db, { id: childA, projectKey, spawnSessionId: sessionA, spawnSessionFile: `/tmp/${sessionA}.jsonl` });
		seedAgent(db, { id: childB, projectKey, spawnSessionId: "sess-b" });
		publishToRecipient(db, { senderId: childA, projectKey, recipient: { kind: "root" }, summary: "A asks" });
		publishToRecipient(db, { senderId: childB, projectKey, recipient: { kind: "root" }, summary: "B asks" });

		const rootActor = createRootActorContext({
			projectKey,
			spawnSessionId: sessionA,
			spawnSessionFile: `/tmp/${sessionA}.jsonl`,
		});
		const subjects = composeRootInboxSenderIds(db, "current_session", {
			actor: rootActor,
			projectKey,
			spawnSessionId: sessionA,
			spawnSessionFile: `/tmp/${sessionA}.jsonl`,
		});
		assert.ok(subjects);
		const wakeItems = listAgentAttentionItemsV2(db, {
			projectKey,
			ownerKinds: attentionOwnerKindsForAudience(undefined),
			subjectAgentIds: subjects!,
			states: ["waiting_on_owner"],
			limit: 25,
		});
		assert.equal(wakeItems.length, 1);
		assert.equal(wakeItems[0]!.subjectAgentId, childA);
	});

	it("current_session attention keeps linked-child + descendant without spawn-session AND", () => {
		const db = new DatabaseSync(":memory:");
		bootstrapMeepoDatabase(db);
		const projectKey = `proj_${randomUUID().slice(0, 8)}`;
		const sessionId = `sess_${randomUUID().slice(0, 6)}`;
		const sessionFile = `/tmp/${sessionId}.jsonl`;
		const sessionChild = `sess_child_${randomUUID().slice(0, 6)}`;
		const linked = `linked_${randomUUID().slice(0, 6)}`;
		const grand = `grand_${randomUUID().slice(0, 6)}`;
		const outsider = `out_${randomUUID().slice(0, 6)}`;

		// Linked + descendant intentionally carry foreign spawn sessions — stacking spawn-session
		// filters on top of the ownership pin would drop them from attention/list surfaces.
		seedAgent(db, { id: sessionChild, projectKey, spawnSessionId: sessionId, spawnSessionFile: sessionFile });
		seedAgent(db, { id: linked, projectKey, spawnSessionId: "sess-linked", spawnSessionFile: "/tmp/sess-linked.jsonl" });
		seedAgent(db, { id: grand, projectKey, parentAgentId: linked, spawnSessionId: "sess-grand", spawnSessionFile: "/tmp/sess-grand.jsonl" });
		seedAgent(db, { id: outsider, projectKey, spawnSessionId: "sess-out" });

		publishToRecipient(db, { senderId: sessionChild, projectKey, recipient: { kind: "root" }, summary: "session child" });
		publishToRecipient(db, { senderId: linked, projectKey, recipient: { kind: "root" }, summary: "linked child" });
		publishToRecipient(db, { senderId: grand, projectKey, recipient: { kind: "root" }, summary: "descendant" });
		publishToRecipient(db, { senderId: outsider, projectKey, recipient: { kind: "root" }, summary: "outsider" });

		const rootActor = createRootActorContext({ projectKey, spawnSessionId: sessionId, spawnSessionFile: sessionFile });
		const owned = composeRootInboxSenderIds(db, "current_session", {
			actor: rootActor,
			projectKey,
			spawnSessionId: sessionId,
			spawnSessionFile: sessionFile,
			linkedChildIds: [linked],
		});
		assert.ok(owned);
		assert.ok(owned!.includes(sessionChild));
		assert.ok(owned!.includes(linked), "linked child must be in current_session owned set");
		assert.ok(owned!.includes(grand), "descendant of linked child must be in current_session owned set");
		assert.ok(!owned!.includes(outsider));

		// Filter builders must pin owned ids only — never re-add spawnSession* (board-style).
		const attentionFilters = withOwnedSubjectPin(
			{ limit: 25 },
			"current_session",
			owned,
			{ projectKey, idField: "agentIds" },
		);
		const agentFilters = withOwnedSubjectPin(
			{ limit: 25 },
			"current_session",
			owned,
			{ projectKey, idField: "ids" },
		);
		const v2Filters = withOwnedSubjectPin(
			{ ownerKinds: attentionOwnerKindsForAudience(undefined), limit: 25 },
			"current_session",
			owned,
			{ projectKey, idField: "subjectAgentIds" },
		);
		assert.equal("spawnSessionId" in attentionFilters, false);
		assert.equal("spawnSessionFile" in attentionFilters, false);
		assert.equal("spawnSessionId" in agentFilters, false);
		assert.equal("spawnSessionId" in v2Filters, false);
		assert.equal("projectKey" in attentionFilters, false, "current_session must not force projectKey either");
		assert.deepEqual(attentionFilters.agentIds?.sort(), owned!.slice().sort());
		assert.deepEqual(agentFilters.ids?.sort(), owned!.slice().sort());
		assert.deepEqual(v2Filters.subjectAgentIds?.sort(), owned!.slice().sort());

		// current_project gets the same owned id set (intentional equivalence) plus projectKey.
		const projectPin = withOwnedSubjectPin({ limit: 25 }, "current_project", owned, {
			projectKey,
			idField: "agentIds",
		});
		assert.equal(projectPin.projectKey, projectKey);
		assert.deepEqual(projectPin.agentIds?.sort(), owned!.slice().sort());
		assert.equal("spawnSessionId" in projectPin, false);

		const wakeItems = listAgentAttentionItemsV2(db, {
			...v2Filters,
			states: ["waiting_on_owner"],
		});
		assert.deepEqual(
			wakeItems.map((item) => item.summary).sort(),
			["descendant", "linked child", "session child"],
			"ownership pin without spawn-session AND must keep linked + descendant attention",
		);
	});
});
