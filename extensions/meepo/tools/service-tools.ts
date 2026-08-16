/**
 * Coordinator tool registrations.
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
	formatServiceDetails,
	formatServiceFocusResult,
	formatServiceLine,
	formatServiceReconcileResult,
	formatServiceStartResult,
	formatServiceStopResult,
	summarizeServiceFilters,
} from "../formatters.js";
import {
	captureServiceById,
	focusServiceById,
	reconcileServices,
	resolveServiceFilters,
	spawnServiceFromParams,
	stopServiceById,
} from "../service-ops.js";
import { getMeepoDb } from "../db.js";
import { getService, listServices } from "../service-registry.js";
import type { ServiceSummary } from "../service-types.js";
import {
	TmuxServiceCaptureParams,
	TmuxServiceFocusParams,
	TmuxServiceGetParams,
	TmuxServiceListParams,
	TmuxServiceReconcileParams,
	TmuxServiceStartParams,
	TmuxServiceStopParams,
} from "../tool-schemas.js";

type RegisterTool = (tool: Parameters<ExtensionAPI["registerTool"]>[0]) => void;

export function register(registerTool: RegisterTool, pi: ExtensionAPI): void {
	registerTool({
			name: "service_start",
			label: "Service Start",
			description: "Launch a long-running command in a tracked tmux window and keep it available for focus, capture, and stop operations.",
			promptSnippet: "Launch a long-running API, dev server, watcher, or other shell command in a tracked tmux window.",
			promptGuidelines: [
				"Use service_start for API servers, frontend dev servers, file watchers, and other long-running commands you may need again later.",
				"Pass the foreground command, not a shell command that immediately backgrounds itself and exits.",
				"Pass a readySubstring when you want the tool to wait for a startup signal before continuing.",
			],
			parameters: TmuxServiceStartParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await spawnServiceFromParams(ctx, params);
				const service = getService(getMeepoDb(), result.serviceId);
				const extraOutput =
					result.initialOutput && (result.state === "error" || result.readyTimedOut)
						? `\n\nRecent output:\n${result.initialOutput.slice(-1200)}`
						: "";
				return {
					content: [{ type: "text", text: `${formatServiceStartResult(result)}${extraOutput}` }],
					details: { result, service },
				};
			},
		});

	registerTool({
			name: "service_list",
			label: "Service List",
			description: "List tracked tmux services from the global registry.",
			promptSnippet: "List tracked tmux services by project/session scope and active state.",
			promptGuidelines: [
				"Use service_list before starting another server when you are unsure whether one is already running.",
				"Prefer current_project or current_session scope unless the user explicitly asks for a global list.",
			],
			parameters: TmuxServiceListParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const scope = params.scope ?? "current_project";
				const filters = resolveServiceFilters(ctx, scope, params);
				const services = listServices(getMeepoDb(), filters);
				const header = `scope=${summarizeServiceFilters(scope, filters)} · ${services.length} service${services.length === 1 ? "" : "s"}`;
				const body = services.length === 0 ? "No services matched." : services.map(formatServiceLine).join("\n");
				return {
					content: [{ type: "text", text: `${header}\n\n${body}` }],
					details: { scope, filters, services },
				};
			},
		});

	registerTool({
			name: "service_get",
			label: "Service Get",
			description: "Get detailed state for one or more tracked tmux services.",
			promptSnippet: "Inspect detailed state for specific tracked tmux service windows.",
			promptGuidelines: [
				"Use service_get after tmux_service_list when you need the full command, cwd, log file, or tmux ids for a specific service.",
			],
			parameters: TmuxServiceGetParams,
			prepareArguments(args) {
				if (!args || typeof args !== "object") return args;
				const input = args as { id?: string; ids?: string[] };
				if (typeof input.id === "string" && !Array.isArray(input.ids)) {
					return { ids: [input.id] };
				}
				return args;
			},
			async execute(_toolCallId, params) {
				const services = params.ids
					.map((id) => getService(getMeepoDb(), id))
					.filter((service): service is ServiceSummary => service !== null);
				const text =
					services.length === 0 ? "No matching services found." : services.map((service) => formatServiceDetails(service)).join("\n\n---\n\n");
				return {
					content: [{ type: "text", text }],
					details: { ids: params.ids, services },
				};
			},
		});

	registerTool({
			name: "service_focus",
			label: "Service Focus",
			description: "Focus a tracked service window/pane on the frozen ProcessHost, or return the exact manual host command when automatic focus is not possible.",
			promptSnippet: "Focus a tracked tmux service window using its stored tmux ids.",
			promptGuidelines: [
				"Use service_focus when you want to jump directly into a running service window.",
			],
			parameters: TmuxServiceFocusParams,
			async execute(_toolCallId, params) {
				const { service, result } = await focusServiceById(params.id);
				return {
					content: [{ type: "text", text: formatServiceFocusResult(service, result) }],
					details: { service, ...result },
				};
			},
		});

	registerTool({
			name: "service_stop",
			label: "Service Stop",
			description: "Stop a tracked tmux service gracefully, or force-kill its host target.",
			promptSnippet: "Stop a tracked tmux service gracefully or with force=true.",
			promptGuidelines: [
				"Use graceful stop first for dev servers and watchers so they can shut down cleanly.",
				"Use force=true only when the process is hung or the user explicitly wants an immediate kill.",
			],
			parameters: TmuxServiceStopParams,
			async execute(_toolCallId, params) {
				const { service, result } = await stopServiceById(params.id, params.force ?? false, params.reason);
				return {
					content: [{ type: "text", text: formatServiceStopResult(service, result, params.force ?? false) }],
					details: { service, ...result, force: params.force ?? false },
				};
			},
		});

	registerTool({
			name: "service_capture",
			label: "Service Capture",
			description: "Capture recent output from a tracked tmux service pane, or fall back to the persisted log file if the pane already exited.",
			promptSnippet: "Capture recent logs from a tracked tmux service for debugging or readiness checks.",
			promptGuidelines: [
				"Use service_capture when you need recent startup output, error logs, or the current URL/port from a running service.",
			],
			parameters: TmuxServiceCaptureParams,
			async execute(_toolCallId, params) {
				const capture = await captureServiceById(params.id, params.lines ?? 200);
				return {
					content: [{ type: "text", text: capture.content || "(empty capture)" }],
					details: { serviceId: capture.service.id, source: capture.source, command: capture.command, lines: params.lines ?? 200 },
				};
			},
		});

	registerTool({
			name: "service_reconcile",
			label: "Service Reconcile",
			description: "Reconcile tracked tmux service state against ProcessHost inventory and persisted status snapshots.",
			promptSnippet: "Reconcile tracked tmux service registry state against tmux and run-directory snapshots.",
			promptGuidelines: [
				"Use service_reconcile when service windows disappear, status looks stale, or after restarting the primary session.",
			],
			parameters: TmuxServiceReconcileParams,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				const result = await reconcileServices(ctx, params);
				return {
					content: [{ type: "text", text: formatServiceReconcileResult(result) }],
					details: result,
				};
			},
		});

}
