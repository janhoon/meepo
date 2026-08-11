import type { HierarchyPolicyMode } from "./config.js";

export type HierarchySpawnDecision =
	| { outcome: "allow"; note?: string }
	| { outcome: "deny"; reason: string }
	| { outcome: "advisory"; note: string };

export interface HierarchyEdgePolicyRow {
	id: string;
	allowSpawn: boolean;
}

export interface EvaluateHierarchySpawnInput {
	mode: HierarchyPolicyMode;
	parentAgentId: string;
	parentRoleKey: string | null;
	childRoleKey: string | null;
	/** null = no matching reports_to edge policy row */
	edgePolicy: HierarchyEdgePolicyRow | null;
}

/**
 * Pure hierarchy spawn gate.
 * - off: always allow (roles/edges optional)
 * - advisory: allow, but surface missing/denied policy as a note
 * - enforce: deny on missing roles, missing edge, or allow_spawn=0 (today's behavior)
 */
export function evaluateHierarchySpawn(input: EvaluateHierarchySpawnInput): HierarchySpawnDecision {
	const { mode, parentAgentId, parentRoleKey, childRoleKey, edgePolicy } = input;

	if (mode === "off") {
		return { outcome: "allow", note: "hierarchy policy off; edge checks skipped" };
	}

	if (!parentRoleKey || !childRoleKey) {
		const missing = !parentRoleKey ? "parent" : "child";
		const reason = `Cannot create hierarchy edge ${parentAgentId} -> child because ${missing} role is missing from agent_roles.`;
		if (mode === "enforce") return { outcome: "deny", reason };
		return { outcome: "advisory", note: reason };
	}

	if (!edgePolicy) {
		const reason = `No reports_to role edge policy allows ${parentRoleKey} to spawn ${childRoleKey}.`;
		if (mode === "enforce") return { outcome: "deny", reason };
		return { outcome: "advisory", note: reason };
	}

	if (!edgePolicy.allowSpawn) {
		const reason = `Role edge policy ${edgePolicy.id} does not allow spawning ${childRoleKey} under ${parentRoleKey}.`;
		if (mode === "enforce") return { outcome: "deny", reason };
		return { outcome: "advisory", note: reason };
	}

	return { outcome: "allow" };
}
