/**
 * Shared task registry helpers and lease types.
 */
import type { DatabaseSync } from "node:sqlite";
import { resolveProfileLeaseKind, toTaskLeaseKind } from "./profile-metadata.js";
import { getSubagentProfile } from "./profiles.js";
import { addSessionScopeFilter, makePlaceholders, safeJsonParse } from "./sql-util.js";
import type { AgentState, ProfileLeaseKind } from "./types.js";
import type {
	TaskAgentLinkRecord,
	TaskEventRecord,
	TaskLinkWithTasksRecord,
	TaskRecord,
	TaskState,
} from "./task-types.js";

export const TASK_HEALTH_DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type TaskLeaseKind = "exclusive" | "review";

export interface TaskLeaseOwnerRecord {
	taskId: string;
	agentId: string;
	profile: string;
	role: string;
	state: AgentState;
	title: string;
	linkedAt: number;
	summary: string | null;
	leaseKind: TaskLeaseKind;
}

export interface TaskLeaseStateRecord {
	taskId: string;
	activeOwners: TaskLeaseOwnerRecord[];
	exclusiveOwners: TaskLeaseOwnerRecord[];
	reviewOwners: TaskLeaseOwnerRecord[];
}

export interface TaskLeaseConflictRecord {
	taskId: string;
	requestedProfile: string;
	requestedLeaseKind: TaskLeaseKind;
	conflictingOwners: TaskLeaseOwnerRecord[];
}

export const TASK_FIELD_TO_COLUMN: Record<keyof UpdateTaskInput, string> = {
	parentTaskId: "parent_task_id",
	spawnSessionId: "spawn_session_id",
	spawnSessionFile: "spawn_session_file",
	spawnCwd: "spawn_cwd",
	projectKey: "project_key",
	title: "title",
	summary: "summary",
	description: "description",
	status: "status",
	priority: "priority",
	priorityLabel: "priority_label",
	recommendedProfile: "recommended_profile",
	waitingOn: "waiting_on",
	blockedReason: "blocked_reason",
	acceptanceCriteria: "acceptance_criteria_json",
	planSteps: "plan_steps_json",
	validationSteps: "validation_steps_json",
	labels: "labels_json",
	files: "files_json",
	reviewSummary: "review_summary",
	finalSummary: "final_summary",
	updatedAt: "updated_at",
	startedAt: "started_at",
	reviewRequestedAt: "review_requested_at",
	finishedAt: "finished_at",
};


export function taskHasUsefulBody(task: TaskRecord): boolean {
	return Boolean(
		task.summary?.trim() ||
			task.description?.trim() ||
			task.blockedReason?.trim() ||
			task.reviewSummary?.trim() ||
			task.finalSummary?.trim() ||
			task.acceptanceCriteria.length > 0 ||
			task.planSteps.length > 0 ||
			task.validationSteps.length > 0 ||
			task.files.length > 0,
	);
}

export function normalizeStringArray(values: string[] | null | undefined): string[] {
	const seen = new Set<string>();
	const normalized: string[] = [];
	for (const value of values ?? []) {
		const trimmed = String(value ?? "").trim();
		if (!trimmed || seen.has(trimmed)) continue;
		seen.add(trimmed);
		normalized.push(trimmed);
	}
	return normalized;
}

export function mergeStringArrays(...parts: Array<string[] | null | undefined>): string[] {
	return normalizeStringArray(parts.flatMap((part) => part ?? []));
}


/**
 * Resolve task lease kind for a profile name.
 * Uses profile frontmatter `lease` when the profile is loadable; otherwise legacy name-table fallback.
 */
export function taskLeaseKindForProfile(profile: string | null | undefined): TaskLeaseKind {
	const name = (profile ?? "").trim();
	if (!name) return "exclusive";
	let metadataLease: ProfileLeaseKind | null = null;
	try {
		metadataLease = getSubagentProfile(name)?.lease ?? null;
	} catch {
		metadataLease = null;
	}
	return toTaskLeaseKind(resolveProfileLeaseKind(name, metadataLease));
}

export function toTaskLeaseOwnerRecord(row: Record<string, unknown>): TaskLeaseOwnerRecord {
	const profile = row.profile as string;
	const role = (row.role as string | null) ?? profile;
	return {
		taskId: row.task_id as string,
		agentId: row.agent_id as string,
		profile,
		role,
		state: row.state as AgentState,
		title: row.title as string,
		linkedAt: Number(row.linked_at ?? 0),
		summary: (row.summary as string | null) ?? null,
		leaseKind: taskLeaseKindForProfile(role || profile),
	};
}


export function toTaskRecord(row: Record<string, unknown>): TaskRecord {
	return {
		id: row.id as string,
		parentTaskId: (row.parent_task_id as string | null) ?? null,
		spawnSessionId: (row.spawn_session_id as string | null) ?? null,
		spawnSessionFile: (row.spawn_session_file as string | null) ?? null,
		spawnCwd: row.spawn_cwd as string,
		projectKey: row.project_key as string,
		title: row.title as string,
		summary: (row.summary as string | null) ?? null,
		description: (row.description as string | null) ?? null,
		status: row.status as TaskState,
		priority: Number(row.priority ?? 3),
		priorityLabel: (row.priority_label as string | null) ?? null,
		recommendedProfile: (row.recommended_profile as string | null) ?? null,
		waitingOn: (row.waiting_on as TaskWaitingOn | null) ?? null,
		blockedReason: (row.blocked_reason as string | null) ?? null,
		acceptanceCriteria: normalizeStringArray(safeJsonParse(row.acceptance_criteria_json as string | null, [])),
		planSteps: normalizeStringArray(safeJsonParse(row.plan_steps_json as string | null, [])),
		validationSteps: normalizeStringArray(safeJsonParse(row.validation_steps_json as string | null, [])),
		labels: normalizeStringArray(safeJsonParse(row.labels_json as string | null, [])),
		files: normalizeStringArray(safeJsonParse(row.files_json as string | null, [])),
		reviewSummary: (row.review_summary as string | null) ?? null,
		finalSummary: (row.final_summary as string | null) ?? null,
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		startedAt: (row.started_at as number | null) ?? null,
		reviewRequestedAt: (row.review_requested_at as number | null) ?? null,
		finishedAt: (row.finished_at as number | null) ?? null,
	};
}

export function toTaskEventRecord(row: Record<string, unknown>): TaskEventRecord {
	return {
		id: row.id as string,
		taskId: row.task_id as string,
		agentId: (row.agent_id as string | null) ?? null,
		eventType: row.event_type as string,
		summary: row.summary as string,
		payload: safeJsonParse(row.payload_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
	};
}

export function toTaskAgentLinkRecord(row: Record<string, unknown>): TaskAgentLinkRecord {
	return {
		id: row.id as string,
		taskId: row.task_id as string,
		agentId: row.agent_id as string,
		role: (row.role as string | null) ?? "contributor",
		isActive: Number(row.is_active ?? 0) === 1,
		linkedAt: Number(row.linked_at ?? 0),
		unlinkedAt: (row.unlinked_at as number | null) ?? null,
		summary: (row.summary as string | null) ?? null,
	};
}

export function toTaskLinkRecord(row: Record<string, unknown>): TaskLinkWithTasksRecord {
	const linkType = row.link_type as TaskLinkType;
	const state = row.state as TaskLinkState;
	const targetStatus = row.target_status as TaskState;
	return {
		id: row.id as string,
		sourceTaskId: row.source_task_id as string,
		targetTaskId: row.target_task_id as string,
		linkType,
		state,
		summary: (row.summary as string | null) ?? null,
		metadata: safeJsonParse(row.metadata_json as string | null, null),
		createdAt: Number(row.created_at ?? 0),
		updatedAt: Number(row.updated_at ?? 0),
		resolvedAt: (row.resolved_at as number | null) ?? null,
		sourceTitle: (row.source_title as string | null) ?? (row.source_task_id as string),
		sourceStatus: (row.source_status as TaskState | null) ?? "todo",
		targetTitle: (row.target_title as string | null) ?? (row.target_task_id as string),
		targetStatus: targetStatus ?? "todo",
		unresolved: linkType === "depends_on" && state === "active" && targetStatus !== "done",
	};
}

export function taskStatusOrderSql(column = "t.status"): string {
	return `CASE ${column} WHEN 'blocked' THEN 0 WHEN 'in_review' THEN 1 WHEN 'in_progress' THEN 2 WHEN 'todo' THEN 3 WHEN 'done' THEN 4 ELSE 5 END`;
}

export function deriveDefaultTaskStatus(profile: string, kind: "milestone" | "blocked" | "question" | "question_for_user" | "note" | "complete"): TaskState | null {
	if (kind === "blocked" || kind === "question" || kind === "question_for_user") return "blocked";
	if (kind === "milestone" || kind === "note") return "in_progress";
	if (kind !== "complete") return null;
	// Lease metadata is consumer-owned (frontmatter). Review-lease completions close the task;
	// exclusive/shared workers leave work in_review for acceptance. No hardcoded role names.
	return taskLeaseKindForProfile(profile) === "review" ? "done" : "in_review";
}

export function nowOr(value: number | null | undefined, fallback: number): number | null {
	return value ?? fallback;
}

