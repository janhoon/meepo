---
description: Delegate scouting and planning across tmux-backed subagents for the given task
---
Use the `dispatch-subagents`, `handoff-subagents`, and `supervise-subagents` skills as needed.

Goal: $@

Workflow:
1. Inspect the current fleet with `subagent_list` to avoid duplicate delegation.
2. Spawn a `scout` if needed to map relevant files, identifiers, and architecture.
3. Read the scout output through `subagent_inbox` / `subagent_get`.
4. Hand off the concise findings to a `planner`.
5. Return a concise summary of the resulting plan, including key files, risks, and recommended next step.

Rules:
- Prefer proactive child reporting over polling for status generation.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Keep delegated tasks narrow and file-specific.
