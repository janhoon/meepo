---
description: Delegate task-first scouting and planning across tmux-backed subagents for the given task
---
Use the `dispatch-subagents`, `handoff-subagents`, `supervise-subagents`, and `manage-tasks` skills as needed.

Goal: $@

Workflow:
1. Use `task_list` to find or confirm the task. Create it with `task_create` if it does not exist yet.
2. Inspect the current fleet with `subagent_list` to avoid duplicate delegation.
3. Spawn a `scout` against the task if code discovery is still needed.
4. Read the scout output through `subagent_inbox` / `subagent_get`.
5. Hand off the concise findings to a `planner` attached to the same task.
6. If the planner creates follow-on tasks, inspect them with `task_list` / `task_get`, preserve the decomposition and first-class `task_link` dependency graph in the parent task, and identify the dependency-free ready set with `task_ready`.
7. Use `task_dispatch_ready` to spawn one appropriate agent for each dependency-free ready ticket with `recommendedProfile`; do not spawn agents for tickets whose prerequisites are unresolved.
8. Update the planned task(s) toward `todo` if planning is complete, or `blocked` if clarification/dependencies still prevent execution.
9. Return a concise summary of the resulting task plan, including key files, risks, dependency order, ready tickets dispatched, and blocked follow-on task ids.

Rules:
- The board tracks tasks, not agents.
- Prefer proactive child reporting over polling for status generation.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Keep delegated tasks narrow and file-specific.
- Never use `sleep`, `watch`, `tail -f`, or shell polling loops to wait for scout or planner output.
- `subagent_attention`, `subagent_inbox`, `subagent_get`, and `subagent_capture` are snapshot reads, not long-poll tools.
- If the scout or planner has no published output yet, continue with other ready work or end the turn with a brief pending-status summary instead of waiting.
- After planning decomposes work, dispatch all dependency-free tickets in parallel where practical; as each prerequisite resolves, spawn the next newly unblocked ticket instead of leaving it idle.
