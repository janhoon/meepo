import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSummary, TaskInteractionRecord } from "./types.js";
import type { TaskHealthSnapshot, TaskHealthState, TaskRecord, TaskWaitingOn } from "./task-types.js";

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
	exclusiveOwnerCount: number;
	reviewerCount: number;
	ownerAgentIds: string[];
	linkedProfiles: string[];
	openAttentionCount: number;
	health: TaskHealthSnapshot;
	summary: string;
}

export interface AgentsBoardScopeData {
	lanes: Record<BoardLaneId, BoardTicket[]>;
	tasksById: Map<string, TaskRecord>;
	agentsByTaskId: Map<string, AgentSummary[]>;
	interactionsByTaskId: Map<string, TaskInteractionRecord[]>;
}

export interface AgentsBoardData {
	scopes: Record<BoardScope, AgentsBoardScopeData>;
}

export interface AgentsBoardState {
	scope: BoardScope;
	selectedLaneId?: BoardLaneId;
	selectedTaskId?: string;
}

export interface AgentsBoardAction {
	type: "close" | "inspect" | "focus" | "stop" | "reply" | "capture" | "spawn" | "sync" | "move" | "create" | "subtree";
	selectedId?: string;
	state: AgentsBoardState;
}

const LANE_ORDER: BoardLaneId[] = ["todo", "blocked", "in_progress", "in_review", "done"];
const ACTION_LANE_ORDER: BoardLaneId[] = ["blocked", "in_review", "in_progress", "todo", "done"];
const SCOPE_ORDER: BoardScope[] = ["current_project", "current_session", "descendants", "all"];
const SOFT_WIP_LIMITS: Partial<Record<BoardLaneId, number>> = {
	in_progress: 3,
	in_review: 5,
};

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

function healthBadge(health: TaskHealthState): string {
	switch (health) {
		case "blocked_external":
			return "ext";
		case "approval_required":
			return "appr";
		case "empty_or_no_progress":
			return "empty";
		case "needs_review":
			return "review";
		case "owner_active":
			return "owner";
		case "stale":
			return "stale";
		case "healthy":
		default:
			return "ok";
	}
}

function relativeAge(timestamp: number | null): string {
	if (!timestamp) return "unknown";
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

function emptyLaneText(laneId: BoardLaneId): string {
	switch (laneId) {
		case "todo":
			return "no ready work";
		case "blocked":
			return "no blockers";
		case "in_progress":
			return "no active work";
		case "in_review":
			return "no review queue";
		case "done":
			return "nothing done yet";
		default:
			return "empty";
	}
}

function shortProfiles(profiles: string[], max = 2): string {
	if (profiles.length === 0) return "";
	const shown = profiles.slice(0, max).map((profile) => profile.replace(/[^a-z0-9-]/gi, "").slice(0, 3).toLowerCase());
	const suffix = profiles.length > max ? `+${profiles.length - max}` : "";
	return [...shown, suffix].filter(Boolean).join("/");
}

function interactionIcon(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "❓";
		case "coordinator_question":
			return "?";
		case "approval_request":
			return "☑";
		case "change_request":
			return "↻";
		case "blocker":
			return "⛔";
		case "completion":
			return "✓";
		default:
			return "•";
	}
}

function interactionLabel(kind: TaskInteractionRecord["kind"]): string {
	switch (kind) {
		case "user_question":
			return "user question";
		case "coordinator_question":
			return "coordinator question";
		case "approval_request":
			return "approval request";
		case "change_request":
			return "change request";
		case "blocker":
			return "blocker";
		case "completion":
			return "completion";
		default:
			return kind;
	}
}

function nextActionForTicket(ticket: BoardTicket, task: TaskRecord | undefined, linkedAgents: AgentSummary[]): string {
	if (ticket.openAttentionCount > 0) {
		if (ticket.waitingOn === "user") return "answer user-facing interaction, then resume the child";
		return "triage task interaction; reply, unblock, approve, or request changes";
	}
	if (ticket.health.nextAction) return ticket.health.nextAction;
	if (ticket.waitingOn) return `waiting on ${ticket.waitingOn}; keep blocked until resolved`;
	if (ticket.laneId === "blocked") return "record waitingOn/blocker or move back once unblocked";
	if (ticket.laneId === "todo") return ticket.exclusiveOwnerCount > 0 ? "inspect active owner before spawning more work" : "spawn the right specialist or refine acceptance criteria";
	if (ticket.laneId === "in_progress") return ticket.exclusiveOwnerCount > 0 ? "let active owner run; focus/capture only if reporting is stale" : "assign an owner or move back to todo";
	if (ticket.laneId === "in_review") return task?.reviewSummary ? "synthesize review and move done or back to in_progress" : "run the review/QA gate before accepting";
	if (ticket.laneId === "done") return "cleanup linked agents after synthesis";
	return "inspect task";
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
		this.state = { ...initialState };
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
		for (const laneId of ACTION_LANE_ORDER) {
			if (this.getLaneTickets(laneId).some((ticket) => ticket.openAttentionCount > 0)) return laneId;
		}
		for (const laneId of ACTION_LANE_ORDER) {
			if (this.getLaneTickets(laneId).length > 0) return laneId;
		}
		return undefined;
	}

	private ensureSelection(): void {
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

	private moveTicket(delta: number): void {
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
		const selected = this.getSelectedTicket();
		return {
			type,
			selectedId: selected?.taskId,
			state: { ...this.state, selectedTaskId: selected?.taskId },
		};
	}

	private renderLane(laneId: BoardLaneId, width: number): string[] {
		const tickets = this.getLaneTickets(laneId);
		const selectedLane = this.state.selectedLaneId === laneId;
		const selectedIndex = tickets.findIndex((ticket) => ticket.taskId === this.state.selectedTaskId);
		const visibleCount = this.boardRows - 2;
		const start =
			selectedIndex >= 0
				? Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), Math.max(0, tickets.length - visibleCount)))
				: 0;
		const end = Math.min(tickets.length, start + visibleCount);
		const lines: string[] = [];
		const attentionCount = tickets.reduce((count, ticket) => count + ticket.openAttentionCount, 0);
		const wipLimit = SOFT_WIP_LIMITS[laneId];
		const wipWarning = wipLimit && tickets.length > wipLimit ? `>${wipLimit}` : "";
		const header = `${laneLabel(laneId)} (${tickets.length}${attentionCount > 0 ? ` · ${attentionCount}!` : ""}${wipWarning ? ` · ${wipWarning}` : ""})`;
		lines.push(
			selectedLane ? this.theme.fg("accent", this.theme.bold(padToWidth(header, width))) : this.theme.fg("muted", padToWidth(header, width)),
		);
		if (tickets.length === 0) {
			lines.push(this.theme.fg("dim", padToWidth(`  ${emptyLaneText(laneId)}`, width)));
		}
		for (let index = start; index < end; index++) {
			const ticket = tickets[index]!;
			const selected = selectedLane && ticket.taskId === this.state.selectedTaskId;
			const prefix = selected ? ">" : " ";
			const flags = [
				healthBadge(ticket.health.state),
				ticket.openAttentionCount > 0 ? `${ticket.openAttentionCount}!` : null,
				waitingBadge(ticket.waitingOn),
				ticket.priority <= 1 ? `P${ticket.priority}` : null,
				ticket.exclusiveOwnerCount > 0 ? `${ticket.exclusiveOwnerCount}o` : null,
				ticket.reviewerCount > 0 ? `${ticket.reviewerCount}r` : null,
				ticket.activeAgentCount > ticket.exclusiveOwnerCount + ticket.reviewerCount ? `${ticket.activeAgentCount}a` : null,
				shortProfiles(ticket.linkedProfiles),
			]
				.filter((value): value is string => Boolean(value))
				.join(" ");
			const titleWidth = Math.max(8, width - 6 - visibleWidth(flags));
			const body = `${prefix} ${laneIcon(ticket.laneId)} ${short(ticket.title, titleWidth)}${flags ? ` ${flags}` : ""}`;
			lines.push(selected ? this.theme.fg("accent", padToWidth(body, width)) : padToWidth(body, width));
		}
		if (tickets.length > end) lines.push(this.theme.fg("dim", padToWidth(`  +${tickets.length - end} more`, width)));
		while (lines.length < this.boardRows) {
			lines.push(this.theme.fg("dim", padToWidth("·", width)));
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
		const interactions = this.getScopeData().interactionsByTaskId.get(selected.taskId) ?? [];
		lines.push(`${laneIcon(selected.laneId)} ${selected.title} · ${selected.taskId}`);
		lines.push(`next: ${short(nextActionForTicket(selected, task, linkedAgents), Math.max(24, width - 7))}`);
		lines.push(`health: ${selected.health.state} · signals: ${short(selected.health.signals.join(", "), Math.max(24, width - 20))}`);
		lines.push(`last useful: ${relativeAge(selected.health.lastUsefulUpdateAt)} · ${short(selected.health.lastUsefulUpdateSummary, Math.max(24, width - 22))}`);
		lines.push(`lane: ${laneLabel(selected.laneId)} · priority: ${selected.priority}${selected.priorityLabel ? ` (${selected.priorityLabel})` : ""} · updated: ${relativeAge(selected.updatedAt)}`);
		lines.push(`waiting: ${selected.waitingOn ?? "-"} · owners: ${selected.exclusiveOwnerCount} · reviewers: ${selected.reviewerCount} · active agents: ${selected.activeAgentCount} · interactions: ${interactions.length}`);
		lines.push(`summary: ${short(task?.summary ?? selected.summary, Math.max(24, width - 10))}`);
		lines.push(`blocked: ${short(task?.blockedReason ?? selected.blockedReason, Math.max(24, width - 10))}`);
		lines.push(`acceptance: ${short(task?.acceptanceCriteria.join(" | "), Math.max(24, width - 13))}`);
		lines.push(`plan: ${short(task?.planSteps.join(" | "), Math.max(24, width - 7))}`);
		lines.push(`validation: ${short(task?.validationSteps.join(" | "), Math.max(24, width - 13))}`);
		lines.push(`labels: ${short(task?.labels.join(", "), Math.max(24, width - 9))}`);
		lines.push(`files: ${short(task?.files.join(", "), Math.max(24, width - 8))}`);
		if (interactions.length > 0) {
			lines.push("interactions:");
			for (const interaction of interactions.slice(0, 3)) {
				const label = `${interactionIcon(interaction.kind)} ${interactionLabel(interaction.kind)} · ${interaction.actorLabel} · ${interaction.state}`;
				lines.push(`- ${short(label, Math.max(24, width - 3))}`);
				lines.push(`  ask: ${short(interaction.answerNeeded ?? interaction.summary, Math.max(24, width - 7))}`);
				lines.push(`  next: ${short(interaction.nextAction, Math.max(24, width - 8))}`);
				if (interaction.actions[0]) lines.push(`  action: ${short(interaction.actions[0], Math.max(24, width - 10))}`);
			}
			if (interactions.length > 3) lines.push(`- +${interactions.length - 3} more interactions`);
		}
		lines.push(`owners: ${selected.ownerAgentIds.length > 0 ? short(selected.ownerAgentIds.join(", "), Math.max(24, width - 9)) : "-"}`);
		lines.push(`agents: ${linkedAgents.length > 0 ? short(linkedAgents.map((agent) => `${agent.id}:${agent.profile}:${agent.state}`).join(", "), Math.max(24, width - 9)) : "-"}`);
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderBoardSummary(width: number): string {
		const lanes = this.getScopeData().lanes;
		const blocked = lanes.blocked.length;
		const userWaiting = lanes.blocked.filter((ticket) => ticket.waitingOn === "user").length;
		const review = lanes.in_review.length;
		const active = lanes.in_progress.reduce((count, ticket) => count + ticket.activeAgentCount, 0);
		const attention = LANE_ORDER.reduce((count, laneId) => count + lanes[laneId].reduce((laneCount, ticket) => laneCount + ticket.openAttentionCount, 0), 0);
		const allTickets = LANE_ORDER.flatMap((laneId) => lanes[laneId]);
		const stale = allTickets.filter((ticket) => ticket.health.signals.includes("stale")).length;
		const noProgress = allTickets.filter((ticket) => ticket.health.signals.includes("empty_or_no_progress")).length;
		const approvals = allTickets.filter((ticket) => ticket.health.signals.includes("approval_required")).length;
		const overWip = LANE_ORDER.flatMap((laneId) => {
			const limit = SOFT_WIP_LIMITS[laneId];
			return limit && lanes[laneId].length > limit ? [`${laneLabel(laneId)} ${lanes[laneId].length}/${limit}`] : [];
		});
		const summary = `hot: ${blocked} blocked (${userWaiting} user) · ${review} review · ${attention} interactions · ${active} active agents · ${stale} stale · ${noProgress} no-progress · ${approvals} approval${overWip.length > 0 ? ` · WIP ${overWip.join(", ")}` : ""}`;
		return truncateToWidth(this.theme.fg(attention > 0 || blocked > 0 ? "accent" : "muted", summary), width);
	}

	render(width: number): string[] {
		this.ensureSelection();
		const separator = " │ ";
		const laneWidth = Math.max(14, Math.floor((width - separator.length * (LANE_ORDER.length - 1)) / LANE_ORDER.length));
		const lines: string[] = [];
		lines.push(truncateToWidth(`${this.theme.fg("accent", this.theme.bold("kanban task board"))} · scope:${this.state.scope}`, width));
		lines.push(this.renderBoardSummary(width));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					"keys: ←→ lanes · ↑↓ tasks · enter inspect · s spawn · m move · u subtree · n new · o focus · r reply · x stop · c capture · y sync · f scope · esc close",
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
		lines.push(...this.renderDetails(width));
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.left)) {
			this.moveLane(-1);
			return;
		}
		if (matchesKey(data, Key.right)) {
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
			this.done(this.makeAction("inspect"));
			return;
		}
		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.done(this.makeAction("close"));
			return;
		}
		if (data === "o") return void this.done(this.makeAction("focus"));
		if (data === "x") return void this.done(this.makeAction("stop"));
		if (data === "r") return void this.done(this.makeAction("reply"));
		if (data === "c") return void this.done(this.makeAction("capture"));
		if (data === "s") return void this.done(this.makeAction("spawn"));
		if (data === "n") return void this.done(this.makeAction("create"));
		if (data === "m") return void this.done(this.makeAction("move"));
		if (data === "u") return void this.done(this.makeAction("subtree"));
		if (data === "y") return void this.done(this.makeAction("sync"));
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
