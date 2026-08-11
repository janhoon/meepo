/**
 * Coordinator helpers barrel (stable import path).
 *
 * session-scope is the sole source for filter/path helpers. coordinator-session also
 * re-exports them for direct imports, so it is listed after with care: Node/jiti
 * `export *` conflicts on duplicates — import session-scope names only from here via
 * the explicit session-scope export below, not via coordinator-session.
 */
export * from "./session-scope.js";
export {
	ATTENTION_WAKE_POLL_MS,
	attentionItemFromV2,
	attentionWakePoll,
	hostNotifiedAttentionIds,
	lastFocusedActiveAgentId,
	notifiedUserAttentionIds,
	sentCoordinatorAttentionIds,
	setActiveMeepoRuntime,
	setAttentionWakePoll,
	setLastFocusedActiveAgentId,
	updateFleetUi,
	wakeCoordinatorFromAttention,
	activeMeepoRuntime,
} from "./coordinator-session.js";
export * from "./task-interactions.js";
export * from "./agent-lifecycle.js";
export * from "./service-ops.js";
export * from "./spawn-ops.js";
export * from "./board-ops.js";
export * from "./standup.js";
// Formatting helpers live in formatters.ts; re-export so tools/coordinator can keep a stable import path.
export * from "./formatters.js";
