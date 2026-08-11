import { spawnSync } from "node:child_process";

export interface TmuxTargetInput {
	sessionId?: string | null;
	sessionName?: string | null;
	windowId?: string | null;
	paneId?: string | null;
}

export interface FocusTmuxTargetResult {
	focused: boolean;
	command: string;
	reason?: string;
}

export interface StopTmuxTargetResult {
	stopped: boolean;
	graceful: boolean;
	command: string;
	reason?: string;
}

export interface CaptureTmuxTargetResult {
	content: string;
	command: string;
}

export interface TmuxInventory {
	sessions: Set<string>;
	sessionNames: Set<string>;
	windows: Set<string>;
	panes: Set<string>;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function runTmux(args: string[]): string {
	const result = spawnSync("tmux", args, { encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(result.stderr?.trim() || result.stdout?.trim() || `tmux ${args.join(" ")} failed`);
	}
	return result.stdout ?? "";
}

function getSessionTarget(input: TmuxTargetInput): string {
	const sessionTarget = input.sessionId || input.sessionName;
	if (!sessionTarget) {
		throw new Error("Missing tmux session target.");
	}
	return sessionTarget;
}

export function focusTmuxTarget(input: TmuxTargetInput): FocusTmuxTargetResult {
	const sessionTarget = getSessionTarget(input);
	if (!input.windowId) {
		throw new Error("Missing tmux window id.");
	}
	const commandParts = [
		`tmux attach-session -t ${shellQuote(sessionTarget)}`,
		`select-window -t ${shellQuote(input.windowId)}`,
		input.paneId ? `select-pane -t ${shellQuote(input.paneId)}` : null,
	].filter((value): value is string => Boolean(value));
	const command = commandParts.join(" \\; ");
	if (!process.env.TMUX) {
		return {
			focused: false,
			command,
			reason: "No active tmux client detected in this pi process.",
		};
	}
	runTmux(["switch-client", "-t", sessionTarget]);
	runTmux(["select-window", "-t", input.windowId]);
	if (input.paneId) {
		runTmux(["select-pane", "-t", input.paneId]);
	}
	return {
		focused: true,
		command,
	};
}

export function stopTmuxTarget(input: TmuxTargetInput, force = false): StopTmuxTargetResult {
	const sessionTarget = getSessionTarget(input);
	if (force) {
		if (input.paneId) {
			runTmux(["kill-pane", "-t", input.paneId]);
			return {
				stopped: true,
				graceful: false,
				command: `tmux kill-pane -t ${shellQuote(input.paneId)}`,
			};
		}
		if (input.windowId) {
			runTmux(["kill-window", "-t", input.windowId]);
			return {
				stopped: true,
				graceful: false,
				command: `tmux kill-window -t ${shellQuote(input.windowId)}`,
			};
		}
		runTmux(["kill-session", "-t", sessionTarget]);
		return {
			stopped: true,
			graceful: false,
			command: `tmux kill-session -t ${shellQuote(sessionTarget)}`,
		};
	}
	if (!input.paneId) {
		return {
			stopped: false,
			graceful: true,
			command: `tmux send-keys -t ${shellQuote(sessionTarget)} C-c`,
			reason: "Missing pane id for graceful stop. Use force=true.",
		};
	}
	runTmux(["send-keys", "-t", input.paneId, "C-c"]);
	return {
		stopped: false,
		graceful: true,
		command: `tmux send-keys -t ${shellQuote(input.paneId)} C-c`,
		reason: "Interrupt sent. If the child does not exit, use force=true.",
	};
}

export function captureTmuxTarget(input: TmuxTargetInput, lines = 200): CaptureTmuxTargetResult {
	const target = input.paneId || input.windowId || input.sessionId || input.sessionName;
	if (!target) {
		throw new Error("Missing tmux target for capture.");
	}
	const start = Math.max(0, lines);
	const command = `tmux capture-pane -p -S -${start} -t ${shellQuote(target)}`;
	const content = runTmux(["capture-pane", "-p", "-S", `-${start}`, "-t", target]);
	return { content, command };
}

export function getTmuxInventory(): TmuxInventory {
	const inventory: TmuxInventory = {
		sessions: new Set<string>(),
		sessionNames: new Set<string>(),
		windows: new Set<string>(),
		panes: new Set<string>(),
	};
	let output = "";
	try {
		output = runTmux(["list-panes", "-a", "-F", "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}"]);
	} catch {
		return inventory;
	}
	for (const line of output.split("\n")) {
		if (!line.trim()) continue;
		const [sessionId, sessionName, windowId, paneId] = line.split("\t");
		if (sessionId) inventory.sessions.add(sessionId);
		if (sessionName) inventory.sessionNames.add(sessionName);
		if (windowId) inventory.windows.add(windowId);
		if (paneId) inventory.panes.add(paneId);
	}
	return inventory;
}

export function tmuxTargetExists(input: TmuxTargetInput, inventory = getTmuxInventory()): boolean {
	if (input.paneId) return inventory.panes.has(input.paneId);
	if (input.windowId) return inventory.windows.has(input.windowId);
	if (input.sessionId) return inventory.sessions.has(input.sessionId);
	if (input.sessionName) return inventory.sessionNames.has(input.sessionName);
	return false;
}
