/**
 * Meepo coordinator: tool modules + lifecycle. Slash commands live in coordinator-commands.ts.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { startAttentionWake, stopAttentionWake, wakeCoordinatorFromAttention } from "./attention.js";
import type { AgentsBoardState } from "./board.js";
import { deliverQueuedMessagesViaBridge } from "./bridge-delivery.js";
import { listCleanupCandidates, reconcileAgents, stopAgentById } from "./child-fleet.js";
import { registerChildRuntime } from "./child-runtime.js";
import { LEGACY_SERVICE_TOOL_ALIASES } from "./config.js";
import { registerCoordinatorCommands } from "./coordinator-commands.js";
import { setActiveMeepoRuntime, updateFleetUi } from "./coordinator-session.js";
import type { AgentsDashboardState } from "./dashboard.js";
import { closeMeepoDb, getMeepoDb } from "./db.js";
import { applyNoWaitSystemPrompt, getBashCommandFromToolInput, noWaitBashBlockReason } from "./no-wait-policy.js";
import { getProjectKey } from "./project.js";
import { listAgents } from "./registry.js";
import type { MeepoRuntime } from "./runtime.js";
import { childRuntimeEnvironment } from "./session-scope.js";
import { registerSubagentProfileCommands } from "./subagent-commands.js";
import { configureSubtreeControlDeps } from "./subtree-control.js";
import { reconcileTasks } from "./task-registry.js";
import { register as registerAgentTools } from "./tools/agent-tools.js";
import { register as registerServiceTools } from "./tools/service-tools.js";
import { register as registerTaskTools } from "./tools/task-tools.js";

export function registerMeepoCoordinatorTools(pi: ExtensionAPI, runtime: MeepoRuntime): void {
	setActiveMeepoRuntime(runtime);
	configureSubtreeControlDeps({ stopAgentById, listCleanupCandidates });
	const registerTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0]): void => {
		pi.registerTool(tool);
		const legacy = (Object.entries(LEGACY_SERVICE_TOOL_ALIASES) as Array<[string, string]>).find(
			([, canonical]) => canonical === tool.name,
		)?.[0];
		if (legacy) {
			pi.registerTool({
				...tool,
				name: legacy,
				label: `${typeof tool.label === "string" ? tool.label : legacy} (legacy alias)`,
			});
		}
	};
	const noWaitMode = runtime.config.policies.noWait;
	if (childRuntimeEnvironment) {
		registerChildRuntime(pi, childRuntimeEnvironment, { noWaitMode });
	} else {
		pi.on("before_agent_start", async (event) => ({
			systemPrompt: applyNoWaitSystemPrompt(event.systemPrompt, noWaitMode),
		}));
		pi.on("tool_call", (event) => {
			if (event.toolName !== "bash") return;
			const command = getBashCommandFromToolInput(event.input);
			if (!command) return;
			const reason = noWaitBashBlockReason(command, noWaitMode);
			if (!reason) return;
			return { block: true, reason };
		});
	}

	const commandState: { dashboardState: AgentsDashboardState; boardState: AgentsBoardState } = {
		dashboardState: {
			scope: "current_project",
			sort: "priority",
			activeOnly: false,
			blockedOnly: false,
			unreadOnly: false,
		},
		boardState: {
			scope: "current_project",
		},
	};

	registerAgentTools(registerTool, pi);
	registerTaskTools(registerTool, pi);
	registerServiceTools(registerTool, pi);
	registerSubagentProfileCommands(pi);
	registerCoordinatorCommands(pi, commandState);

	pi.on("session_start", async (_event, ctx) => {
		if (childRuntimeEnvironment) return;
		const db = getMeepoDb();
		await reconcileAgents(ctx, { scope: "current_project", activeOnly: false, limit: 200 }).catch(() => {});
		reconcileTasks(db, { projectKey: getProjectKey(ctx.cwd), limit: 500 });
		const activeAgents = listAgents(db, { projectKey: getProjectKey(ctx.cwd), activeOnly: true, limit: 200 });
		for (const agent of activeAgents) {
			if (agent.transportKind === "rpc_bridge") {
				void deliverQueuedMessagesViaBridge(agent.id);
			}
		}
		startAttentionWake(pi, ctx);
		await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		updateFleetUi(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (childRuntimeEnvironment) return;
		await wakeCoordinatorFromAttention(pi, ctx).catch(() => {});
		updateFleetUi(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopAttentionWake();
		closeMeepoDb();
	});
}
