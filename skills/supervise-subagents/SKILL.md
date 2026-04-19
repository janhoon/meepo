---
name: supervise-subagents
description: Triage multiple active child agents, prioritizing user-facing questions, primary-facing questions, blockers, and unread completions.
---

# Supervise Subagents

Use this skill when multiple child agents are active and you need to decide what deserves attention first.

## Priority order

Always triage in this order:
1. user-facing questions
2. primary-facing questions
3. blocked children
4. unread completion summaries
5. active running agents
6. idle/done/stopped agents

## Rules

- Use `subagent_attention` as the primary unresolved-attention queue.
- Use `subagent_inbox` when you need the raw mailbox rows behind an attention item.
- Use `subagent_list` to understand the current fleet and ownership.
- Use `subagent_get` only for targeted drill-down.
- Prefer answering questions and unblocking children before spawning new ones.
- After completion has been synthesized, use `subagent_cleanup` so old terminal child tmux windows do not pile up.
- Use `subagent_reconcile` if tmux state or registry state looks stale.
- Use `subagent_focus` to jump to a child tmux window when live inspection is useful.
- Do not use `find`; use `grep` and `bash` with `rg --files` for discovery.

## Suggested loop

1. Read `subagent_attention`.
2. Use `subagent_inbox` only when you need the raw published message details.
3. List the current fleet with `subagent_list`.
4. Triage highest-priority unresolved items.
5. Send `subagent_message` replies or `subagent_stop` requests where appropriate.
6. Clean up terminal agents whose work has been synthesized with `subagent_cleanup`.
7. Reconcile stale items if needed.
8. Summarize the fleet for the user in priority order.
