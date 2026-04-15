---
name: communicate-subagents
description: Handle child questions, blockers, redirects, and answers using the registry and structured downward messages.
---

# Communicate Subagents

Use this skill when a child agent has already surfaced a question, blocker, or completion update and you need to respond.

## Rules

- Do not poll children for status as the normal control flow.
- Read what children already published with `subagent_inbox` and `subagent_get`.
- Send downward communication with `subagent_message`.
- Keep answers concrete, minimal, and path-specific.
- Ask children for only the next action needed.
- Do not use `find`; use `grep` and `bash` with `rg --files` if extra discovery is needed.

## Message kinds

Use these structured kinds:
- `answer` — respond to a child question
- `note` — provide context without changing direction
- `redirect` — change scope or direction
- `cancel` — ask the child to stop current work
- `priority` — tell the child what matters most now

## Suggested flow

1. Use `subagent_inbox` to read unread child-originated messages.
2. If needed, use `subagent_get` to inspect the target child’s current state.
3. Send a structured `subagent_message` with the smallest sufficient context.
4. If the child should stop, prefer a graceful `cancel` first.
5. If the child is hung, use `subagent_stop`.
