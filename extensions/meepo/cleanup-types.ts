import type { AgentSummary, AttentionItemRecord } from "./types.js";

export interface CleanupCandidate {
	agent: AgentSummary;
	attentionItems: AttentionItemRecord[];
	targetExists: boolean;
	cleanupAllowed: boolean;
	reason: string;
}
