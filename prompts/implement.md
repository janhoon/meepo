---
description: Run a scout → planner → worker delegation flow for the given implementation task
---
Use the `dispatch-subagents`, `handoff-subagents`, and `supervise-subagents` skills as needed.

Goal: $@

Workflow:
1. Use `subagent_list` to inspect current children and reuse any suitable active child.
2. Spawn a `scout` if code discovery is still needed.
3. Spawn a `planner` to turn the findings into a concrete implementation plan.
4. Spawn a `worker` with a focused implementation task derived from that plan.
5. Supervise via `subagent_inbox` and `subagent_get`.
6. If the worker blocks, answer with `subagent_message`.
7. Return a concise summary of implementation progress or completion handoff.

Rules:
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Prefer exact file paths and concrete deliverables.
- Use graceful stop first if you need to interrupt a child.
