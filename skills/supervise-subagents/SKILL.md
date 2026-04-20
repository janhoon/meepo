---
name: supervise-subagents
description: Triage multiple active child agents, blocked tasks, and in-review work with task-first priorities.
---

# Supervise Subagents

Use this skill when multiple child agents are active and you need to decide what deserves attention first.

## Priority order

Always triage in this order:
1. blocked tasks waiting on the user
2. blocked tasks waiting on the coordinator
3. in-review tasks
4. child blockers and questions attached to active tasks
5. active running agents
6. idle/done/stopped agents

## Rules

- Use `task_attention` as the primary task-first unresolved queue.
- Use `subagent_attention` for child-originated blockers/questions/completions behind those tasks.
- Use `subagent_inbox` when you need the raw mailbox rows behind an attention item.
- Use `task_list` and `task_get` to understand the current task board.
- Use `subagent_list` to understand the current fleet and ownership.
- Prefer answering questions and unblocking children before spawning new ones.
- Treat `subagent_capture` as a debug fallback, not a normal supervision primitive.
- After completion has been synthesized, use `subagent_cleanup` so old terminal child tmux windows do not pile up.
- Use `subagent_reconcile` or `task_reconcile` if tmux state, task links, or registry state look stale.
- Use `subagent_focus` to jump to a child tmux window when live inspection is useful.
- Do not use `find`; use `grep` and `bash` with `rg --files` for discovery.

## Suggested loop

1. Read `task_attention`.
2. Read `subagent_attention` for the highest-priority attached child signals.
3. Use `subagent_inbox` only when you need raw published message details.
4. List current tasks/children with `task_list` and `subagent_list`.
5. Triage highest-priority unresolved items.
6. Send `subagent_message` replies with explicit action policies where appropriate, then wait for child-published follow-up updates.
7. Move tasks between `blocked`, `in_progress`, `in_review`, and `done` as the real work state changes.
8. Use `subagent_capture` only if published reporting is stale, missing, or obviously inconsistent.
9. Clean up terminal agents whose work has been synthesized with `subagent_cleanup`.
10. Summarize the task board and active fleet for the user in priority order.
