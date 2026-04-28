import { getSubagentProfile, listSubagentProfiles } from "./profiles.js";
import type { TaskRecord } from "./task-types.js";
import type { SubagentProfile } from "./types.js";

export interface TaskLaunchResolution {
	profile: SubagentProfile;
	reason: string;
	source: "requested_profile" | "assigned_profile" | "role_hint" | "labels" | "content" | "default";
}

function normalize(value: string | null | undefined): string {
	return (value ?? "").trim().toLowerCase();
}

function profileIfAvailable(name: string | null | undefined): SubagentProfile | null {
	const trimmed = name?.trim();
	if (!trimmed) return null;
	return getSubagentProfile(trimmed);
}

function firstAvailable(names: string[]): SubagentProfile | null {
	for (const name of names) {
		const profile = getSubagentProfile(name);
		if (profile) return profile;
	}
	return listSubagentProfiles()[0] ?? null;
}

function taskText(task: TaskRecord): string {
	return normalize([
		task.title,
		task.summary,
		task.description,
		task.roleHint,
		...task.labels,
	].filter(Boolean).join(" "));
}

export function resolveTaskLaunchProfile(task: TaskRecord): TaskLaunchResolution {
	const assigned = profileIfAvailable(task.assignedProfile);
	if (assigned) {
		return { profile: assigned, source: "assigned_profile", reason: `using assignedProfile=${assigned.name}` };
	}
	const requested = profileIfAvailable(task.requestedProfile);
	if (requested) {
		return { profile: requested, source: "requested_profile", reason: `using requestedProfile=${requested.name}` };
	}

	const text = taskText(task);
	const labels = task.labels.map(normalize);
	const roleHint = normalize(task.roleHint);

	if (roleHint.includes("review") || roleHint.includes("qa")) {
		const profile = firstAvailable(["reviewer", "qa-lead"]);
		if (profile) return { profile, source: "role_hint", reason: `roleHint matched review/qa; selected ${profile.name}` };
	}
	if (roleHint.includes("plan") || roleHint.includes("design")) {
		const profile = firstAvailable(["planner", "cto"]);
		if (profile) return { profile, source: "role_hint", reason: `roleHint matched planning/design; selected ${profile.name}` };
	}
	if (roleHint.includes("implement") || roleHint.includes("engineer") || roleHint.includes("code")) {
		const profile = firstAvailable(["engineer", "worker"]);
		if (profile) return { profile, source: "role_hint", reason: `roleHint matched implementation/engineering; selected ${profile.name}` };
	}

	if (labels.some((label) => ["review", "qa", "test", "validation"].includes(label))) {
		const profile = firstAvailable(["reviewer", "qa-lead"]);
		if (profile) return { profile, source: "labels", reason: `labels matched review/qa; selected ${profile.name}` };
	}
	if (labels.some((label) => ["planning", "plan", "design", "architecture"].includes(label))) {
		const profile = firstAvailable(["planner", "cto"]);
		if (profile) return { profile, source: "labels", reason: `labels matched planning/design; selected ${profile.name}` };
	}
	if (labels.some((label) => ["implementation", "implement", "engineering", "code", "bug", "fix"].includes(label))) {
		const profile = firstAvailable(["engineer", "worker"]);
		if (profile) return { profile, source: "labels", reason: `labels matched implementation; selected ${profile.name}` };
	}

	if (/\b(review|qa|test|validate|verification)\b/.test(text)) {
		const profile = firstAvailable(["reviewer", "qa-lead"]);
		if (profile) return { profile, source: "content", reason: `task content matched review/qa; selected ${profile.name}` };
	}
	if (/\b(plan|planning|design|architect|spec|scope)\b/.test(text)) {
		const profile = firstAvailable(["planner", "cto"]);
		if (profile) return { profile, source: "content", reason: `task content matched planning/design; selected ${profile.name}` };
	}
	if (/\b(implement|implementation|engineer|code|fix|build|refactor)\b/.test(text)) {
		const profile = firstAvailable(["engineer", "worker"]);
		if (profile) return { profile, source: "content", reason: `task content matched implementation; selected ${profile.name}` };
	}

	const profile = firstAvailable(["engineer", "worker"]);
	if (!profile) throw new Error("No subagent profiles available for autonomous task launch.");
	return { profile, source: "default", reason: `defaulted to ${profile.name}` };
}
