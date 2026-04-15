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

- Use `subagent_inbox` and `subagent_list` as the primary supervision surfaces.
- Use `subagent_get` only for targeted drill-down.
- Prefer answering questions and unblocking children before spawning new ones.
- Use `subagent_reconcile` if tmux state or registry state looks stale.
- Use `subagent_focus` to jump to a child tmux window when live inspection is useful.
- Do not use `find`; use `grep` and `bash` with `rg --files` for discovery.

## Suggested loop

1. Read `subagent_inbox`.
2. List the current fleet with `subagent_list`.
3. Triage highest-priority unread items.
4. Send `subagent_message` replies or `subagent_stop` requests where appropriate.
5. Reconcile stale items if needed.
6. Summarize the fleet for the user in priority order.
