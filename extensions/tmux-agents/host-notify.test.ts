import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
	buildHostNotifyInput,
	mapAttentionKindToHostNotifyKind,
	maybeNotifyHostAttention,
} from "./host-notify.js";
import { freezeProcessHost, resetProcessHostForTests, type HostNotifyInput, type ProcessHost } from "./process-host.js";

afterEach(() => {
	resetProcessHostForTests();
});

describe("host-notify mapping", () => {
	it("maps attention kinds to host notify kinds", () => {
		assert.equal(mapAttentionKindToHostNotifyKind("question"), "question");
		assert.equal(mapAttentionKindToHostNotifyKind("question_for_user"), "question");
		assert.equal(mapAttentionKindToHostNotifyKind("blocked"), "blocker");
		assert.equal(mapAttentionKindToHostNotifyKind("complete"), "complete");
		assert.equal(mapAttentionKindToHostNotifyKind("milestone"), null);
		assert.equal(mapAttentionKindToHostNotifyKind("note"), null);
	});

	it("builds policy titles from display names", () => {
		assert.deepEqual(
			buildHostNotifyInput({
				kind: "question_for_user",
				agentId: "sa_1",
				summary: "Need the API path",
				displayName: "research-herdr",
			}),
			{
				kind: "question",
				title: "Question: research-herdr",
				body: "Need the API path",
				rateKey: "sa_1",
			},
		);
		assert.equal(
			buildHostNotifyInput({
				kind: "blocked",
				agentId: "sa_2",
				summary: "stuck",
				displayName: "worker-a",
				taskTitle: "Ship auth",
			})?.title,
			"Blocked: worker-a",
		);
		assert.equal(
			buildHostNotifyInput({
				kind: "complete",
				agentId: "sa_3",
				summary: "done",
				displayName: null,
			})?.title,
			"Done: sa_3",
		);
		assert.equal(
			buildHostNotifyInput({
				kind: "milestone",
				agentId: "sa_4",
				summary: "progress",
			}),
			null,
		);
	});

	it("maybeNotifyHostAttention calls frozen host notify", async () => {
		const seen: HostNotifyInput[] = [];
		const host: ProcessHost = {
			hostKind: "herdr",
			isAvailable: async () => true,
			spawnWindow: async () => {
				throw new Error("unused");
			},
			getCurrentTarget: async () => null,
			focus: async () => ({ focused: false, command: "" }),
			stop: async () => ({ stopped: false, graceful: true, command: "" }),
			capture: async () => ({ content: "", command: "" }),
			listInventory: async () => ({ primaryIds: new Set(), displayNames: new Set() }),
			targetExists: async () => false,
			notify: async (input) => {
				seen.push(input);
			},
		};
		freezeProcessHost(host);
		await maybeNotifyHostAttention({
			kind: "complete",
			agentId: "sa_z",
			summary: "handoff",
			displayName: "done-agent",
		});
		assert.equal(seen.length, 1);
		assert.equal(seen[0]?.kind, "complete");
		assert.equal(seen[0]?.title, "Done: done-agent");
	});

	it("maybeNotifyHostAttention no-ops without frozen host", async () => {
		await assert.doesNotReject(() =>
			maybeNotifyHostAttention({
				kind: "question",
				agentId: "sa_none",
				summary: "hello",
			}),
		);
	});
});
