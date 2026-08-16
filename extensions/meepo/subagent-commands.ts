/**
 * Slash commands mirroring Pi's `/skill:name` UX for consumer agent profiles.
 *
 * Each profile registers as `/subagent:<profile-name>` so autocomplete lists
 * available agents the same way skills appear under `/skill:`.
 */
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { listSubagentProfiles } from "./profiles.js";
import { spawnChildFromParams } from "./spawn-ops.js";
import type { SubagentProfile } from "./types.js";

/** Prefix for profile slash commands (full name is `subagent:<profile>`). */
export const SUBAGENT_COMMAND_PREFIX = "subagent:" as const;

export function isSubagentProfileCommandName(commandName: string): boolean {
	return commandName.startsWith(SUBAGENT_COMMAND_PREFIX);
}

export function subagentCommandNameForProfile(profileName: string): string {
	return `${SUBAGENT_COMMAND_PREFIX}${profileName.trim()}`;
}

export function profileNameFromSubagentCommand(commandName: string): string | null {
	if (!isSubagentProfileCommandName(commandName)) return null;
	const name = commandName.slice(SUBAGENT_COMMAND_PREFIX.length).trim();
	return name || null;
}

/** Build a short child title from free-text task args. */
export function titleFromSubagentTaskArgs(profileName: string, task: string): string {
	const firstLine = task
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find(Boolean);
	if (!firstLine) return profileName;
	const max = 72;
	const clipped = firstLine.length > max ? `${firstLine.slice(0, max - 1)}…` : firstLine;
	return clipped;
}

/**
 * Resolve the task prompt for `/subagent:name [args]`.
 * - With args: args are the task body (like `/skill:name args`).
 * - Without args + UI: open an editor for the task.
 * - Without args + no UI: null (caller should show usage).
 */
export async function resolveSubagentCommandTask(
	ctx: ExtensionContext,
	profile: SubagentProfile,
	args: string | undefined,
): Promise<string | null> {
	const fromArgs = args?.trim() ?? "";
	if (fromArgs) return fromArgs;
	if (!ctx.hasUI) return null;
	const drafted = await ctx.ui.editor(`Task for ${profile.name}`, "");
	const text = drafted?.trim() ?? "";
	return text || null;
}

export async function handleSubagentProfileCommand(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	profile: SubagentProfile,
	args: string | undefined,
): Promise<void> {
	const task = await resolveSubagentCommandTask(ctx, profile, args);
	if (!task) {
		ctx.ui.notify(
			`Usage: /subagent:${profile.name} <task>\nOr run with UI to draft the task in an editor.`,
			"warning",
		);
		return;
	}

	const title = titleFromSubagentTaskArgs(profile.name, task);
	try {
		const result = await spawnChildFromParams(pi, ctx, {
			title,
			task,
			profile: profile.name,
			cwd: ctx.cwd,
		});
		// Notify only — do not open ui.editor with the spawn dump. That replaces the
		// parent composer with the result text and feels like the task was "pasted"
		// back into the current pi input instead of going to the child.
		ctx.ui.notify(
			`Spawned ${result.agentId} (${profile.name}) on ${result.hostKind ?? "host"} (${result.hostDisplayName ?? result.hostPrimaryId ?? result.tmuxSessionName ?? "?"}). RPC bridge launching — task will deliver when the child is ready.`,
			"info",
		);
	} catch (error) {
		ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
	}
}

/** Register one `/subagent:<name>` command per consumer profile currently on disk. */
export function registerSubagentProfileCommands(pi: ExtensionAPI): void {
	const profiles = listSubagentProfiles();
	for (const profile of profiles) {
		const name = subagentCommandNameForProfile(profile.name);
		pi.registerCommand(name, {
			description: profile.description || `Spawn consumer profile ${profile.name}`,
			handler: async (commandArgs, ctx) => {
				await handleSubagentProfileCommand(pi, ctx, profile, commandArgs);
			},
		});
	}
}
