---
description: Run a task-first scout → planner → worker delegation flow for the given implementation task
---
Use the `dispatch-subagents`, `handoff-subagents`, `supervise-subagents`, and `manage-tasks` skills as needed.

Goal: $@

Workflow:
1. Use `task_list` to find or confirm the task. Create it with `task_create` if needed.
2. Ensure the task has acceptance criteria and validation steps. Use a `planner` if they are still missing or if the work may need decomposition.
3. If the planner creates follow-on tasks, inspect them with `task_list` / `task_get` and choose the correct task id for the next worker.
4. Spawn a `scout` only if code discovery is still needed.
5. Spawn a `worker` attached to the target task for focused implementation.
6. Move the active execution task to `in_progress` while work is active.
7. Supervise via `subagent_inbox`, `subagent_get`, and `task_attention`.
8. If the worker blocks, answer with `subagent_message` and update the task if needed.
9. When implementation completes, move the task to `in_review` unless more execution work is clearly required.
10. Return a concise summary of task progress or completion handoff, including any planner-created follow-on tasks.

Rules:
- The board tracks tasks, not agents.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Prefer exact file paths and concrete deliverables.
- Use graceful stop first if you need to interrupt a child.
