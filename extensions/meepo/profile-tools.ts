import { getActiveProfileLoadOptions } from "./profile-load-options.js";
import type { SubagentProfile } from "./types.js";

export const DEFAULT_PROFILE_TOOLS = ["read", "bash", "edit", "write"];

export const ALLOWED_BUILTIN_TOOLS = new Set([
	"read",
	"bash",
	"grep",
	"ls",
	"edit",
	"write",
	"task_create",
	"task_list",
	"task_get",
	"task_update",
	"task_move",
	"task_note",
	"task_link",
	"task_unlink",
	"task_links",
	"task_ready",
	"task_dispatch_ready",
	"task_attention",
	"subagent_list",
	"subagent_get",
	"subagent_inbox",
	"subagent_attention",
	"subagent_spawn",
	"subagent_message",
	"subagent_stop",
	"subagent_cleanup",
	"web_search",
	"code_search",
]);

/** Options for child tool allowlist normalization. */
export interface NormalizeToolsOptions {
	/** Extra tool names always allowed. */
	extraTools?: string[];
	/** When true, any non-empty tool name is accepted. */
	allowUnknownTools?: boolean;
}

export function normalizeBuiltinTools(
	tools: string[] | undefined,
	options: NormalizeToolsOptions = {},
): string[] {
	const active = getActiveProfileLoadOptions();
	const allowUnknown = options.allowUnknownTools ?? active.allowUnknownTools;
	const extra = new Set([...active.extraTools, ...(options.extraTools ?? [])]);
	const ordered = tools && tools.length > 0 ? tools : DEFAULT_PROFILE_TOOLS;
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const tool of ordered) {
		const trimmed = tool.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		const allowed = ALLOWED_BUILTIN_TOOLS.has(trimmed) || extra.has(trimmed) || allowUnknown;
		if (!allowed) {
			const extras = Array.from(extra);
			throw new Error(
				`Unsupported child tool \"${trimmed}\". Allowed tools: ${[
					...ALLOWED_BUILTIN_TOOLS,
					...extras,
				].join(", ")}${allowUnknown ? " (or any with allowUnknownTools)" : ""}.`,
			);
		}
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	if (normalized.length === 0) {
		return [...DEFAULT_PROFILE_TOOLS];
	}
	return normalized;
}

/**
 * Pure merge: later profiles with the same name replace earlier ones.
 * Input arrays are in directory order (earliest first).
 */
export function mergeProfilesByName(layers: SubagentProfile[][]): SubagentProfile[] {
	const byName = new Map<string, SubagentProfile>();
	for (const layer of layers) {
		for (const profile of layer) {
			byName.set(profile.name, profile);
		}
	}
	return Array.from(byName.values()).sort((left, right) => left.name.localeCompare(right.name));
}

export function getAllowedBuiltinToolNames(): string[] {
	return Array.from(ALLOWED_BUILTIN_TOOLS);
}
