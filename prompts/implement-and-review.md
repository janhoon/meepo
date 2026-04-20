---
description: Run a task-first worker → reviewer flow for the given task using tmux-backed subagents
---
Use the `dispatch-subagents`, `communicate-subagents`, `handoff-subagents`, `supervise-subagents`, and `manage-tasks` skills as needed.

Goal: $@

Workflow:
1. Use `task_list` to find or confirm the task. Create it with `task_create` if needed.
2. Inspect active children with `subagent_list`.
3. Spawn or reuse a `worker` attached to the task for implementation.
4. Once the worker reports completion, move the task to `in_review` and hand the result to a `reviewer` attached to the same task.
5. Triage reviewer findings with `subagent_inbox`, `subagent_get`, and `task_attention`.
6. If needed, send a targeted `subagent_message` back to the worker with fixes and move the task back to `in_progress`.
7. If review passes, move the task to `done`.
8. Return the final task status, key files, and any remaining follow-up.

Rules:
- The board tracks tasks, not agents.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Preserve file paths, risks, and validation gaps in every handoff.
- Keep feedback targeted and minimal.
