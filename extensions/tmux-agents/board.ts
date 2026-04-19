import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentSummary, AttentionItemRecord } from "./types.js";

export type BoardScope = "current_project" | "current_session" | "descendants" | "all";
export type BoardLaneId = "needs_user" | "waiting" | "blocked" | "in_progress" | "planned" | "review_done";

export interface BoardTicket {
	agentId: string;
	laneId: BoardLaneId;
	title: string;
	profile: string;
	state: AgentSummary["state"];
	model: string | null;
	updatedAt: number;
	unreadCount: number;
	attentionKind: AttentionItemRecord["kind"] | null;
	attentionState: AttentionItemRecord["state"] | null;
	attentionSummary: string | null;
	summary: string;
}

export interface AgentsBoardScopeData {
	lanes: Record<BoardLaneId, BoardTicket[]>;
	agentsById: Map<string, AgentSummary>;
	ticketsByAgentId: Map<string, BoardTicket>;
}

export interface AgentsBoardData {
	scopes: Record<BoardScope, AgentsBoardScopeData>;
}

export interface AgentsBoardState {
	scope: BoardScope;
	selectedLaneId?: BoardLaneId;
	selectedAgentId?: string;
}

export interface AgentsBoardAction {
	type: "close" | "inspect" | "focus" | "stop" | "reply" | "capture" | "spawn" | "sync";
	selectedId?: string;
	state: AgentsBoardState;
}

const LANE_ORDER: BoardLaneId[] = ["needs_user", "waiting", "blocked", "in_progress", "planned", "review_done"];
const SCOPE_ORDER: BoardScope[] = ["current_project", "current_session", "descendants", "all"];

function laneLabel(laneId: BoardLaneId): string {
	switch (laneId) {
		case "needs_user":
			return "Needs User";
		case "waiting":
			return "Waiting";
		case "blocked":
			return "Blocked";
		case "in_progress":
			return "In Progress";
		case "planned":
			return "Planned";
		case "review_done":
			return "Review/Done";
		default:
			return laneId;
	}
}

function laneIcon(laneId: BoardLaneId): string {
	switch (laneId) {
		case "needs_user":
			return "❓";
		case "waiting":
			return "?";
		case "blocked":
			return "⛔";
		case "in_progress":
			return "▶";
		case "planned":
			return "○";
		case "review_done":
			return "✓";
		default:
			return "•";
	}
}

function stateIcon(state: AgentSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "idle":
			return "◌";
		case "waiting":
			return "?";
		case "blocked":
			return "⛔";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "stopped":
			return "■";
		case "lost":
			return "!";
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

class AgentsBoardComponent {
	private readonly boardRows = 10;
	private state: AgentsBoardState;

	constructor(
		private readonly data: AgentsBoardData,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (result: AgentsBoardAction | null) => void,
		initialState: AgentsBoardState,
	) {
		this.state = { ...initialState };
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
		const firstLane = this.getFirstNonEmptyLane() ?? LANE_ORDER[0];
		if (!this.state.selectedLaneId || !LANE_ORDER.includes(this.state.selectedLaneId)) {
			this.state.selectedLaneId = firstLane;
		}
		const laneTickets = this.getLaneTickets(this.state.selectedLaneId);
		if (laneTickets.some((ticket) => ticket.agentId === this.state.selectedAgentId)) {
			return;
		}
		if (laneTickets.length > 0) {
			this.state.selectedAgentId = laneTickets[0]!.agentId;
			return;
		}
		const fallbackLane = this.getFirstNonEmptyLane();
		if (!fallbackLane) {
			this.state.selectedAgentId = undefined;
			return;
		}
		this.state.selectedLaneId = fallbackLane;
		this.state.selectedAgentId = this.getLaneTickets(fallbackLane)[0]?.agentId;
	}

	private getSelectedTicket(): BoardTicket | null {
		this.ensureSelection();
		const agentId = this.state.selectedAgentId;
		if (!agentId) return null;
		return this.getScopeData().ticketsByAgentId.get(agentId) ?? null;
	}

	private moveLane(delta: number): void {
		const currentIndex = Math.max(0, LANE_ORDER.indexOf(this.state.selectedLaneId ?? LANE_ORDER[0]!));
		const nextIndex = (currentIndex + delta + LANE_ORDER.length) % LANE_ORDER.length;
		const nextLane = LANE_ORDER[nextIndex] ?? LANE_ORDER[0]!;
		this.state.selectedLaneId = nextLane;
		const tickets = this.getLaneTickets(nextLane);
		if (!tickets.some((ticket) => ticket.agentId === this.state.selectedAgentId)) {
			this.state.selectedAgentId = tickets[0]?.agentId;
		}
		this.ensureSelection();
	}

	private moveTicket(delta: number): void {
		this.ensureSelection();
		const laneId = this.state.selectedLaneId;
		if (!laneId) return;
		const tickets = this.getLaneTickets(laneId);
		if (tickets.length === 0) return;
		const currentIndex = Math.max(0, tickets.findIndex((ticket) => ticket.agentId === this.state.selectedAgentId));
		const nextIndex = Math.max(0, Math.min(tickets.length - 1, currentIndex + delta));
		this.state.selectedAgentId = tickets[nextIndex]?.agentId;
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
			selectedId: selected?.agentId,
			state: { ...this.state, selectedAgentId: selected?.agentId },
		};
	}

	private ticketIcon(ticket: BoardTicket): string {
		return ticket.attentionKind ? laneIcon(ticket.laneId) : stateIcon(ticket.state);
	}

	private renderLane(laneId: BoardLaneId, width: number): string[] {
		const tickets = this.getLaneTickets(laneId);
		const selectedLane = this.state.selectedLaneId === laneId;
		const selectedIndex = tickets.findIndex((ticket) => ticket.agentId === this.state.selectedAgentId);
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
			const selected = selectedLane && ticket.agentId === this.state.selectedAgentId;
			const prefix = selected ? ">" : " ";
			const unread = ticket.unreadCount > 0 ? ` ${ticket.unreadCount}` : "";
			const line = `${prefix} ${this.ticketIcon(ticket)} ${ticket.profile[0]?.toUpperCase() ?? "?"} ${short(ticket.title, Math.max(8, width - 8))}${unread}`;
			lines.push(selected ? this.theme.fg("accent", padToWidth(line, width)) : padToWidth(line, width));
		}
		while (lines.length < this.boardRows) {
			lines.push(this.theme.fg("dim", padToWidth("·", width)));
		}
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderDetails(width: number): string[] {
		const selected = this.getSelectedTicket();
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("Selected ticket")));
		if (!selected) {
			lines.push(this.theme.fg("muted", "No ticket selected."));
			return lines;
		}
		const agent = this.getScopeData().agentsById.get(selected.agentId);
		lines.push(`${this.ticketIcon(selected)} ${selected.title} · ${selected.agentId} · ${selected.profile}${selected.model ? ` · ${selected.model}` : ""}`);
		lines.push(`lane: ${laneLabel(selected.laneId)} · state: ${selected.state} · unread: ${selected.unreadCount}`);
		lines.push(`attention: ${selected.attentionKind ? `${selected.attentionKind} · ${selected.attentionState ?? "-"}` : "-"}`);
		lines.push(`summary: ${short(selected.attentionSummary ?? selected.summary, Math.max(20, width - 10))}`);
		lines.push(`task: ${short(agent?.task, Math.max(20, width - 8))}`);
		lines.push(`preview: ${short(agent?.lastAssistantPreview ?? agent?.finalSummary, Math.max(20, width - 11))}`);
		lines.push(`tmux: ${agent?.tmuxSessionName ?? agent?.tmuxSessionId ?? "-"} / ${agent?.tmuxWindowId ?? "-"} / ${agent?.tmuxPaneId ?? "-"}`);
		return lines.map((line) => truncateToWidth(line, width));
	}

	render(width: number): string[] {
		this.ensureSelection();
		const separator = " │ ";
		const laneWidth = Math.max(12, Math.floor((width - separator.length * (LANE_ORDER.length - 1)) / LANE_ORDER.length));
		const lines: string[] = [];
		lines.push(truncateToWidth(`${this.theme.fg("accent", this.theme.bold("tmux agents board"))} · scope:${this.state.scope}`, width));
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					"←→ lanes · ↑↓ tickets · enter inspect · o open · x stop · r reply · c capture · n spawn · y sync · f scope · esc close",
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
		if (data === "n") return void this.done(this.makeAction("spawn"));
		if (data === "y") return void this.done(this.makeAction("sync"));
		if (data === "f") {
			this.cycleScope();
			return;
		}
	}
}

export async function openAgentsBoard(
	ctx: ExtensionContext,
	data: AgentsBoardData,
	initialState: AgentsBoardState,
): Promise<AgentsBoardAction | null> {
	if (!ctx.hasUI) return null;
	return ctx.ui.custom<AgentsBoardAction | null>((tui, theme, _keybindings, done) => {
		const component = new AgentsBoardComponent(data, theme, done, initialState);
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
		};
	});
}
