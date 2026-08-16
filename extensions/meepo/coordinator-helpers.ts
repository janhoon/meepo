/**
 * Compatibility barrel. Prefer Child fleet, Attention, Board, and session-scope directly.
 */
export * from "./session-scope.js";
export {
	lastFocusedActiveAgentId,
	setActiveMeepoRuntime,
	setLastFocusedActiveAgentId,
	updateFleetUi,
	activeMeepoRuntime,
} from "./coordinator-session.js";
export {
	ATTENTION_WAKE_POLL_MS,
	attentionItemFromV2,
	attentionWakePoll,
	hostNotifiedAttentionIds,
	notifiedUserAttentionIds,
	sentCoordinatorAttentionIds,
	setAttentionWakePoll,
	wakeCoordinatorFromAttention,
} from "./attention.js";
export * from "./task-interactions.js";
export * from "./child-fleet.js";
export * from "./service-ops.js";
export * from "./spawn-ops.js";
export * from "./board-projection.js";
export * from "./standup.js";
export * from "./formatters.js";
