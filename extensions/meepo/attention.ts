/**
 * Attention: inbox snapshot → notify / wake.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { maybeNotifyHostAttention } from "./host-notify.js";
import { listOpenAttention } from "./inbox.js";
import { listAgents } from "./registry.js";
import { attentionItemIcon, formatAttentionWakeup } from "./formatters.js";
import { childRuntimeEnvironment, resolveAttentionFilters } from "./session-scope.js";
import { resolveAdminAttentionV2Filters } from "./task-interactions.js";
import type { AgentAttentionV2Record, AttentionItemRecord } from "./types.js";

export const ATTENTION_WAKE_POLL_MS = 2000;
export let attentionWakePoll: ReturnType<typeof setInterval> | undefined;
export function setAttentionWakePoll(timer: ReturnType<typeof setInterval> | undefined): void {
	attentionWakePoll = timer;
}
export const sentCoordinatorAttentionIds = new Set<string>();
export const notifiedUserAttentionIds = new Set<string>();
/** Attention item ids that already triggered a ProcessHost toast (herdr). */
export const hostNotifiedAttentionIds = new Set<string>();

export function attentionItemFromV2(item: AgentAttentionV2Record): AttentionItemRecord {
	return {
		id: item.id,
		messageId: item.messageId,
		agentId: item.subjectAgentId ?? "unknown",
		threadId: item.subjectAgentId ?? item.id,
		projectKey: item.projectKey,
		spawnSessionId: null,
		spawnSessionFile: null,
		audience: item.ownerKind === "user" ? "user" : "coordinator",
		kind: (item.kind === "approval" || item.kind === "change_request" ? "question" : item.kind) as AttentionItemRecord["kind"],
		priority: item.priority,
		state:
			item.state === "waiting_on_owner"
				? item.ownerKind === "user"
					? "waiting_on_user"
					: "waiting_on_coordinator"
				: (item.state as AttentionItemRecord["state"]),
		summary: item.summary,
		payload: item.payload,
		createdAt: item.createdAt,
		updatedAt: item.updatedAt,
		resolvedAt: item.resolvedAt,
		resolutionKind: item.resolutionKind,
		resolutionSummary: item.resolutionSummary,
	};
}

export async function wakeCoordinatorFromAttention(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (childRuntimeEnvironment) return;
	const db = getMeepoDb();
	const v2Filters = resolveAdminAttentionV2Filters(ctx, "current_session", {
		limit: 25,
		states: ["open", "acknowledged", "waiting_on_owner"],
	});
	if (v2Filters.subjectAgentIds && v2Filters.subjectAgentIds.length === 0) return;
	const legacyFilters = resolveAttentionFilters(ctx, "current_session", {
		limit: 25,
		states: ["open", "waiting_on_coordinator", "waiting_on_user"],
	});
	const { v2: v2Items, leftover: legacyItems } = listOpenAttention(db, { v2: v2Filters, legacy: legacyFilters });
	const items = [...v2Items.map(attentionItemFromV2), ...legacyItems].sort(
		(a, b) => b.priority - a.priority || a.createdAt - b.createdAt,
	);
	if (items.length === 0) return;
	const ownedSubjectIds = v2Filters.subjectAgentIds ?? legacyFilters.agentIds ?? [];
	const agents = new Map(
		(ownedSubjectIds.length > 0
			? listAgents(db, { ids: ownedSubjectIds, limit: Math.max(ownedSubjectIds.length, 1) })
			: []
		).map((agent) => [agent.id, agent]),
	);

	for (const item of items) {
		const agent = agents.get(item.agentId);
		if (!hostNotifiedAttentionIds.has(item.id)) {
			hostNotifiedAttentionIds.add(item.id);
			void maybeNotifyHostAttention({
				kind: item.kind,
				agentId: item.agentId,
				summary: item.summary,
				displayName: agent?.host?.displayName ?? agent?.title ?? null,
			}).catch(() => {});
		}
		if (item.audience === "user") {
			if (notifiedUserAttentionIds.has(item.id)) continue;
			try {
				ctx.ui.notify(`${attentionItemIcon(item)} ${agent?.title ?? item.agentId} · ${item.summary}`, item.kind === "question_for_user" ? "warning" : "info");
				notifiedUserAttentionIds.add(item.id);
			} catch (error) {
				notifiedUserAttentionIds.delete(item.id);
				throw error;
			}
			continue;
		}
		if (sentCoordinatorAttentionIds.has(item.id)) continue;
		sentCoordinatorAttentionIds.add(item.id);
		const content = formatAttentionWakeup(item, agent);
		try {
			if (ctx.isIdle()) {
				await pi.sendUserMessage(content);
			} else {
				await pi.sendUserMessage(content, { deliverAs: item.kind === "complete" ? "followUp" : "steer" });
			}
		} catch (error) {
			sentCoordinatorAttentionIds.delete(item.id);
			throw error;
		}
		break;
	}
}
