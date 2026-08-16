---
name: dispatch-subagents
description: Delegate work across process-hosted child agents (tmux or herdr) when tasks should be isolated by role, scope, or context window.
---

# Dispatch Subagents

Use this skill when work should be split across specialized child agents or isolated from the main context.

## Bring-your-own profiles

**Meepo does not ship agent profiles.** Consumers provide markdown profiles (usually under `~/.pi/agent/agents/*.md`, or extra dirs via `profiles.dirs`).

Before spawning:

1. Know which profile names exist in this install (spawn errors list available names; empty means no consumer pack is installed).
2. Pick a profile that already exists — do not invent names that Meepo might have “built in.”
3. Put run-specific instructions in the `task` string; put standing behavior in the consumer profile body.
4. If the needed job has no profile yet, follow `create-subagents` and restart Pi before spawning.

Profile frontmatter `lease` / `role` (when present) control task exclusivity and hierarchy keys. They are consumer metadata, not a Meepo role catalog.

## Rules

- The board tracks tasks, not agents.
- Prefer existing task tickets before creating new ones.
- Prefer existing active children before spawning duplicates.
- Attach new children to an existing `taskId` whenever possible.
- Choose the narrowest **available** consumer profile for the work.
- Keep each child task focused and concrete.
- Include exact file paths and expected deliverables in the delegated task.
- Dispatch is dependency-aware: spawn agents for dependency-free ready tickets, do not spawn agents for tickets with unresolved prerequisites, and after a prerequisite reaches `done`, inspect/spawn newly unblocked tickets immediately.
- Use `task_ready` to inspect the ready queue and `task_dispatch_ready` to launch one agent per dependency-free ticket using each ticket's `recommendedProfile` (must name a consumer profile that exists).
- Do not ask children to use `find`.
- Use `grep` and `bash` with `rg --files` as the canonical discovery workflow.

## Suggested flow

1. Use `task_list` to inspect whether the work already has a task.
2. Create the task with `task_create` if needed.
3. Use `subagent_list` to inspect already tracked children.
4. If no suitable child exists, use `subagent_spawn` with a clear title, task, **consumer** `profile`, and `taskId`.
5. Tell the child exactly what outcome you want, not just the topic area.
6. If planning creates follow-on tasks, inspect them with `task_list` / `task_get`, identify the dependency-free ready set with `task_ready`, and use `task_dispatch_ready` to spawn one appropriate agent for each ready ticket subject to WIP limits.
7. Leave tickets with unresolved dependencies unspawned and marked/recorded as blocked-by-ticket; do not create idle agents that can only wait.
8. After any dependency task completes, use `task_move`'s newly-ready dependents or run `task_dispatch_ready` to spawn newly unblocked work immediately.
9. When acceptance needs multiple angles, spawn sibling children on the same `taskId` using whatever **review-lease** profiles the consumer pack defines; synthesize findings through inbox/attention.
10. Rely on proactive child reporting through inbox/task updates instead of status polling.
11. Use `subagent_inbox`, `subagent_get`, and `task_get` as one-pass snapshots; if no output is available, switch to other ready work or end the turn instead of waiting.
12. Never use `sleep`, `watch`, `tail -f`, or shell polling loops to wait for children.

## Task-writing pattern

A good delegated task includes:
- linked task id
- scope
- exact files or directories to start from
- required output format
- what to do if blocked

Example (profile name is whatever the consumer installed):

- Title: `auth implementation`
- Profile: `<consumer-profile-name>`
- Task: `Task task_abc123. Implement the approved auth refresh flow. Start with src/auth and src/api. Return exact file paths changed, validation run, and whether the task should move to in_review or stay in_progress. If blocked, publish one concrete question and recommend the task state.`
