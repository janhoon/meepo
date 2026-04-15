import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import type { SubagentProfile } from "./types.js";

const DEFAULT_PROFILE_TOOLS = ["read", "bash", "edit", "write"];
const ALLOWED_BUILTIN_TOOLS = new Set(["read", "bash", "grep", "ls", "edit", "write"]);

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
				`Unsupported built-in tool \"${trimmed}\". Allowed tools: ${Array.from(ALLOWED_BUILTIN_TOOLS).join(", ")}.`,
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
		if (!frontmatter.name || !frontmatter.description) continue;
		const tools = normalizeBuiltinTools(
			frontmatter.tools
				?.split(",")
				.map((value) => value.trim())
				.filter(Boolean),
		);
		profiles.push({
			name: frontmatter.name,
			description: frontmatter.description,
			systemPrompt: body.trim(),
			tools,
			model: frontmatter.model?.trim() || null,
			filePath,
		});
	}
	return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

export function getSubagentProfile(name: string): SubagentProfile | null {
	return listSubagentProfiles().find((profile) => profile.name === name) ?? null;
}

export function getAllowedBuiltinToolNames(): string[] {
	return Array.from(ALLOWED_BUILTIN_TOOLS);
}
