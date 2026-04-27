---
name: dispatch-subagents
description: Delegate work across tmux-backed child agents when tasks should be isolated by role, scope, or context window.
---

# Dispatch Subagents

Use this skill when work should be split across specialized child agents or isolated from the main context.

## Rules

- The board tracks tasks, not agents.
- Prefer existing task tickets before creating new ones.
- Prefer existing active children before spawning duplicates.
- Attach new children to an existing `taskId` whenever possible.
- Choose the narrowest useful profile:
  - `ceo` for product framing, wedge, and scope decisions
  - `cto` for architecture and execution-plan hardening
  - `engineer` for implementation
  - `principal-engineer` for structured, adversarial, or outside-voice code review
  - `qa-lead` for browser QA and acceptance
  - `design-lead` for UX and visual review
  - `cso` for security review
  - legacy helpers `scout`, `planner`, `reviewer`, and `coordinator-helper` when those narrower compatibility roles are still the best fit
- For non-trivial code review, prefer a sibling review pack over a single reviewer.
- Outside-voice review is a mode of `principal-engineer`; use `model` overrides on `subagent_spawn` instead of inventing a separate agent family.
- Browser-facing work should prefer `qa-lead` or `design-lead` with G Stack Browser as the default browser path. Pi browser tools are fallback-only during migration.
- Keep each child task focused and concrete.
- Include exact file paths and expected deliverables in the delegated task.
- Do not ask children to use `find`.
- Use `grep` and `bash` with `rg --files` as the canonical discovery workflow.

## Suggested flow

1. Use `task_list` to inspect whether the work already has a task.
2. Create the task with `task_create` if needed.
3. Use `subagent_list` to inspect already tracked children.
4. If no suitable child exists, use `subagent_spawn` with a clear title, task, profile, and `taskId`.
5. Tell the child exactly what outcome you want, not just the topic area.
6. If planning creates follow-on tasks, inspect them with `task_list` / `task_get` and then spawn the next agent against the selected task id.
7. For non-trivial implementation acceptance, spawn the required review-pack siblings on the same task id and synthesize their findings through inbox/attention surfaces.
8. Rely on proactive child reporting through inbox/task updates instead of status polling.
9. Use `subagent_inbox`, `subagent_get`, and `task_get` as one-pass snapshots; if no output is available, switch to other ready work or end the turn instead of waiting.
10. Never use `sleep`, `watch`, `tail -f`, or shell polling loops to wait for children.

## Task-writing pattern

A good delegated task includes:
- linked task id
- scope
- exact files or directories to start from
- required output format
- what to do if blocked

Example:

- Title: `auth engineer`
- Profile: `engineer`
- Task: `Task task_abc123. Implement the approved auth refresh flow. Start with src/auth and src/api. Return exact file paths changed, validation run, and whether the task should move to in_review or stay in_progress. If blocked, publish one concrete question and recommend the task state.`
