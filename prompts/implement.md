---
description: Run a task-first planning → engineer → review-pack flow for the given implementation task
---
Use the `dispatch-subagents`, `handoff-subagents`, `supervise-subagents`, and `manage-tasks` skills as needed.

Goal: $@

Workflow:
1. Use `task_list` to find or confirm the task. Create it with `task_create` if needed.
2. Ensure the task has acceptance criteria, validation steps, `recommendedProfile`, and dependency metadata. Use `ceo` when product framing or scope needs work. Use `cto` when architecture or validation planning needs hardening. Use `planner` only as a legacy narrow task-refinement helper when that is sufficient.
3. If planning creates follow-on tasks, inspect them with `task_list` / `task_get`, ensure first-class `task_link` dependencies exist, identify dependency-free tickets with `task_ready`, and choose the correct ready task id(s) for execution.
4. Spawn a `scout` only if code discovery is still needed.
5. Use `task_dispatch_ready` or `subagent_spawn` to spawn one engineer/appropriate profile attached to each dependency-free ready implementation ticket, subject to WIP limits; do not spawn agents for unresolved dependency-blocked tickets.
6. Move active execution task(s) to `in_progress` while work is active.
7. Supervise via `subagent_inbox`, `subagent_get`, and `task_attention`.
8. If the engineer blocks, answer with `subagent_message` and update the task if needed.
9. When implementation completes, move the task to `in_review` unless more execution work is clearly required; after acceptance/done, inspect downstream dependencies and spawn newly unblocked tickets immediately.
10. For non-trivial code, queue a review pack instead of self-review. The default pack is `principal-engineer` in `structured`, `adversarial`, and `outside-voice` modes, with `qa-lead`, `design-lead`, and `cso` added when scope requires them.
11. Return a concise summary of task progress or the implementation handoff, including any planning-created follow-on tasks, dependency readiness, dispatched tickets, and pending review-pack steps.

Rules:
- The board tracks tasks, not agents.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Prefer exact file paths and concrete deliverables.
- Use graceful stop first if you need to interrupt a child.
- Never use `sleep`, `watch`, `tail -f`, or shell polling loops to wait for subagent progress, attention, inbox messages, or review output.
- `subagent_attention`, `subagent_inbox`, `subagent_get`, `subagent_capture`, and `task_attention` are snapshot reads, not long-poll tools.
- If a child is in flight and no attention item is open, either continue with another dependency-free ready task or end the turn with a brief pending-status summary.
- Treat `A depends_on B` as a dispatch gate: no agent for A until B is resolved; when B is done, `task_move`/`task_dispatch_ready` should spawn A if all prerequisites are resolved and `recommendedProfile` is set.
- “Keep going” means keep taking productive actions across ready tasks; it does not mean keeping the current turn open while waiting for asynchronous child progress.
- Do not self-accept non-trivial implementation work. Your own checks are triage only; acceptance belongs to the review pack.
- Browser-facing acceptance should go to `qa-lead` or `design-lead`, with G Stack Browser as the default browser path and Pi browser tools as fallback-only.
