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
  - `scout` for recon and file discovery
  - `planner` for task refinement and implementation planning
  - `worker` for execution
  - `reviewer` for review and verification
  - `coordinator-helper` for synthesis across multiple tasks/children
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
6. If a planner creates follow-on tasks, inspect them with `task_list` / `task_get` and then spawn the next agent against the selected task id.
7. Rely on proactive child reporting through inbox/task updates instead of status polling.
8. Use `subagent_inbox`, `subagent_get`, and `task_get` to supervise without polling for status generation.

## Task-writing pattern

A good delegated task includes:
- linked task id
- scope
- exact files or directories to start from
- required output format
- what to do if blocked

Example:

- Title: `auth scout`
- Profile: `scout`
- Task: `Task task_abc123. Map the authentication flow for login and token refresh. Start with src/auth and src/api. Return exact file paths, key functions, and the first file a worker should edit. If blocked, publish one concrete question and recommend the task state.`
