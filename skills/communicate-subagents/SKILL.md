---
name: communicate-subagents
description: Handle child questions, blockers, redirects, and answers using the registry, task state, and structured downward messages.
---

# Communicate Subagents

Use this skill when a child agent has already surfaced a question, blocker, or completion update and you need to respond.

## Rules

- Do not poll children for status as the normal control flow.
- Read what children already published with `subagent_inbox`, `subagent_get`, and `task_get`.
- Send downward communication with `subagent_message`.
- Prefer structured messages plus child follow-up publishes over `subagent_capture` for normal orchestration.
- Never use `bash` with `sleep`, `watch`, `while`, or retry loops to wait for a child reply.
- Keep answers concrete, minimal, and path-specific.
- Ask children for only the next action needed.
- Update the linked task state when the answer changes the real work state.
- Do not use `find`; use `grep` and `bash` with `rg --files` if extra discovery is needed.

## Message kinds

Use these structured kinds:
- `answer` — respond to a child question
- `note` — provide context without changing direction
- `redirect` — change scope or direction
- `cancel` — ask the child to stop current work
- `priority` — tell the child what matters most now

## Suggested flow

1. Use `task_attention` or `subagent_inbox` to identify the active blocker/question.
2. If needed, use `subagent_get` and `task_get` to inspect the target child and linked task.
3. Send a structured `subagent_message` with the smallest sufficient context and an explicit action policy when useful.
4. If the task state should change, update it with `task_move` or `task_update`.
5. Expect the child to publish a note/blocker/completion update later; do not keep the turn open with `sleep` or polling.
6. If something else is actionable, continue with that work; otherwise end the turn and let a later turn handle the follow-up.
7. If the child should stop, prefer a graceful `cancel` first.
8. If the child is hung or published reporting is clearly inconsistent, use `subagent_stop` or `subagent_capture` as a debug fallback.
