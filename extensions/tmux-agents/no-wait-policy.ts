export interface NoWaitPolicyViolation {
	kind: "sleep" | "watch" | "tail-follow" | "journal-follow" | "polling-loop" | "nested-shell";
	reason: string;
	guidance: string;
}

export const COORDINATION_NO_WAIT_PROMPT = [
	"## Meepo no-wait coordination policy",
	"- Do not spend a turn passively waiting for other agents, task updates, inbox rows, attention, review output, or tool completion owned by another process.",
	"- Never use `sleep`, `watch`, `tail -f`, shell polling loops, or retry loops to wait for subagent progress.",
	"- Treat `subagent_attention`, `subagent_inbox`, `subagent_get`, `task_attention`, `task_get`, and pane captures as snapshot reads. Take one pass, then act or yield.",
	"- If no published update is available, do one of: act on another ready task, answer/resolve an existing blocker, publish or return a concise pending-status summary, or end the turn.",
	"- For service readiness, prefer `tmux_service_start` with `readySubstring`; for one-off commands, use the command's own bounded timeout rather than an agent-level wait loop.",
].join("\n");

const SHELL_COMMAND_PREFIX = String.raw`(?:^|[;&|()\n]\s*|\b(?:do|then)\s+)`;
const SLEEP_COMMAND_PATTERN = new RegExp(`${SHELL_COMMAND_PREFIX}sleep(?:\\s|$)`);
const WATCH_COMMAND_PATTERN = new RegExp(`${SHELL_COMMAND_PREFIX}watch(?:\\s|$)`);
const TAIL_FOLLOW_PATTERN = new RegExp(`${SHELL_COMMAND_PREFIX}tail(?:\\s+[^\n;&|]*?)?\\s+-f\\b`);
const JOURNAL_FOLLOW_PATTERN = new RegExp(`${SHELL_COMMAND_PREFIX}journalctl(?:\\s+[^\n;&|]*?)?\\s+-f\\b`);
const TIMEOUT_SLEEP_PATTERN = new RegExp(`${SHELL_COMMAND_PREFIX}timeout\\b[^\n;&|]*\\bsleep\\b`);
const POLLING_LOOP_PATTERN = /\b(?:while|until)\b[\s\S]*?\bdo\b[\s\S]*?\bdone\b/;
const POLLING_HINT_PATTERN = /\b(?:sleep|watch|subagent_(?:attention|inbox|get|list|capture)|task_(?:attention|list|get)|tmux\s+capture-pane|sqlite3)\b/;
const NESTED_SHELL_PATTERN = /\b(?:ba)?sh\s+-[A-Za-z]*c[A-Za-z]*\s+(['"])([\s\S]*?)\1/g;
const QUOTED_SEGMENT_PATTERN = /'[^']*'|"(?:\\.|[^"\\])*"/g;

function stripQuotedSegments(command: string): string {
	return command.replace(QUOTED_SEGMENT_PATTERN, " ");
}

export function appendNoWaitPolicyToSystemPrompt(systemPrompt: string): string {
	if (systemPrompt.includes("## Meepo no-wait coordination policy")) return systemPrompt;
	return `${systemPrompt}\n\n${COORDINATION_NO_WAIT_PROMPT}`;
}

export function formatNoWaitPolicyViolation(violation: NoWaitPolicyViolation): string {
	return `${violation.reason}\n${violation.guidance}`;
}

export function getBashCommandFromToolInput(input: unknown): string | null {
	if (!input || typeof input !== "object") return null;
	const command = (input as { command?: unknown }).command;
	return typeof command === "string" ? command : null;
}

export function classifyNoWaitBashCommand(command: string): NoWaitPolicyViolation | null {
	const normalized = command.replace(/\r/g, "");
	if (!normalized.trim()) return null;

	for (const nestedMatch of normalized.matchAll(NESTED_SHELL_PATTERN)) {
		const nestedScript = nestedMatch[2] ?? "";
		const nestedViolation = classifyNoWaitBashCommand(nestedScript);
		if (nestedViolation) {
			return {
				kind: "nested-shell",
				reason: `Nested shell command violates no-wait policy: ${nestedViolation.reason}`,
				guidance: nestedViolation.guidance,
			};
		}
	}

	const topLevelCommand = stripQuotedSegments(normalized);

	if (POLLING_LOOP_PATTERN.test(topLevelCommand) && POLLING_HINT_PATTERN.test(topLevelCommand)) {
		return {
			kind: "polling-loop",
			reason: "Shell polling loops are not allowed for Meepo coordination.",
			guidance: "Read task/subagent attention or inbox once, then act on available work, publish a pending/blocker update, or end the turn instead of waiting.",
		};
	}

	if (SLEEP_COMMAND_PATTERN.test(topLevelCommand) || TIMEOUT_SLEEP_PATTERN.test(topLevelCommand)) {
		return {
			kind: "sleep",
			reason: "`sleep` is not allowed as a coordination primitive.",
			guidance: "Do not wait for another agent inside the current turn. Use one snapshot read, then continue other ready work or yield with a pending-status summary.",
		};
	}

	if (WATCH_COMMAND_PATTERN.test(topLevelCommand)) {
		return {
			kind: "watch",
			reason: "`watch` is not allowed for subagent/task monitoring.",
			guidance: "Use `subagent_attention`, `subagent_inbox`, or `task_attention` as one-shot snapshot reads, not a long-running monitor.",
		};
	}

	if (TAIL_FOLLOW_PATTERN.test(topLevelCommand)) {
		return {
			kind: "tail-follow",
			reason: "`tail -f` is not allowed for passive monitoring in an agent turn.",
			guidance: "Capture a bounded tail of logs once, then act or yield. Use a tracked tmux service for long-running processes.",
		};
	}

	if (JOURNAL_FOLLOW_PATTERN.test(topLevelCommand)) {
		return {
			kind: "journal-follow",
			reason: "`journalctl -f` is not allowed for passive monitoring in an agent turn.",
			guidance: "Read a bounded log snapshot once, then act or yield. Do not keep the turn open waiting for more output.",
		};
	}

	return null;
}
