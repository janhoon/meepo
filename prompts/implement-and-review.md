---
description: Run a task-first engineer → review-pack flow for the given task using tmux-backed subagents
---
Use the `dispatch-subagents`, `communicate-subagents`, `handoff-subagents`, `supervise-subagents`, and `manage-tasks` skills as needed.

Goal: $@

Workflow:
1. Use `task_list` to find or confirm the task. Create it with `task_create` if needed.
2. Inspect active children with `subagent_list`.
3. Spawn or reuse an `engineer` attached to the task for implementation. For writing implementation work, request `workspaceStrategy: "dedicated_worktree"` unless the user or task explicitly opts out; omit `cwd` because dedicated worktree spawns provision/reuse the deterministic task worktree and reject explicit cwd. Use `workspaceStrategy: "spawn_cwd"` when intentionally opting out of task worktree inheritance.
4. Once the engineer reports completion, move the task to `in_review` and spawn a sibling review pack attached to the same task. Omit reviewer `cwd` unless an explicit override is needed so reviewers inherit the task worktree path.
5. The default review pack for non-trivial code is:
   - `principal-engineer` in `structured` mode
   - `principal-engineer` in `adversarial` mode
   - `principal-engineer` in `outside-voice` mode using a different model/provider when available
6. Add `qa-lead`, `design-lead`, or `cso` when the scope includes browser-visible behavior, UX/design quality, or security/trust-boundary risk.
7. Triage reviewer findings with `subagent_inbox`, `subagent_get`, and `task_attention`, then synthesize overlap versus unique findings before deciding on follow-up.
8. If fixes are needed, send a targeted `subagent_message` back to the `engineer`, move the task back to `in_progress`, and rerun only the reviewers that still matter after the fix.
9. Only move the task to `done` after the required review-pack members pass or the user explicitly waives the remaining gate.
10. Return the final task status, key files, review-pack outcome, and any remaining follow-up.

Rules:
- The board tracks tasks, not agents.
- Do not use `find`; use `grep` and `bash` with `rg --files`.
- Preserve file paths, risks, and validation gaps in every handoff.
- Keep feedback targeted and minimal.
- Never use `sleep` or shell polling loops to wait for worker or reviewer output.
- `subagent_attention`, `subagent_inbox`, `subagent_get`, and `task_attention` are snapshot reads, not long-poll tools.
- After messaging an engineer or reviewer, continue with other ready work or end the turn; do not block the turn waiting for asynchronous follow-up.
- “Keep going” means keep taking productive actions across ready tasks; it does not mean keeping the current turn open while waiting for child progress.
- Do not perform final acceptance QA yourself for non-trivial implementation work.
- Outside-voice review is a mode of `principal-engineer`, not a separate agent family. Use `model` overrides on `subagent_spawn` to get cross-model coverage.
- Browser acceptance should go to `qa-lead` or `design-lead` with G Stack Browser as the default browser path. Pi browser tools are fallback-only during migration.
