---
name: handoff-subagents
description: Convert one child agent’s output into a compact, task-aware handoff for another child agent.
---

# Handoff Subagents

Use this skill when one child’s findings or completion summary should become another child’s starting context.

## Rules

- Keep handoffs compact.
- Preserve exact file paths, identifiers, unresolved risks, and task ids.
- Do not dump giant raw transcripts when a concise synthesis will do.
- Mention what the next child should do first.
- Keep the handoff anchored to the same tracked task unless you are intentionally splitting into subtasks.
- Do not use `find`; use `grep` and `bash` with `rg --files` if you need more context.

## Suggested flow

1. Use `task_get`, `subagent_get`, or `subagent_inbox` to read the source child’s summary.
2. Extract only:
   - completed work
   - relevant files
   - important identifiers and constraints
   - unresolved blockers or risks
   - recommended task state
3. Spawn or message the next child with a focused task built on that synthesis and the same `taskId`.
4. Tell the next child exactly what to validate, implement, or review.

## Handoff template

- Task: `<task-id>`
- Source child: `<id>`
- Relevant files:
  - `path/to/file`
- Key findings:
  - concise bullets
- Outstanding risks:
  - concise bullets
- Recommended task state:
  - `todo` | `blocked` | `in_progress` | `in_review` | `done`
- Next child action:
  - first concrete step
