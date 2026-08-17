/**
 * Map Meepo attention / publish events onto ProcessHost.notify (herdr toasts).
 * Policy: wayfinder #19 — question / blocker / complete only; tmux no-ops.
 */

import type { HostNotifyInput } from "./process-host.js";
import { getFrozenProcessHost } from "./process-host.js";

export type HostNotifyAttentionKind = "question" | "question_for_user" | "blocked" | "complete";

export interface HostNotifyAttentionInput {
	kind: string;
	/** Meepo agent id — used as rateKey. */
	agentId: string;
	summary: string;
	/** Prefer host display name, then agent title, then agentId. */
	displayName?: string | null;
	/** Optional task title for blocker titles. */
	taskTitle?: string | null;
}

/** Map attention kind → host notify kind. Returns null when no toast should fire. */
export function mapAttentionKindToHostNotifyKind(
	kind: string,
): HostNotifyInput["kind"] | null {
	switch (kind) {
		case "question":
		case "question_for_user":
			return "question";
		case "blocked":
			return "blocker";
		case "complete":
			return "complete";
		default:
			return null;
	}
}

export function buildHostNotifyInput(input: HostNotifyAttentionInput): HostNotifyInput | null {
	const kind = mapAttentionKindToHostNotifyKind(input.kind);
	if (!kind) return null;

	const label =
		(input.displayName && input.displayName.trim()) ||
		(kind === "blocker" && input.taskTitle?.trim()) ||
		input.agentId;

	const title =
		kind === "question"
			? `Question: ${label}`
			: kind === "blocker"
				? `Blocked: ${label}`
				: `Done: ${label}`;

	return {
		kind,
		title,
		body: input.summary,
		rateKey: input.agentId,
	};
}

/**
 * Best-effort host toast for an attention event.
 * No-op when ProcessHost is not frozen, notify is missing, or kind is not user-facing.
 */
export async function maybeNotifyHostAttention(input: HostNotifyAttentionInput): Promise<void> {
	const host = getFrozenProcessHost();
	if (!host) return;
	const payload = buildHostNotifyInput(input);
	if (!payload) return;
	try {
		await host.notify(payload);
	} catch {
		// Soft-fail — never break attention wake on toast errors.
	}
}
