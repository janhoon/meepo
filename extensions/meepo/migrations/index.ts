import type { Migration } from "./types.js";
import { migration as migration1 } from "./001-initial-subagent-registry.js";
import { migration as migration2 } from "./002-tracked-tmux-services.js";
import { migration as migration3 } from "./003-attention-items.js";
import { migration as migration4 } from "./004-task-first-board-and-links.js";
import { migration as migration5 } from "./005-agent-rpc-bridge-transport.js";
import { migration as migration6 } from "./006-hierarchy-communication-foundation.js";
import { migration as migration7 } from "./007-task-dependency-links.js";
import { migration as migration8 } from "./008-coo-orchestration-role-policies.js";
import { migration as migration9 } from "./009-process-host-neutral-fields.js";

export type { Migration } from "./types.js";

export const MIGRATIONS: Migration[] = [
	migration1,
	migration2,
	migration3,
	migration4,
	migration5,
	migration6,
	migration7,
	migration8,
	migration9,
];
