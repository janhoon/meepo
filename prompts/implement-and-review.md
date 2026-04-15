---
description: Run a worker → reviewer flow for the given task using tmux-backed subagents
---
Use the `dispatch-subagents`, `communicate-subagents`, `handoff-subagents`, and `supervise-subagents` skills as needed.

Goal: $@

Workflow:
1. Inspect active children with `subagent_list`.
2. Spawn or reuse a `worker` for implementation.
3. Once the worker reports completion, hand the result to a `reviewer`.
4. Triage reviewer findings with `subagent_inbox` and `subagent_get`.
5. If needed, send a targeted `subagent_message` back to the worker with fixes.
6. Return the final review status, key files, and any remaining follow-up.

Rules:
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Preserve file paths, risks, and validation gaps in every handoff.
- Keep feedback targeted and minimal.
