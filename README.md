# meepo

> One Pi agent, many replicas.
> tmux-backed subagents, tracked services, and enough coordination to keep the whole pack moving together.

`meepo` is a Pi package for running child agents in tracked tmux windows and managing long-running tmux services alongside them.

It is named after the Dota 2 hero for a very specific reason: Meepo is strongest when one becomes many, and this repo gives Pi that same trick. You can spawn focused replicas, keep each one in its own tmux context, let them report questions or blockers upward, and message them back without losing track of the squad.

If you want the practical version: this package makes multi-agent Pi workflows feel less like "open a bunch of terminals and hope" and more like "replica control, but with receipts."

## Why the name fits

In Dota, Meepo talks to his replicas.
In this repo, the primary agent can:

- spawn replicas with `subagent_spawn`
- keep tabs on them through a shared registry
- read proactive updates through `subagent_inbox`
- answer, redirect, reprioritize, or stop them with `subagent_message` and `subagent_stop`
- jump into any replica's tmux window with `subagent_focus`
- capture recent output with `subagent_capture`

So yes: the repo is literally about coordinating a small army of Meepos.

## What this package adds to Pi

### Task-first tmux-backed subagents

Capture work as tracked tasks first, then spawn focused child agents in isolated tmux windows to execute against those tasks. Agent lifecycle remains visible, but the board now reflects task lifecycle instead of agent lifecycle.

### Replica-to-parent communication

Children report upward proactively instead of making the primary agent poll them for status all day. Questions, blockers, milestones, and completions can all flow back through the registry.

### RPC bridge-backed child control plane

New child launches are moving to a tmux-side RPC bridge. That bridge runs visibly in the child tmux pane, launches `pi --mode rpc`, persists bridge status/events into the run directory, and gives the coordinator a live control path for prompt/steer/follow-up style child messaging.

### Tracked long-running services

Launch API servers, frontend dev servers, watchers, or other long-running commands in tracked tmux windows and manage them with the same focus/capture/stop/reconcile workflow.

### Orchestration scaffolding

The package also includes reusable agent profiles, orchestration skills, and prompt templates for splitting work across both legacy scout/planner/worker/reviewer flows and newer org-style role flows backed by upstream G Stack methodology.

## Included in the box

- `extensions/tmux-agents/`
  - subagent registry, spawn/runtime flow, messaging, reconcile, dashboard
  - tracked tmux services for API servers, frontend dev servers, watchers, and other long-running commands
- `skills/`
  - `dispatch-subagents`
  - `communicate-subagents`
  - `handoff-subagents`
  - `supervise-subagents`
  - `manage-tasks`
- `prompts/`
  - `implement`
  - `implement-and-review`
  - `scout-and-plan`
- `agents/`
  - org-style roles: `coo`, `ceo`, `cto`, `engineer`, `principal-engineer`, `qa-lead`, `design-lead`, `cso`
  - legacy helpers: `worker`, `scout`, `planner`, `reviewer`, `coordinator-helper`

## Install with Pi

```bash
pi install git:github.com/janhoon/meepo
```

Or use it directly from a local checkout:

```bash
pi install /path/to/meepo
```

## Main tools

### Task tools

- `task_create`
- `task_list`
- `task_get`
- `task_update`
- `task_move`
- `task_note`
- `task_link_agent`
- `task_unlink_agent`
- `task_attention`
- `task_reconcile`
- `task_worktree_cleanup`

### Subagent tools

- `subagent_spawn` (task-aware; auto-creates a task if `taskId` is omitted)
- `subagent_list`
- `subagent_get`
- `subagent_focus`
- `subagent_stop`
- `subagent_message`
- `subagent_inbox`
- `subagent_attention`
- `subagent_cleanup`
- `subagent_capture`
- `subagent_reconcile`

### Long-running tmux service tools

- `tmux_service_start`
- `tmux_service_list`
- `tmux_service_get`
- `tmux_service_focus`
- `tmux_service_stop`
- `tmux_service_capture`
- `tmux_service_reconcile`

## Interactive commands

### Task and agent control

- `/task-board`
- `/tasks [scope]`
- `/task-new`
- `/task-open <id>`
- `/task-move <id> [state]`
- `/task-note <id> <message>`
- `/task-link-agent <task-id> <agent-id> [role]`
- `/task-unlink-agent <task-id> <agent-id>`
- `/task-attention [scope]`
- `/task-sync [scope]`
- `/task-worktree-cleanup [task-id|scope] [remove] [force]`
- `/task-spawn [task-id]`
- `/agents`
- `/agent-open <id>`
- `/agent-stop <id> [force]`
- `/agent-message <id> <kind> <message>`
- `/agent-capture <id> [lines]`
- `/agent-sync`
- `/agent-attention [scope]`
- `/agent-cleanup [scope] [force]`

### Service control

- `/service-start`
- `/services [scope]`
- `/service-open <id>`
- `/service-stop <id> [force]`
- `/service-capture <id> [lines]`
- `/service-sync`

## A typical flow

1. Create or locate a task with `task_create` / `task_list`.
2. Spawn a scout, planner, worker, or reviewer against that `taskId`.
3. Let the child report back with a question, blocker, or completion.
4. Reply with `subagent_message` and move the task with `task_move` when the real work state changes.
5. Open `/task-board` when you want a Pi-native board view of `todo`, `blocked`, `in_progress`, `in_review`, and `done` work.
6. Spin up a tracked service with `tmux_service_start` if the task needs an app server, watcher, or dev environment.
7. Run `subagent_cleanup` or `/agent-cleanup` to remove finished tmux child windows once their work has been synthesized.
8. Run `task_worktree_cleanup` or `/task-worktree-cleanup` to preview task-linked worktree cleanup. Add `remove` only when you explicitly want eligible done-task dedicated git worktrees removed; branches are never deleted.
9. Focus, capture, reconcile, or stop anything in the pack as needed.

In other words: split the work, keep the replicas coordinated, and avoid the classic "which terminal was doing the important thing?" problem.

## Notes

- Child agents report upward proactively through the registry instead of relying on status polling.
- Bridge-backed children expose transport state in operator-facing surfaces. The full vocabulary is `legacy`, `launching`, `listening`, `live`, `fallback`, `disconnected`, `stopped`, `error`, and `lost`. A healthy launch progresses `launching → listening → live`.
- The coordinator can now attempt live downward child delivery through the RPC bridge before falling back to the child-side mailbox poll path.
- First-wave browser-facing role work prefers G Stack Browser-backed roles such as `qa-lead` and `design-lead`; Pi browser tools remain fallback-only during migration and troubleshooting.
- The task board is task-first. Agents are linked executors, not the board cards themselves.
- Task and agent details include effective worktree strategy/id/cwd/status. Worktree status distinguishes active, reusable, conflict, stale/missing, preserved existing worktree, and ready-cleanup states.
- Worktree cleanup is conservative: only `dedicated_worktree` checkouts for `done` tasks with no active linked agents are removable, cleanup previews by default, dirty worktrees require `force`, `existing_worktree`/`spawn_cwd` metadata is preserved, and git branches are never deleted.
- Search policy is ripgrep-first. `find` is intentionally excluded from the normal workflow.
- Agent profiles live in `agents/` because the extension resolves them relative to its package layout.
- The real superpower here is not just spawning more agents. It is keeping the task graph legible.

## Docs

- `docs/TMUX_SUBAGENTS_IMPLEMENTATION.md`
- `docs/TMUX_SUBAGENTS_PROGRESS.md`
- `docs/GSTACK_INTEGRATION.md`
- `docs/GSTACK_UPSTREAM_STATUS.md`
- `docs/REVIEW_PACKS.md`
- `docs/GSTACK_ROLLOUT.md`

## Final pitch

If Pi needed a hero name for "spawn a bunch of coordinated replicas, talk to them, and keep the whole operation under control," it was always going to be `meepo`.
