/**
 * service-ops — split from coordinator-helpers.
 */
/**
 * Coordinator helpers (spawn/reconcile/wake/UI). Tool registration lives in tools/*.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Container, Key, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { openAgentsBoard, type AgentsBoardData, type AgentsBoardState, type BoardLaneId, type BoardTicket } from "./board.js";
import { registerChildRuntime, getChildRuntimeEnvironment } from "./child-runtime.js";
import { openAgentsDashboard, type AgentsDashboardData, type AgentsDashboardState } from "./dashboard.js";
import { closeMeepoDb, getMeepoDb } from "./db.js";
import { getRpcBridgeSocketPath, pingRpcBridge, readRpcBridgeStatus, sendRpcBridgeCommand } from "./rpc-client.js";
import {
	applyNoWaitSystemPrompt,
	getBashCommandFromToolInput,
	noWaitBashBlockReason,
} from "./no-wait-policy.js";
import { LEGACY_SESSION_CHILD_LINK_ENTRY_TYPE, SESSION_CHILD_LINK_ENTRY_TYPE } from "./paths.js";
import { getAllowedBuiltinToolNames, getSubagentProfile, listSubagentProfiles, normalizeBuiltinTools } from "./profiles.js";
import { getProjectKey } from "./project.js";
import { truncateText } from "./text-util.js";
import {
	AgentMessagePermissionError,
	canSendMessage,
	createAgentEvent,
	createAgentMessage,
	createMessageWithRecipients,
	createRootActorContext,
	fetchAgentInboxV2,
	getAgent,
	getFleetSummary,
	listAgentAttentionItemsV2,
	listAgents,
	listAttentionItems,
	listDescendantAgentIds,
	listHierarchyVisibleAgentIds,
	listInboxMessages,
	listMessagesForRecipient,
	markAgentMessageRecipientsByIds,
	markAgentMessageRecipientsByMessageIds,
	markAgentMessages,
	resolveAgentActorContext,
	updateAgent,
	updateAgentAttentionItemsV2ForOwner,
	updateAttentionItemsForAgent,
} from "./registry.js";
import type { ListAgentAttentionItemsV2Filters } from "./registry.js";
import { collectQueuedWakeCoalescingContext } from "./wake-coalescing.js";
import { LEGACY_SERVICE_TOOL_ALIASES, loadMeepoConfig } from "./config.js";
import { createMeepoRuntime, type MeepoRuntime } from "./runtime.js";
import {
	assertTaskLeaseAvailable,
	cancelTaskLink,
	createTask,
	createTaskEvent,
	createTaskLink,
	deriveTaskHealth,
	formatTaskLeaseConflict,
	getTask,
	getTaskLease,
	getTaskLeaseConflict,
	getTaskSummary,
	linkTaskAgent,
	listTaskAgentLinks,
	listTaskAttention,
	listTaskEvents,
	listTaskHealth,
	listTaskLinks,
	listTaskReadiness,
	listTasks,
	listTaskSubtreeWithMeta,
	listUnresolvedTaskDependencies,
	reconcileTasks,
	refreshTaskDependencyBlockState,
	resolveDependenciesForCompletedTask,
	taskLeaseKindForProfile,
	unlinkTaskAgent,
	updateTask,
} from "./task-registry.js";
import { getService, listServices, updateService } from "./service-registry.js";
import { readServiceStatus, spawnService, tailFileLines } from "./service-spawn.js";
import { spawnSubagent } from "./spawn.js";
import { maybeNotifyHostAttention } from "./host-notify.js";
import { getProcessHost, hostTargetRefFromLegacy } from "./process-host.js";
import {
	mapDeliveryModeToBridgeCommand,
	missingHostTargetMessage,
} from "./rpc-bridge-control.js";
import type {
	ListServicesFilters,
	ServiceStatusSnapshot,
	ServiceSummary,
	SpawnServiceResult,
	UpdateServiceInput,
} from "./service-types.js";
import type {
	AgentActorContext,
	AgentAttentionV2Record,
	AgentInboxMessageV2Record,
	AgentMessageRecord,
	AgentRecipientKind,
	AgentRecipientRef,
	AgentSummary,
	AttentionItemRecord,
	DeliveryMode,
	DownwardMessageActionPolicy,
	DownwardMessagePayload,
	FleetSummary,
	ListAgentsFilters,
	RuntimeStatusSnapshot,
	SessionChildLinkEntryData,
	SpawnSubagentResult,
	SubagentProfile,
	TaskInteractionRecord,
	UpdateAgentInput,
} from "./types.js";
import type {
	CreateTaskInput,
	ListTaskAgentLinksFilters,
	ListTasksFilters,
	TaskAgentLinkRecord,
	TaskAttentionRecord,
	TaskHealthSnapshot,
	TaskLinkState,
	TaskLinkType,
	TaskLinkWithTasksRecord,
	TaskReadinessRecord,
	TaskRecord,
	TaskState,
	TaskSummaryCounts,
	TaskWaitingOn,
	UpdateTaskInput,
} from "./task-types.js";
import {
	actorLabelForInteraction,
	attentionItemIcon,
	attentionItemLabel,
	buildAdminAttentionText,
	buildAttentionText,
	buildAttentionV2Text,
	buildInboxText,
	buildInboxV2Text,
	buildTaskAttentionText,
	buildTaskLinksText,
	buildTaskReadyText,
	defaultDownwardActionPolicy,
	formatAgentDetails,
	formatAgentLine,
	formatAttentionGateWarning,
	formatAttentionWakeup,
	formatCleanupCandidates,
	formatCleanupResults,
	formatFleetSummary,
	formatFocusResult,
	formatReconcileResult,
	formatServiceDetails,
	formatServiceFocusResult,
	formatServiceLine,
	formatServiceReconcileResult,
	formatServiceStartResult,
	formatServiceStopResult,
	formatSpawnSuccess,
	formatStopResult,
	formatTaskDetails,
	formatTaskLine,
	formatTaskLinkLine,
	formatTaskReadinessLine,
	ownerLabelForInteraction,
	serviceReadyLabel,
	serviceStateIcon,
	summarizeFilters,
	summarizeServiceFilters,
	summarizeTaskFilters,
	taskInteractionIcon,
	taskInteractionLabel,
} from "./formatters.js";
import {
	TaskSubtreeControlAction,
	applyTaskSubtreeControl,
	buildTaskSubtreeControlPreview,
	configureSubtreeControlDeps,
	formatTaskSubtreeControlApplyResult,
	formatTaskSubtreeControlConfirmation,
	formatTaskSubtreeControlPreview,
} from "./subtree-control.js";
import {
	deliverQueuedMessagesViaBridge,
	queueDownwardMessage,
} from "./bridge-delivery.js";
import {
	SubagentAttentionParams,
	SubagentCaptureParams,
	SubagentCleanupParams,
	SubagentFocusParams,
	SubagentGetParams,
	SubagentInboxParams,
	SubagentListParams,
	SubagentMessageParams,
	SubagentReconcileParams,
	SubagentSpawnParams,
	SubagentStopParams,
	TaskAttentionParams,
	TaskCreateParams,
	TaskDispatchReadyParams,
	TaskGetParams,
	TaskLinkAgentParams,
	TaskLinkParams,
	TaskLinksParams,
	TaskListParams,
	TaskMoveParams,
	TaskNoteParams,
	TaskReadyParams,
	TaskReconcileParams,
	TaskSubtreeControlParams,
	TaskUnlinkAgentParams,
	TaskUnlinkParams,
	TaskUpdateParams,
	TmuxServiceCaptureParams,
	TmuxServiceFocusParams,
	TmuxServiceGetParams,
	TmuxServiceListParams,
	TmuxServiceReconcileParams,
	TmuxServiceStartParams,
	TmuxServiceStopParams,
} from "./tool-schemas.js";
import type { CleanupCandidate } from "./cleanup-types.js";
import { truncateText } from "./text-util.js";


/** Active Meepo config for this extension process (set on register). */
export function resolveServiceFilters(
	ctx: ExtensionContext,
	scope: "all" | "current_project" | "current_session",
	params: { activeOnly?: boolean; limit?: number },
): ListServicesFilters {
	const filters: ListServicesFilters = {
		activeOnly: params.activeOnly,
		limit: params.limit,
	};
	switch (scope) {
		case "current_project":
			filters.projectKey = getProjectKey(ctx.cwd);
			break;
		case "current_session":
			filters.spawnSessionId = ctx.sessionManager.getSessionId();
			filters.spawnSessionFile = ctx.sessionManager.getSessionFile();
			break;
		case "all":
		default:
			break;
	}
	return filters;
}

export function serviceStateIcon(state: ServiceSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "stopped":
			return "■";
		case "error":
			return "✗";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

export function summarizeServiceFilters(scope: string, filters: ListServicesFilters): string {
	const parts = [scope];
	if (filters.activeOnly) parts.push("active-only");
	return parts.join(", ");
}

export function serviceReadyLabel(service: ServiceSummary): string | null {
	if (!service.readySubstring) return null;
	if (service.readyMatchedAt) return "ready";
	if (["stopped", "error", "lost"].includes(service.state)) return "not-ready";
	return "waiting-ready";
}


export async function spawnServiceFromParams(ctx: ExtensionContext, params: {
	title: string;
	command: string;
	cwd?: string;
	env?: Record<string, string>;
	readySubstring?: string;
	readyTimeoutSec?: number;
}): Promise<SpawnServiceResult> {
	const spawnCwd = resolveInputPath(ctx.cwd, params.cwd);
	assertDirectory(spawnCwd);
	return spawnService({
		title: params.title,
		command: params.command,
		spawnCwd,
		env: params.env,
		readySubstring: params.readySubstring,
		readyTimeoutSec: params.readyTimeoutSec,
		spawnSessionId: ctx.sessionManager.getSessionId(),
		spawnSessionFile: ctx.sessionManager.getSessionFile(),
	});
}

export async function focusServiceById(id: string): Promise<{ service: ServiceSummary; result: { focused: boolean; command: string; reason?: string } }> {
	const service = getService(getMeepoDb(), id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const result = await getProcessHost().focus(hostTargetRefFromLegacy(service));
	return { service, result };
}

export async function captureServiceById(id: string, lines = 200): Promise<{ service: ServiceSummary; content: string; command: string; source: "host" | "log" }> {
	const db = getMeepoDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const host = getProcessHost();
	const target = hostTargetRefFromLegacy(service);
	if (await host.targetExists(target)) {
		const result = await host.capture(target, { lines });
		return { service, content: result.content, command: result.command, source: "host" };
	}
	const latestStatus = readLatestServiceStatus(service);
	if (latestStatus) {
		updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
	}
	const refreshed = getService(db, service.id) ?? service;
	return {
		service: refreshed,
		content: tailFileLines(refreshed.logFile, lines),
		command: `tail -n ${lines} ${refreshed.logFile}`,
		source: "log",
	};
}

export async function stopServiceById(id: string, force: boolean, reason?: string): Promise<{
	service: ServiceSummary;
	result: { stopped: boolean; graceful: boolean; command: string; reason?: string };
}> {
	const db = getMeepoDb();
	const service = getService(db, id);
	if (!service) {
		throw new Error(`Unknown service id "${id}".`);
	}
	const host = getProcessHost();
	const target = hostTargetRefFromLegacy(service);
	const targetExists = await host.targetExists(target);
	if (!targetExists) {
		const latestStatus = readLatestServiceStatus(service);
		if (latestStatus) {
			updateService(db, service.id, buildServicePatchFromStatus(service, latestStatus));
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: !force,
					command: "(host target already exited)",
					reason: "host target was already gone; registry refreshed from latest-status.json.",
				},
			};
		}
		if (force) {
			updateService(db, service.id, {
				state: "stopped",
				updatedAt: Date.now(),
				finishedAt: Date.now(),
				lastError: null,
			});
			return {
				service: getService(db, service.id) ?? service,
				result: {
					stopped: true,
					graceful: false,
					command: "(host target already missing)",
					reason: reason?.trim() || "host target was already gone; registry marked stopped.",
				},
			};
		}
		throw new Error(`Service ${service.id} no longer has a live host target. Use force=true or reconcile.`);
	}
	const result = await host.stop(target, { force });
	if (force) {
		updateService(db, service.id, {
			state: "stopped",
			updatedAt: Date.now(),
			finishedAt: Date.now(),
			lastError: null,
		});
	}
	return { service: getService(db, service.id) ?? service, result };
}

export async function reconcileServices(ctx: ExtensionContext, params: { scope?: "all" | "current_project" | "current_session"; activeOnly?: boolean; limit?: number }): Promise<{
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
}> {
	const scope = params.scope ?? "current_project";
	const filters = resolveServiceFilters(ctx, scope, {
		activeOnly: params.activeOnly ?? true,
		limit: params.limit,
	});
	const db = getMeepoDb();
	const services = listServices(db, filters);
	const host = getProcessHost();
	const inventory = await host.listInventory();
	const changed: Array<{ id: string; state: string; reason: string }> = [];
	for (const service of services) {
		const latestStatus = readLatestServiceStatus(service);
		const targetExists = await host.targetExists(hostTargetRefFromLegacy(service), inventory);
		let patch: UpdateServiceInput = {};
		let reason = "";
		const readyMatchedAt = maybeDetectServiceReady(service);
		if (readyMatchedAt) {
			patch = { ...patch, readyMatchedAt };
			reason = reason || "ready substring observed in service output";
		}
		if (latestStatus && latestStatus.updatedAt > service.updatedAt) {
			patch = {
				...patch,
				...buildServicePatchFromStatus(service, latestStatus),
			};
			reason = reason || "latest-status.json was newer than the registry";
		}
		if (!targetExists) {
			if (latestStatus && ["stopped", "error"].includes(latestStatus.state)) {
				patch = {
					...patch,
					...buildServicePatchFromStatus(service, latestStatus),
				};
				reason = reason || "host target exited after terminal latest-status update";
			} else if (["launching", "running"].includes(service.state)) {
				patch = {
					...patch,
					state: "lost",
					updatedAt: Date.now(),
					lastError: service.lastError ?? "host target missing during reconcile",
				};
				reason = reason || "host target missing during reconcile";
			}
		} else if (service.state === "launching" && !latestStatus) {
			patch = {
				...patch,
				state: "running",
				updatedAt: Date.now(),
			};
			reason = reason || "host target exists and the service appears to be running";
		}
		if (Object.keys(patch).length > 0) {
			updateService(db, service.id, patch);
			changed.push({ id: service.id, state: patch.state ?? service.state, reason: reason || "service metadata refreshed" });
		}
	}
	return { scope, reconciled: services.length, changed };
}

export function formatServiceReconcileResult(result: {
	scope: string;
	reconciled: number;
	changed: Array<{ id: string; state: string; reason: string }>;
}): string {
	if (result.changed.length === 0) {
		return `Reconciled ${result.reconciled} services in scope ${result.scope}. No changes.`;
	}
	return [
		`Reconciled ${result.reconciled} services in scope ${result.scope}.`,
		"",
		...result.changed.map((item) => `${item.id} → ${item.state} · ${item.reason}`),
	].join("\n");
}

