---
name: dispatch-subagents
description: Delegate work across tmux-backed child agents when tasks should be isolated by role, scope, or context window.
---

# Dispatch Subagents

Use this skill when work should be split across specialized child agents or isolated from the main context.

## Rules

- Prefer existing active children before spawning duplicates.
- Choose the narrowest useful profile:
  - `scout` for recon and file discovery
  - `planner` for implementation planning
  - `worker` for execution
  - `reviewer` for review and verification
  - `coordinator-helper` for synthesis across multiple children
- Keep each child task focused and concrete.
- Include exact file paths and expected deliverables in the delegated task.
- Do not ask children to use `find`.
- Use `grep` and `bash` with `rg --files` as the canonical discovery workflow.

## Suggested flow

1. Use `subagent_list` to inspect already tracked children.
2. If no suitable child exists, use `subagent_spawn` with a clear title, task, and profile.
3. Tell the child exactly what outcome you want, not just the topic area.
4. Rely on proactive child reporting through `subagent_publish` / inbox updates.
5. Use `subagent_inbox` and `subagent_get` to supervise without polling for status generation.

## Task-writing pattern

A good delegated task includes:
- scope
- exact files or directories to start from
- required output format
- what to do if blocked

Example:

- Title: `auth scout`
- Profile: `scout`
- Task: `Map the authentication flow for login and token refresh. Start with src/auth and src/api. Return exact file paths, key functions, and the first file a worker should edit. If blocked, publish one concrete question.`
