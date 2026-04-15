import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Key } from "@mariozechner/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { AgentMessageRecord, AgentSummary } from "./types.js";

export type DashboardScope = "current_project" | "current_session" | "descendants" | "all";
export type DashboardSort = "priority" | "updated" | "title" | "profile" | "state";

export interface AgentsDashboardState {
	scope: DashboardScope;
	sort: DashboardSort;
	activeOnly: boolean;
	blockedOnly: boolean;
	unreadOnly: boolean;
	selectedId?: string;
}

export interface AgentsDashboardData {
	scopes: Record<DashboardScope, AgentSummary[]>;
	childrenByParent: Map<string, string[]>;
}

export interface AgentsDashboardAction {
	type: "close" | "inspect" | "focus" | "stop" | "reply" | "capture" | "spawn" | "sync";
	selectedId?: string;
	state: AgentsDashboardState;
}

const SCOPE_ORDER: DashboardScope[] = ["current_project", "current_session", "descendants", "all"];
const SORT_ORDER: DashboardSort[] = ["priority", "updated", "title", "profile", "state"];
const ACTIVE_STATES = new Set<AgentSummary["state"]>(["launching", "running", "idle", "waiting", "blocked"]);

function padToWidth(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	const pad = Math.max(0, width - visibleWidth(truncated));
	return truncated + " ".repeat(pad);
}

function payloadSummary(message: AgentMessageRecord | null): string {
	if (!message) return "-";
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as { summary?: string };
	return payload.summary?.trim() || message.kind;
}

function priorityRank(agent: AgentSummary): number {
	if (agent.latestUnreadMessage?.kind === "question_for_user") return 0;
	if (agent.latestUnreadMessage?.kind === "question") return 1;
	if (agent.state === "blocked") return 2;
	if (agent.latestUnreadMessage?.kind === "complete") return 3;
	if (agent.unreadCount > 0) return 4;
	if (ACTIVE_STATES.has(agent.state)) return 5;
	return 6;
}

function stateRank(state: AgentSummary["state"]): number {
	switch (state) {
		case "blocked":
			return 0;
		case "launching":
		case "running":
			return 1;
		case "waiting":
			return 2;
		case "idle":
			return 3;
		case "done":
			return 4;
		case "error":
			return 5;
		case "stopped":
			return 6;
		case "lost":
			return 7;
		default:
			return 8;
	}
}

function sortAgents(agents: AgentSummary[], sort: DashboardSort): AgentSummary[] {
	return [...agents].sort((left, right) => {
		switch (sort) {
			case "priority": {
				const delta = priorityRank(left) - priorityRank(right);
				if (delta !== 0) return delta;
				return right.updatedAt - left.updatedAt;
			}
			case "updated":
				return right.updatedAt - left.updatedAt;
			case "title":
				return left.title.localeCompare(right.title) || right.updatedAt - left.updatedAt;
			case "profile":
				return left.profile.localeCompare(right.profile) || right.updatedAt - left.updatedAt;
			case "state": {
				const delta = stateRank(left.state) - stateRank(right.state);
				if (delta !== 0) return delta;
				return right.updatedAt - left.updatedAt;
			}
			default:
				return right.updatedAt - left.updatedAt;
		}
	});
}

function stateIcon(state: AgentSummary["state"]): string {
	switch (state) {
		case "launching":
		case "running":
			return "▶";
		case "idle":
		case "waiting":
			return "◌";
		case "blocked":
			return "⛔";
		case "done":
			return "✓";
		case "error":
			return "✗";
		case "stopped":
			return "■";
		case "lost":
			return "?";
		default:
			return "•";
	}
}

function short(text: string | null | undefined, max = 60): string {
	if (!text) return "-";
	const single = text.replace(/\s+/g, " ").trim();
	if (single.length <= max) return single;
	return `${single.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

class AgentsDashboardComponent {
	private state: AgentsDashboardState;
	private selectedIndex = 0;
	private readonly listHeight = 12;

	constructor(
		private readonly data: AgentsDashboardData,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly done: (result: AgentsDashboardAction | null) => void,
		initialState: AgentsDashboardState,
	) {
		this.state = { ...initialState };
		this.ensureSelection();
	}

	private getBaseAgents(): AgentSummary[] {
		return this.data.scopes[this.state.scope] ?? [];
	}

	private getVisibleAgents(): AgentSummary[] {
		let agents = this.getBaseAgents();
		if (this.state.activeOnly) agents = agents.filter((agent) => ACTIVE_STATES.has(agent.state));
		if (this.state.blockedOnly) agents = agents.filter((agent) => agent.state === "blocked");
		if (this.state.unreadOnly) agents = agents.filter((agent) => agent.unreadCount > 0);
		return sortAgents(agents, this.state.sort);
	}

	private ensureSelection(): void {
		const agents = this.getVisibleAgents();
		if (agents.length === 0) {
			this.selectedIndex = 0;
			this.state.selectedId = undefined;
			return;
		}
		const desiredIndex = this.state.selectedId ? agents.findIndex((agent) => agent.id === this.state.selectedId) : -1;
		if (desiredIndex >= 0) {
			this.selectedIndex = desiredIndex;
		} else if (this.selectedIndex >= agents.length) {
			this.selectedIndex = agents.length - 1;
		}
		this.state.selectedId = agents[this.selectedIndex]?.id;
	}

	private getSelectedAgent(): AgentSummary | null {
		const agents = this.getVisibleAgents();
		if (agents.length === 0) return null;
		this.ensureSelection();
		return agents[this.selectedIndex] ?? null;
	}

	private moveSelection(delta: number): void {
		const agents = this.getVisibleAgents();
		if (agents.length === 0) return;
		this.selectedIndex = Math.max(0, Math.min(agents.length - 1, this.selectedIndex + delta));
		this.state.selectedId = agents[this.selectedIndex]?.id;
	}

	private cycleScope(): void {
		const index = SCOPE_ORDER.indexOf(this.state.scope);
		this.state.scope = SCOPE_ORDER[(index + 1) % SCOPE_ORDER.length] ?? "current_project";
		this.ensureSelection();
	}

	private cycleSort(): void {
		const index = SORT_ORDER.indexOf(this.state.sort);
		this.state.sort = SORT_ORDER[(index + 1) % SORT_ORDER.length] ?? "priority";
		this.ensureSelection();
	}

	private makeAction(type: AgentsDashboardAction["type"]): AgentsDashboardAction {
		const selected = this.getSelectedAgent();
		return {
			type,
			selectedId: selected?.id,
			state: { ...this.state, selectedId: selected?.id },
		};
	}

	private renderList(width: number): string[] {
		const agents = this.getVisibleAgents();
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold(`Agents (${agents.length})`)));
		if (agents.length === 0) {
			lines.push(this.theme.fg("muted", "No agents match the current filters."));
			while (lines.length < this.listHeight + 1) lines.push("");
			return lines;
		}
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(this.listHeight / 2), Math.max(0, agents.length - this.listHeight)));
		const end = Math.min(agents.length, start + this.listHeight);
		for (let index = start; index < end; index++) {
			const agent = agents[index]!;
			const selected = index === this.selectedIndex;
			const unread = agent.unreadCount > 0 ? this.theme.fg("warning", ` ${agent.unreadCount}`) : "";
			const marker = selected ? this.theme.fg("accent", ">") : this.theme.fg("dim", " ");
			const row = `${marker} ${stateIcon(agent.state)} ${short(agent.title, 28)}${unread}`;
			lines.push(selected ? this.theme.fg("accent", row) : row);
		}
		while (lines.length < this.listHeight + 1) lines.push("");
		return lines.map((line) => truncateToWidth(line, width));
	}

	private renderDetail(width: number): string[] {
		const agent = this.getSelectedAgent();
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", this.theme.bold("Details")));
		if (!agent) {
			lines.push(this.theme.fg("muted", "Select an agent to inspect details."));
			return lines;
		}
		const children = this.data.childrenByParent.get(agent.id) ?? [];
		lines.push(`${stateIcon(agent.state)} ${agent.id} · ${agent.profile}`);
		lines.push(short(agent.title, width));
		lines.push(`parent: ${agent.parentAgentId ?? "-"}`);
		lines.push(`children: ${children.length > 0 ? children.join(", ") : "-"}`);
		lines.push(`unread: ${agent.unreadCount}`);
		lines.push(`latest: ${agent.latestUnreadMessage ? `${agent.latestUnreadMessage.kind} · ${short(payloadSummary(agent.latestUnreadMessage), 42)}` : "-"}`);
		lines.push(`task: ${short(agent.task, 54)}`);
		lines.push(`preview: ${short(agent.lastAssistantPreview, 54)}`);
		lines.push(`summary: ${short(agent.finalSummary, 54)}`);
		lines.push(`error: ${short(agent.lastError, 54)}`);
		lines.push(`tmux: ${agent.tmuxSessionName ?? agent.tmuxSessionId ?? "-"} / ${agent.tmuxWindowId ?? "-"}`);
		lines.push(`pane: ${agent.tmuxPaneId ?? "-"}`);
		lines.push(`runDir: ${short(agent.runDir, 54)}`);
		return lines.map((line) => truncateToWidth(line, width));
	}

	render(width: number): string[] {
		this.ensureSelection();
		const leftWidth = Math.max(30, Math.min(44, Math.floor(width * 0.42)));
		const rightWidth = Math.max(30, width - leftWidth - 3);
		const lines: string[] = [];
		const filterFlags = [
			this.state.activeOnly ? "active" : null,
			this.state.blockedOnly ? "blocked" : null,
			this.state.unreadOnly ? "unread" : null,
		]
			.filter((value): value is string => Boolean(value))
			.join(",");
		lines.push(
			truncateToWidth(
				`${this.theme.fg("accent", this.theme.bold("tmux agents dashboard"))} · scope:${this.state.scope} · sort:${this.state.sort}${filterFlags ? ` · ${filterFlags}` : ""}`,
				width,
			),
		);
		lines.push(
			truncateToWidth(
				this.theme.fg("dim", "↑↓ move · enter details · o open · x stop · r reply · c capture · n spawn · y sync · f scope · t sort · a/b/u filters · esc close"),
				width,
			),
		);
		lines.push(this.theme.fg("dim", "─".repeat(Math.max(0, width))));
		const left = this.renderList(leftWidth);
		const right = this.renderDetail(rightWidth);
		const rowCount = Math.max(left.length, right.length);
		for (let index = 0; index < rowCount; index++) {
			const leftLine = padToWidth(left[index] ?? "", leftWidth);
			const rightLine = truncateToWidth(right[index] ?? "", rightWidth);
			lines.push(truncateToWidth(`${leftLine} │ ${rightLine}`, width));
		}
		return lines;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.moveSelection(-1);
			return;
		}
		if (matchesKey(data, Key.down)) {
			this.moveSelection(1);
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
		if (data === "f") return void this.cycleScope();
		if (data === "t") return void this.cycleSort();
		if (data === "a") {
			this.state.activeOnly = !this.state.activeOnly;
			this.ensureSelection();
			return;
		}
		if (data === "b") {
			this.state.blockedOnly = !this.state.blockedOnly;
			this.ensureSelection();
			return;
		}
		if (data === "u") {
			this.state.unreadOnly = !this.state.unreadOnly;
			this.ensureSelection();
		}
	}
}

export async function openAgentsDashboard(
	ctx: ExtensionContext,
	data: AgentsDashboardData,
	initialState: AgentsDashboardState,
): Promise<AgentsDashboardAction | null> {
	if (!ctx.hasUI) return null;
	return ctx.ui.custom<AgentsDashboardAction | null>((tui, theme, _keybindings, done) => {
		const component = new AgentsDashboardComponent(data, theme, done, initialState);
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
