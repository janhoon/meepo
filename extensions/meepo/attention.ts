/**
 * Attention: inbox snapshot → notify / wake.
 * Coordinator watches attention.wake; publishers touch that file after a write.
 */
import { appendFileSync, watch, type FSWatcher } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { maybeNotifyHostAttention } from "./host-notify.js";
import { listOpenAttention } from "./inbox.js";
import { ensureMeepoRuntimePaths } from "./paths.js";
import { listAgents } from "./registry.js";
import { attentionItemIcon, formatAttentionWakeup } from "./formatters.js";
import { childRuntimeEnvironment, resolveOpenAttentionFilters } from "./session-scope.js";

const sentCoordinatorAttentionIds = new Set<string>();
const notifiedUserAttentionIds = new Set<string>();
const hostNotifiedAttentionIds = new Set<string>();
let attentionWakeWatcher: FSWatcher | undefined;

export async function wakeCoordinatorFromAttention(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (childRuntimeEnvironment) return;
	const db = getMeepoDb();
	const filters = resolveOpenAttentionFilters(ctx, "current_session", {
		limit: 25,
		states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
	});
	if (filters.childIds && filters.childIds.length === 0) return;
	const items = listOpenAttention(db, filters);
	if (items.length === 0) return;
	const ownedSubjectIds = filters.childIds ?? [];
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

export function startAttentionWake(pi: ExtensionAPI, ctx: ExtensionContext): void {
	stopAttentionWake();
	const { attentionWakeFile } = ensureMeepoRuntimePaths();
	try {
		appendFileSync(attentionWakeFile, "");
	} catch {
		return;
	}
	attentionWakeWatcher = watch(attentionWakeFile, () => {
		void wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
	});
}

export function stopAttentionWake(): void {
	attentionWakeWatcher?.close();
	attentionWakeWatcher = undefined;
}
