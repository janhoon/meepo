/**
 * Coordinator session state: active runtime, last-focused Child, fleet UI chrome.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { getMeepoDb } from "./db.js";
import { attentionItemIcon, attentionItemLabel, formatFleetSummary } from "./formatters.js";
import { listOpenAttention } from "./inbox.js";
import { getProjectKey } from "./project.js";
import { getFleetSummary, listAgents } from "./registry.js";
import type { MeepoRuntime } from "./runtime.js";
import { resolveAgentFilters, resolveAttentionFilters } from "./session-scope.js";
import { getTaskSummary, listTaskAttention } from "./task-registry.js";
import { truncateText } from "./text-util.js";

export let activeMeepoRuntime: MeepoRuntime | null = null;

export function setActiveMeepoRuntime(runtime: MeepoRuntime | null): void {
	activeMeepoRuntime = runtime;
}

export let lastFocusedActiveAgentId: string | undefined;
export function setLastFocusedActiveAgentId(id: string | undefined): void {
	lastFocusedActiveAgentId = id;
}

export function updateFleetUi(ctx: ExtensionContext): void {
	const db = getMeepoDb();
	const projectKey = getProjectKey(ctx.cwd);
	const taskSummary = getTaskSummary(db, { projectKey });
	const agentSummary = getFleetSummary(db, { projectKey });
	ctx.ui.setStatus("meepo", formatFleetSummary(taskSummary, agentSummary));
	const taskItems = listTaskAttention(db, { projectKey, limit: 4 });
	if (taskItems.length > 0) {
		ctx.ui.setWidget(
			"meepo",
			taskItems.map(
				(item) =>
					`${item.health === "stale" || item.health === "empty_or_no_progress" ? "⚠" : item.status === "blocked" ? "⛔" : "◍"} ${truncateText(item.title, 32)} · ${item.status} · health=${item.health}${item.waitingOn ? ` · ${item.waitingOn}` : ""}`,
			),
		);
		return;
	}
	const sessionFilters = resolveAttentionFilters(ctx, "current_session", {
		states: ["open", "acknowledged", "waiting_on_coordinator", "waiting_on_user"],
		limit: 4,
	});
	const attentionItems = listOpenAttention(db, {
		projectKey: sessionFilters.projectKey,
		childIds: sessionFilters.agentIds,
		audiences: sessionFilters.audiences,
		states: sessionFilters.states,
		limit: 4,
	});
	if (attentionItems.length === 0) {
		ctx.ui.setWidget("meepo", undefined);
		return;
	}
	const agents = new Map(
		listAgents(db, resolveAgentFilters(ctx, "current_session", { limit: 100 })).map((agent) => [agent.id, agent]),
	);
	const lines = attentionItems.map((item) => {
		const agent = agents.get(item.agentId);
		const title = agent ? truncateText(agent.title, 34) : item.agentId;
		return `${attentionItemIcon(item)} ${title} · ${attentionItemLabel(item)} · ${item.agentId}`;
	});
	ctx.ui.setWidget("meepo", lines);
}
