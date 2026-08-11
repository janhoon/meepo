import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
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

/** Package-bundled agents directory (works for git/npm install layout). */
export function getPackageProfilesDir(): string {
	return resolve(dirname(fileURLToPath(import.meta.url)), "../../agents");
}

/** @deprecated Prefer getPackageProfilesDir + listProfilesFromDirs. */
export function getProfilesDir(): string {
	return getPackageProfilesDir();
}

/**
 * Resolve ordered profile directories.
 * - If `dirs` is non-empty, those paths are used in order (later shadows earlier by name).
 * - If empty, only the package agents directory is used.
 * Missing directories are skipped.
 */
export function resolveProfileDirs(dirs?: string[]): string[] {
	const active = getActiveProfileLoadOptions();
	const configured = dirs && dirs.length > 0 ? dirs : active.dirs;
	const ordered =
		configured.length > 0
			? configured.map((d) => resolve(d))
			: [getPackageProfilesDir()];
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
