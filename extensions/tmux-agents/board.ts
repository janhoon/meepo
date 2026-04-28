import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSummary } from "./types.js";
import type { TaskAttentionRecord, TaskRecord, TaskWaitingOn } from "./task-types.js";

export type BoardScope = "current_project" | "current_session" | "descendants" | "all";
export type BoardLaneId = "todo" | "blocked" | "in_progress" | "in_review" | "done";

export interface BoardTicket {
	taskId: string;
	laneId: BoardLaneId;
	title: string;
	priority: number;
	priorityLabel: string | null;
	waitingOn: TaskWaitingOn | null;
	blockedReason: string | null;
	updatedAt: number;
	activeAgentCount: number;
	linkedProfiles: string[];
	openAttentionCount: number;
	summary: string;
}

export interface AgentsBoardScopeData {
	lanes: Record<BoardLaneId, BoardTicket[]>;
	tasksById: Map<string, TaskRecord>;
	agentsByTaskId: Map<string, AgentSummary[]>;
	needsHumanQueue: TaskAttentionRecord[];
}

export interface AgentsBoardData {
	scopes: Record<BoardScope, AgentsBoardScopeData>;
}

export interface AgentsBoardState {
	scope: BoardScope;
	selectedLaneId?: BoardLaneId;
	selectedTaskId?: string;
	mode?: "tasks" | "queue";
	selectedNeedsHumanId?: string;
}

export interface AgentsBoardAction {
	type: "close" | "inspect" | "focus" | "stop" | "reply" | "capture" | "spawn" | "sync" | "move" | "create" | "attention_open" | "attention_respond" | "attention_defer" | "attention_approve" | "attention_reject";
	selectedId?: string;
	state: AgentsBoardState;
}

const LANE_ORDER: BoardLaneId[] = ["todo", "blocked", "in_progress", "in_review", "done"];
const SCOPE_ORDER: BoardScope[] = ["current_project", "current_session", "descendants", "all"];

function laneLabel(laneId: BoardLaneId): string {
	switch (laneId) {
		case "todo":
			return "To Do";
		case "blocked":
			return "Blocked";
		case "in_progress":
			return "In Progress";
		case "in_review":
			return "In Review";
		case "done":
			return "Done";
		default:
			return laneId;
	}
}

function laneIcon(laneId: BoardLaneId): string {
	switch (laneId) {
		case "todo":
			return "○";
		case "blocked":
			return "⛔";
		case "in_progress":
			return "▶";
		case "in_review":
			return "◍";
		case "done":
			return "✓";
		default:
			return "•";
	}
}

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function short(text: string | null | undefined, max = 60): string {
	if (!text) return "-";
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= max) return single;
	return `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function waitingBadge(waitingOn: TaskWaitingOn | null): string {
	switch (waitingOn) {
		case "user":
			return "user";
		case "coordinator":
			return "coord";
		case "service":
			return "svc";
		case "external":
			return "ext";
		default:
			return "";
	}
}

class AgentsBoardComponent {
	private readonly boardRows = 10;
	private state: AgentsBoardState;

	constructor(
		private data: AgentsBoardData,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (result: AgentsBoardAction | null) => void,
		initialState: AgentsBoardState,
	) {
		this.state = { mode: "tasks", ...initialState };
		this.ensureSelection();
	}

	setData(data: AgentsBoardData): void {
		this.data = data;
		this.ensureSelection();
	}

	private getScopeData(): AgentsBoardScopeData {
		return this.data.scopes[this.state.scope];
	}

	private getLaneTickets(laneId: BoardLaneId): BoardTicket[] {
		return this.getScopeData().lanes[laneId] ?? [];
	}

	private getFirstNonEmptyLane(): BoardLaneId | undefined {
		for (const laneId of LANE_ORDER) {
			if (this.getLaneTickets(laneId).length > 0) return laneId;
		}
		return undefined;
	}

	private ensureSelection(): void {
		const queue = this.getScopeData().needsHumanQueue ?? [];
		if (this.state.mode === "queue") {
			if (queue.length === 0) {
				this.state.selectedNeedsHumanId = undefined;
				this.state.mode = "tasks";
			} else if (!queue.some((item) => item.id === this.state.selectedNeedsHumanId)) {
				this.state.selectedNeedsHumanId = queue[0]?.id;
			}
			const selectedQueueItem = queue.find((item) => item.id === this.state.selectedNeedsHumanId);
			if (selectedQueueItem) {
				this.state.selectedTaskId = selectedQueueItem.taskId;
				this.state.selectedLaneId = selectedQueueItem.status;
			}
		}
		const firstLane = this.getFirstNonEmptyLane() ?? LANE_ORDER[0];
		if (!this.state.selectedLaneId || !LANE_ORDER.includes(this.state.selectedLaneId)) {
			this.state.selectedLaneId = firstLane;
		}
		const laneTickets = this.getLaneTickets(this.state.selectedLaneId);
		if (laneTickets.some((ticket) => ticket.taskId === this.state.selectedTaskId)) {
			return;
		}
		if (laneTickets.length > 0) {
			this.state.selectedTaskId = laneTickets[0]!.taskId;
			return;
		}
		const fallbackLane = this.getFirstNonEmptyLane();
		if (!fallbackLane) {
			this.state.selectedTaskId = undefined;
			return;
		}
		this.state.selectedLaneId = fallbackLane;
		this.state.selectedTaskId = this.getLaneTickets(fallbackLane)[0]?.taskId;
	}

	private getSelectedQueueItem(): TaskAttentionRecord | null {
		this.ensureSelection();
		const id = this.state.selectedNeedsHumanId;
		if (!id) return null;
		return (this.getScopeData().needsHumanQueue ?? []).find((item) => item.id === id) ?? null;
	}

	private getSelectedTicket(): BoardTicket | null {
		this.ensureSelection();
		const taskId = this.state.selectedTaskId;
		if (!taskId) return null;
		for (const laneId of LANE_ORDER) {
			const ticket = this.getLaneTickets(laneId).find((item) => item.taskId === taskId);
			if (ticket) return ticket;
		}
		return null;
	}

	private moveLane(delta: number): void {
		const currentIndex = Math.max(0, LANE_ORDER.indexOf(this.state.selectedLaneId ?? LANE_ORDER[0]!));
		let nextLane = this.state.selectedLaneId ?? LANE_ORDER[0]!;
		for (let step = 1; step <= LANE_ORDER.length; step++) {
			const nextIndex = (currentIndex + delta * step + LANE_ORDER.length * step) % LANE_ORDER.length;
			const candidateLane = LANE_ORDER[nextIndex] ?? LANE_ORDER[0]!;
			if (this.getLaneTickets(candidateLane).length > 0) {
				nextLane = candidateLane;
				break;
			}
		}
		this.state.selectedLaneId = nextLane;
		const tickets = this.getLaneTickets(nextLane);
		if (!tickets.some((ticket) => ticket.taskId === this.state.selectedTaskId)) {
			this.state.selectedTaskId = tickets[0]?.taskId;
		}
		this.ensureSelection();
	}

	private moveQueue(delta: number): void {
		const queue = this.getScopeData().needsHumanQueue ?? [];
		if (queue.length === 0) return;
		const currentIndex = Math.max(0, queue.findIndex((item) => item.id === this.state.selectedNeedsHumanId));
		const nextIndex = Math.max(0, Math.min(queue.length - 1, currentIndex + delta));
		const item = queue[nextIndex];
		this.state.selectedNeedsHumanId = item?.id;
		if (item) {
			this.state.selectedTaskId = item.taskId;
			this.state.selectedLaneId = item.status;
		}
	}

	private moveTicket(delta: number): void {
		if (this.state.mode === "queue") {
			this.moveQueue(delta);
			return;
		}
		this.ensureSelection();
		const laneId = this.state.selectedLaneId;
		if (!laneId) return;
		const tickets = this.getLaneTickets(laneId);
		if (tickets.length === 0) return;
		const currentIndex = Math.max(0, tickets.findIndex((ticket) => ticket.taskId === this.state.selectedTaskId));
		const nextIndex = Math.max(0, Math.min(tickets.length - 1, currentIndex + delta));
		this.state.selectedTaskId = tickets[nextIndex]?.taskId;
	}

	private cycleScope(): void {
		const index = SCOPE_ORDER.indexOf(this.state.scope);
		this.state.scope = SCOPE_ORDER[(index + 1) % SCOPE_ORDER.length] ?? "current_project";
		this.ensureSelection();
	}

	private makeAction(type: AgentsBoardAction["type"]): AgentsBoardAction {
		const queueAction = type.startsWith("attention_");
		const selectedQueue = queueAction && this.state.mode === "queue" ? this.getSelectedQueueItem() : null;
		const selected = this.getSelectedTicket();
		return {
			type,
			selectedId: queueAction ? selectedQueue?.id : selected?.taskId,
			state: { ...this.state, selectedTaskId: selected?.taskId, selectedNeedsHumanId: selectedQueue?.id },
		};
	}

	private renderLane(laneId: BoardLaneId, width: number): string[] {
		const tickets = this.getLaneTickets(laneId);
		const selectedLane = this.state.selectedLaneId === laneId;
		const selectedIndex = tickets.findIndex((ticket) => ticket.taskId === this.state.selectedTaskId);
		const visibleCount = this.boardRows - 1;
		const start =
			selectedIndex >= 0
				? Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), Math.max(0, tickets.length - visibleCount)))
				: 0;
		const end = Math.min(tickets.length, start + visibleCount);
		const lines: string[] = [];
		const header = `${laneLabel(laneId)} (${tickets.length})`;
		lines.push(
			selectedLane ? this.theme.fg("accent", this.theme.bold(padToWidth(header, width))) : this.theme.fg("muted", padToWidth(header, width)),
		);
		for (let index = start; index < end; index++) {
			const ticket = tickets[index]!;
			const selected = selectedLane && ticket.taskId === this.state.selectedTaskId;
			const prefix = selected ? ">" : " ";
			const flags = [
				ticket.priority <= 1 ? `P${ticket.priority}` : null,
				waitingBadge(ticket.waitingOn),
				ticket.activeAgentCount > 0 ? `${ticket.activeAgentCount}a` : null,
				ticket.openAttentionCount > 0 ? `${ticket.openAttentionCount}!` : null,
			]
				.filter((value): value is string => Boolean(value))
				.join(" ");
			const body = `${prefix} ${laneIcon(ticket.laneId)} ${short(ticket.title, Math.max(8, width - 8))}${flags ? ` ${flags}` : ""}`;
			lines.push(selected ? this.theme.fg("accent", padToWidth(body, width)) : padToWidth(body, width));
		}
		while (lines.length < this.boardRows) {
			lines.push(this.theme.fg("dim", padToWidth("·", width)));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private getQueueAgentLabel(item: TaskAttentionRecord): string {
		const agent = (this.getScopeData().agentsByTaskId.get(item.taskId) ?? []).find((candidate) => candidate.id === item.agentId);
		return agent ? `${agent.id}/${agent.profile}` : item.agentId;
	}

	private renderQueue(width: number): string[] {
		const queue = this.getScopeData().needsHumanQueue ?? [];
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(`Needs-human queue (${queue.length})`)));
		if (queue.length === 0) {
			lines.push(this.theme.fg("muted", "No open task/agent needs-human rows."));
			return lines;
		}
		const selectedIndex = queue.findIndex((item) => item.id === this.state.selectedNeedsHumanId);
		const start = selectedIndex >= 0 ? Math.max(0, Math.min(selectedIndex - 1, Math.max(0, queue.length - 4))) : 0;
		for (let index = start; index < Math.min(queue.length, start + 4); index++) {
			const item = queue[index]!;
			const selected = this.state.mode === "queue" && item.id === this.state.selectedNeedsHumanId;
			const marker = selected ? ">" : " ";
			const agentLabel = this.getQueueAgentLabel(item);
			const row = `${marker} P${item.priority} ${item.kind}/${item.category} · ${item.waitingOn ?? "-"} · ${short(agentLabel, 20)} · ${short(item.title, 22)} · ${short(item.summary, Math.max(20, width - 84))}`;
			lines.push(selected ? this.theme.fg("accent", row) : row);
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderDetails(width: number): string[] {
		const selected = this.getSelectedTicket();
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("Selected task")));
		if (!selected) {
			lines.push(this.theme.fg("muted", "No task selected."));
			return lines;
		}
		const task = this.getScopeData().tasksById.get(selected.taskId);
		const linkedAgents = this.getScopeData().agentsByTaskId.get(selected.taskId) ?? [];
		const activeWorktreeAgents = linkedAgents.filter((agent) => ["launching", "running", "idle", "waiting", "blocked"].includes(agent.state) && (agent.worktreeId || agent.worktreeCwd)).length;
		const worktreeConflicts = linkedAgents.filter((agent) => {
			if (agent.worktreeCwd && task?.worktreeCwd && resolve(agent.worktreeCwd) !== resolve(task.worktreeCwd)) return true;
			if (agent.worktreeId && task?.worktreeId && agent.worktreeId !== task.worktreeId) return true;
			return false;
		}).length;
		const worktreePathExists = task?.worktreeCwd ? existsSync(task.worktreeCwd) : false;
		let worktreeStatus = "none";
		if (task?.workspaceStrategy || task?.worktreeId || task?.worktreeCwd) {
			if (worktreeConflicts > 0) worktreeStatus = "conflict";
			else if (activeWorktreeAgents > 0) worktreeStatus = "active";
			else if (task?.workspaceStrategy === "dedicated_worktree" && !task.worktreeCwd) worktreeStatus = "stale-missing";
			else if (task?.worktreeCwd && !worktreePathExists) worktreeStatus = "stale-missing";
			else if (task?.workspaceStrategy === "dedicated_worktree" && task.status === "done") worktreeStatus = "ready-cleanup";
			else if (task?.workspaceStrategy === "dedicated_worktree") worktreeStatus = "reusable";
			else if (task?.workspaceStrategy === "existing_worktree") worktreeStatus = "preserved-existing";
			else if (task?.workspaceStrategy === "spawn_cwd") worktreeStatus = "opt-out-spawn-cwd";
			else worktreeStatus = task?.workspaceStrategy ?? "metadata-only";
		}
		lines.push(`${laneIcon(selected.laneId)} ${selected.title} · ${selected.taskId}`);
		lines.push(`lane: ${laneLabel(selected.laneId)} · priority: ${selected.priority}${selected.priorityLabel ? ` (${selected.priorityLabel})` : ""}`);
		lines.push(`waiting: ${selected.waitingOn ?? "-"} · active agents: ${selected.activeAgentCount} · open attention: ${selected.openAttentionCount}`);
		lines.push(`worktree: ${worktreeStatus} · strategy: ${task?.workspaceStrategy ?? "-"} · id: ${task?.worktreeId ?? "-"}`);
		lines.push(`worktree cwd: ${short(task?.worktreeCwd, Math.max(24, width - 15))}`);
		lines.push(`worktree path exists: ${task?.worktreeCwd ? (worktreePathExists ? "yes" : "no") : "-"}`);
		lines.push(`worktree agents: active=${activeWorktreeAgents} · conflicts=${worktreeConflicts}`);
		lines.push(`summary: ${short(task?.summary ?? selected.summary, Math.max(24, width - 10))}`);
		lines.push(`blocked: ${short(task?.blockedReason ?? selected.blockedReason, Math.max(24, width - 10))}`);
		lines.push(`plan: ${short(task?.planSteps.join(" | "), Math.max(24, width - 7))}`);
		lines.push(`validation: ${short(task?.validationSteps.join(" | "), Math.max(24, width - 13))}`);
		lines.push(`files: ${short(task?.files.join(", "), Math.max(24, width - 8))}`);
		lines.push(`agents: ${linkedAgents.length > 0 ? short(linkedAgents.map((agent) => `${agent.id}:${agent.profile}:${agent.state}${agent.worktreeId ? `:wt=${agent.worktreeId}` : ""}`).join(", "), Math.max(24, width - 9)) : "-"}`);
		return lines.map((line) => truncateToWidth(line, width));
	}

	render(width: number): string[] {
		this.ensureSelection();
		const separator = " │ ";
		const laneWidth = Math.max(14, Math.floor((width - separator.length * (LANE_ORDER.length - 1)) / LANE_ORDER.length));
		const lines: string[] = [];
		lines.push(truncateToWidth(`${this.theme.fg("accent", this.theme.bold("tmux tasks board"))} · scope:${this.state.scope}`, width));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					"auto-refresh 5s · h queue/tasks · ↑↓ move · enter inspect/open · R respond · d defer · A approve · J reject · s spawn · m move · n new · o open agent · x stop · r reply · c capture · y sync · f scope · esc close",
				),
				width,
			),
		);
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(0, width))));
		const laneLines = LANE_ORDER.map((laneId) => this.renderLane(laneId, laneWidth));
		for (let row = 0; row < this.boardRows; row++) {
			const parts = laneLines.map((column) => padToWidth(column[row] ?? "", laneWidth));
			lines.push(truncateToWidth(parts.join(separator), width));
		}
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(0, width))));
		lines.push(...this.renderQueue(width));
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(0, width))));
		lines.push(...this.renderDetails(width));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.left)) {
			if (this.state.mode === "queue") return;
			this.moveLane(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
			if (this.state.mode === "queue") return;
			this.moveLane(1);
			return;
		}
		if (matchesKey(data, Key.up)) {
			this.moveTicket(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveTicket(1);
			return;
		}
		if (matchesKey(data, Key.enter)) {
			this.done(this.makeAction(this.state.mode === "queue" ? "attention_open" : "inspect"));
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(this.makeAction("close"));
			return;
		}
		if (data === "o") return void this.done(this.makeAction("focus"));
		if (data === "x") return void this.done(this.makeAction("stop"));
		if (data === "r") return void this.done(this.makeAction("reply"));
		if (data === "R") return void this.done(this.makeAction("attention_respond"));
		if (data === "d") return void this.done(this.makeAction("attention_defer"));
		if (data === "A") return void this.done(this.makeAction("attention_approve"));
		if (data === "J") return void this.done(this.makeAction("attention_reject"));
		if (data === "c") return void this.done(this.makeAction("capture"));
		if (data === "s") return void this.done(this.makeAction("spawn"));
		if (data === "n") return void this.done(this.makeAction("create"));
		if (data === "m") return void this.done(this.makeAction("move"));
		if (data === "y") return void this.done(this.makeAction("sync"));
		if (data === "h") {
			this.state.mode = this.state.mode === "queue" ? "tasks" : "queue";
			this.ensureSelection();
			return;
		}
		if (data === "f") {
			this.cycleScope();
			return;
		}
	}
}

export async function openAgentsBoard(
	ctx: ExtensionContext,
	getData: () => AgentsBoardData,
	initialState: AgentsBoardState,
	autoRefreshMs = 5000,
): Promise<AgentsBoardAction | null> {
	if (!ctx.hasUI) return null;
	return ctx.ui.custom<AgentsBoardAction | null>((tui, theme, _keybindings, done) => {
		const component = new AgentsBoardComponent(getData(), theme, done, initialState);
		const interval =
			autoRefreshMs > 0
				? setInterval(() => {
					try {
						component.setData(getData());
						component.invalidate();
						tui.requestRender();
					} catch {
						// Keep showing the last successful board snapshot on refresh errors.
					}
				}, autoRefreshMs)
				: undefined;
		return {
			render(width: number) {
				return component.render(width);
			},
			invalidate() {
				component.invalidate();
			},
			handleInput(data: string) {
				component.handleInput(data);
				tui.requestRender();
			},
			dispose() {
				if (interval) clearInterval(interval);
			},
		};
	});
}
