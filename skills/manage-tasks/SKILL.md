---
name: manage-tasks
description: Create, refine, move, and inspect task tickets so the board remains task-first instead of agent-first.
---

# Manage Tasks

Use this skill whenever work should first be captured, updated, or triaged as a task.

## Rules

- The board tracks tasks, not agents.
- Create/select the task before spawning children whenever possible.
- Use these board states consistently:
  - `todo` — captured and ready, not actively executing
  - `blocked` — cannot proceed; set `waitingOn`
  - `in_progress` — active execution is happening
  - `in_review` — execution is complete enough for validation/acceptance
  - `done` — accepted and closed
- `waitingOn` is metadata on a blocked task, not a separate board column.
- Prefer `task_update` for scope/criteria/details changes and `task_move` for lifecycle transitions.
- Planners may create follow-on tasks when one request decomposes into multiple independently executable work items.
- Keep acceptance criteria, plan steps, validation steps, and relevant files up to date.

## Suggested flow

1. Use `task_list` to look for an existing matching task.
2. If none exists, use `task_create`.
3. Use `task_get` to inspect current task state and linked agents.
4. Use `task_update` to refine scope, acceptance criteria, plan, files, and labels.
5. If planning reveals multiple independently executable work items, create follow-on tasks with `task_create` and note them on the parent task.
6. Use `task_move` when the lifecycle state changes.
7. Use `task_note` for durable handoffs or important context that should stay on the ticket.
8. Use `task_attention` to triage blocked and in-review work.
9. When a planner has created follow-on tasks, the orchestrator should inspect them with `task_list` / `task_get` and delegate the right agents against those task ids.
10. Use `task_reconcile` if legacy agents or stale links make the board inconsistent.
