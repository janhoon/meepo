import { truncateText } from "./text-util.js";
import type { AgentMessageRecord, DownwardMessageActionPolicy, DownwardMessagePayload } from "./types.js";

export function defaultDownwardActionPolicy(kind: AgentMessageRecord["kind"]): DownwardMessageActionPolicy {
	switch (kind) {
		case "answer":
			return "resume_if_blocked";
		case "redirect":
			return "interrupt_and_replan";
		case "cancel":
			return "stop";
		case "priority":
			return "replan";
		case "note":
		default:
			return "fyi";
	}
}

export function expectedHandlingLines(actionPolicy: DownwardMessageActionPolicy): string[] {
	switch (actionPolicy) {
		case "resume_if_blocked":
			return [
				"If this resolves your current blocker or waiting state, resume work now.",
				"Publish a concise note once you resume so the coordinator can track progress without capture.",
				"If you are still blocked after this message, publish one concrete blocker or question immediately.",
			];
		case "replan":
			return [
				"Revise your plan before the next substantive tool call if this changes your priorities.",
				"Publish a concise note if the plan or file focus changes.",
			];
		case "interrupt_and_replan":
			return [
				"Stop the current approach and replan before more substantive work.",
				"Publish a concise note after adopting this redirect, with exact file paths when relevant.",
			];
		case "stop":
			return [
				"Stop current work gracefully.",
				"Publish a completion-style handoff or cancellation summary before exiting if possible.",
			];
		case "fyi":
		default:
			return [
				"Treat this as additional context. Continue unless it materially changes your plan.",
				"Publish a concise note only if this changes your course of action.",
			];
	}
}

export function formatDownwardMessage(message: AgentMessageRecord): string {
	const payload = (message.payload && typeof message.payload === "object" ? message.payload : {}) as DownwardMessagePayload;
	const actionPolicy = payload.actionPolicy ?? defaultDownwardActionPolicy(message.kind);
	const sender = payload.senderAgentId ?? message.senderAgentId ?? "root";
	const route = payload.routeKind ? ` · route ${payload.routeKind}` : "";
	const lines = [`[Hierarchy ${message.kind} · from ${sender} · action ${actionPolicy}${route}]`];
	if (payload.summary) lines.push(payload.summary);
	if (payload.details) lines.push("", payload.details);
	if (Array.isArray(payload.files) && payload.files.length > 0) {
		lines.push("", `Files: ${payload.files.join(", ")}`);
	}
	if (payload.inReplyToMessageId) {
		lines.push("", `Replying to message: ${payload.inReplyToMessageId}`);
	}
	if (payload.coalescedMessageIds && payload.coalescedMessageIds.length > 0) {
		lines.push("", `Coalesced prior resume/wake messages: ${payload.coalescedMessageIds.join(", ")}`);
	}
	if (payload.coalescedWakeMessages && payload.coalescedWakeMessages.length > 0) {
		lines.push("", "Prior coalesced wake context:");
		for (const prior of payload.coalescedWakeMessages) {
			lines.push(`- ${prior.kind} ${prior.id}: ${prior.summary}`);
			if (prior.details) lines.push(`  details: ${truncateText(prior.details, 220)}`);
			if (prior.files && prior.files.length > 0) lines.push(`  files: ${prior.files.join(", ")}`);
			if (prior.inReplyToMessageId) lines.push(`  inReplyToMessageId: ${prior.inReplyToMessageId}`);
		}
	}
	lines.push("", "Expected handling:");
	for (const line of expectedHandlingLines(actionPolicy)) {
		lines.push(`- ${line}`);
	}
	return lines.join("\n");
}
