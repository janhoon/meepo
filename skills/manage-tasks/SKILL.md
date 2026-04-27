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
- When planning creates follow-on tasks, capture dependency order explicitly: each child ticket must either declare its prerequisite tickets or state that it is dependency-free and ready to dispatch.
- Use first-class task links for dependencies: `task_link` with `sourceTaskId=A`, `targetTaskId=B`, `linkType=depends_on` means A cannot dispatch until B is done.
- Set `recommendedProfile` on executable tickets so `task_dispatch_ready` can launch the right agent as soon as dependencies clear.
- Keep acceptance criteria, plan steps, validation steps, and relevant files up to date.

## Suggested flow

1. Use `task_list` to look for an existing matching task.
2. If none exists, use `task_create`.
3. Use `task_get` to inspect current task state and linked agents.
4. Use `task_update` to refine scope, acceptance criteria, plan, files, and labels.
5. If planning reveals multiple independently executable work items, create follow-on tasks with `task_create`, set `recommendedProfile`, create `task_link` dependency relationships, and note the ready set on the parent task.
6. Use `task_move` when the lifecycle state changes.
7. Use `task_note` for durable handoffs or important context that should stay on the ticket.
8. Use `task_attention` to triage blocked and in-review work.
9. When a planner has created follow-on tasks, run `task_ready`/`task_dispatch_ready`, spawn one appropriate agent for each dependency-free ticket, and leave dependency-blocked tickets unowned until their prerequisites resolve.
10. After moving a task to `done`, use the newly-ready dependents returned by `task_move`; with auto-dispatch enabled, agents are spawned immediately for ready dependents with `recommendedProfile`.
11. Use `task_reconcile` if legacy agents or stale links make the board inconsistent.
