---
name: handoff-subagents
description: Convert one child agent’s output into a compact, structured handoff for another child agent.
---

# Handoff Subagents

Use this skill when one child’s findings or completion summary should become another child’s starting context.

## Rules

- Keep handoffs compact.
- Preserve exact file paths, identifiers, and unresolved risks.
- Do not dump giant raw transcripts when a concise synthesis will do.
- Mention what the next child should do first.
- Do not use `find`; use `grep` and `bash` with `rg --files` if you need more context.

## Suggested flow

1. Use `subagent_get` or `subagent_inbox` to read the source child’s summary.
2. Extract only:
   - completed work
   - relevant files
   - important identifiers and constraints
   - unresolved blockers or risks
3. Spawn or message the next child with a focused task built on that synthesis.
4. Tell the next child exactly what to validate, implement, or review.

## Handoff template

- Source child: `<id>`
- Relevant files:
  - `path/to/file`
- Key findings:
  - concise bullets
- Outstanding risks:
  - concise bullets
- Next child action:
  - first concrete step
