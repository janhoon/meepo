import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { buildProfileFieldsFromFrontmatter } from "./profile-metadata.js";
import type { SubagentProfile } from "./types.js";

const DEFAULT_PROFILE_TOOLS = ["read", "bash", "edit", "write"];
const ALLOWED_BUILTIN_TOOLS = new Set([
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

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

export function getProfilesDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");
}

export function normalizeBuiltinTools(tools: string[] | undefined): string[] {
	const ordered = tools && tools.length > 0 ? tools : DEFAULT_PROFILE_TOOLS;
	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const tool of ordered) {
		const trimmed = tool.trim();
		if (!trimmed || seen.has(trimmed)) continue;
		if (!ALLOWED_BUILTIN_TOOLS.has(trimmed)) {
			throw new Error(
				`Unsupported child tool \"${trimmed}\". Allowed tools: ${Array.from(ALLOWED_BUILTIN_TOOLS).join(", ")}.`,
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
 * Build a SubagentProfile from frontmatter + body.
 * Throws when lease/canSpawn values are invalid.
 */
export function profileFromFrontmatter(
	frontmatter: Record<string, unknown>,
	body: string,
	filePath: string,
): SubagentProfile | null {
	const fields = buildProfileFieldsFromFrontmatter(frontmatter, body);
	if (!fields) return null;
	return {
		name: fields.name,
		description: fields.description,
		systemPrompt: fields.systemPrompt,
		tools: normalizeBuiltinTools(fields.toolNames),
		model: fields.model,
		filePath,
		roleKey: fields.roleKey,
		lease: fields.lease,
		canSpawn: fields.canSpawn,
	};
}

export function listSubagentProfiles(): SubagentProfile[] {
	const profilesDir = getProfilesDir();
	if (!isDirectory(profilesDir)) return [];
	const profiles: SubagentProfile[] = [];
	for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = join(profilesDir, entry.name);
		let content = "";
		try {
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		try {
			const profile = profileFromFrontmatter(frontmatter, body, filePath);
			if (profile) profiles.push(profile);
		} catch (error) {
			throw new Error(
				`Invalid profile metadata in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

export function getSubagentProfile(name: string): SubagentProfile | null {
	return listSubagentProfiles().find((profile) => profile.name === name) ?? null;
}

export function getAllowedBuiltinToolNames(): string[] {
	return Array.from(ALLOWED_BUILTIN_TOOLS);
}
