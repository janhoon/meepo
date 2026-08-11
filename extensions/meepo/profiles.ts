import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { getActiveProfileLoadOptions, setActiveProfileLoadOptions } from "./profile-load-options.js";
import { buildProfileFieldsFromFrontmatter } from "./profile-metadata.js";
import {
	getAllowedBuiltinToolNames,
	mergeProfilesByName,
	normalizeBuiltinTools,
	type NormalizeToolsOptions,
} from "./profile-tools.js";
import type { SubagentProfile } from "./types.js";

export {
	getActiveProfileLoadOptions,
	setActiveProfileLoadOptions,
	getAllowedBuiltinToolNames,
	mergeProfilesByName,
	normalizeBuiltinTools,
};
export type { NormalizeToolsOptions };

function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Historical path for a package-local `agents/` folder next to the extension.
 * Meepo does **not** ship agent profiles and does **not** load this path by default.
 * Consumers who vendor their own agent pack may still point `profiles.dirs` here.
 */
export function getPackageProfilesDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");
}

/** @deprecated Prefer getUserProfilesDir + listProfilesFromDirs. Meepo is BYO profiles. */
export function getProfilesDir(): string {
	return getUserProfilesDir();
}

/** Consumer Pi agents dir (`~/.pi/agent/agents` by default). */
export function getUserProfilesDir(): string {
	return join(getAgentDir(), "agents");
}

/**
 * Resolve ordered profile directories (bring-your-own agents).
 * - If `dirs` / active config is non-empty, those paths are used in order (later shadows earlier by name).
 * - If empty, only the consumer Pi agents dir (`getAgentDir()/agents`, usually `~/.pi/agent/agents`).
 * Meepo never injects package-bundled role prompts into this list.
 * Missing directories are skipped.
 */
export function resolveProfileDirs(dirs?: string[]): string[] {
	const active = getActiveProfileLoadOptions();
	const configured = dirs && dirs.length > 0 ? dirs : active.dirs;
	const ordered =
		configured.length > 0
			? configured.map((d) => resolve(d))
			: [getUserProfilesDir()];
	return ordered.filter((dir) => isDirectory(dir));
}

/**
 * Build a SubagentProfile from frontmatter + body.
 * Throws when lease/canSpawn values are invalid.
 */
export function profileFromFrontmatter(
	frontmatter: Record<string, unknown>,
	body: string,
	filePath: string,
	toolOptions?: NormalizeToolsOptions,
): SubagentProfile | null {
	const fields = buildProfileFieldsFromFrontmatter(frontmatter, body);
	if (!fields) return null;
	return {
		name: fields.name,
		description: fields.description,
		systemPrompt: fields.systemPrompt,
		tools: normalizeBuiltinTools(fields.toolNames, toolOptions),
		model: fields.model,
		filePath,
		roleKey: fields.roleKey,
		lease: fields.lease,
		canSpawn: fields.canSpawn,
	};
}

export function loadProfilesFromDir(
	profilesDir: string,
	toolOptions?: NormalizeToolsOptions,
): SubagentProfile[] {
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
			const profile = profileFromFrontmatter(frontmatter, body, filePath, toolOptions);
			if (profile) profiles.push(profile);
		} catch (error) {
			throw new Error(
				`Invalid profile metadata in ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}
	return profiles;
}

export function listProfilesFromDirs(
	dirs?: string[],
	toolOptions?: NormalizeToolsOptions,
): SubagentProfile[] {
	const resolved = resolveProfileDirs(dirs);
	const layers = resolved.map((dir) => loadProfilesFromDir(dir, toolOptions));
	return mergeProfilesByName(layers);
}

export function listSubagentProfiles(): SubagentProfile[] {
	const active = getActiveProfileLoadOptions();
	return listProfilesFromDirs(undefined, {
		extraTools: active.extraTools,
		allowUnknownTools: active.allowUnknownTools,
	});
}

export function getSubagentProfile(name: string): SubagentProfile | null {
	return listSubagentProfiles().find((profile) => profile.name === name) ?? null;
}
