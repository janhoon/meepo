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

### tmux-backed subagents

Spawn focused child agents in isolated tmux windows, track their lifecycle, and keep structured state in a registry.

### Replica-to-parent communication

Children report upward proactively instead of making the primary agent poll them for status all day. Questions, blockers, milestones, and completions can all flow back through the registry.

### Tracked long-running services

Launch API servers, frontend dev servers, watchers, or other long-running commands in tracked tmux windows and manage them with the same focus/capture/stop/reconcile workflow.

### Orchestration scaffolding

The package also includes reusable agent profiles, orchestration skills, and prompt templates for splitting work across scout/planner/worker/reviewer style flows.

## Included in the box

- `extensions/tmux-agents/`
  - subagent registry, spawn/runtime flow, messaging, reconcile, dashboard
  - tracked tmux services for API servers, frontend dev servers, watchers, and other long-running commands
- `skills/`
  - `dispatch-subagents`
  - `communicate-subagents`
  - `handoff-subagents`
  - `supervise-subagents`
- `prompts/`
  - `implement`
  - `implement-and-review`
  - `scout-and-plan`
- `agents/`
  - `worker`
  - `scout`
  - `planner`
  - `reviewer`
  - `coordinator-helper`

## Install with Pi

```bash
pi install git:github.com/janhoon/meepo
```

Or use it directly from a local checkout:

```bash
pi install /path/to/meepo
```

## Main tools

### Subagent tools

- `subagent_spawn`
- `subagent_list`
- `subagent_get`
- `subagent_focus`
- `subagent_stop`
- `subagent_message`
- `subagent_inbox`
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

### Agent control

- `/agents`
- `/agent-spawn`
- `/agent-open <id>`
- `/agent-stop <id> [force]`
- `/agent-message <id> <kind> <message>`
- `/agent-capture <id> [lines]`
- `/agent-sync`

### Service control

- `/service-start`
- `/services [scope]`
- `/service-open <id>`
- `/service-stop <id> [force]`
- `/service-capture <id> [lines]`
- `/service-sync`

## A typical flow

1. Spawn a scout or planner.
2. Let the child report back with a question, blocker, or completion.
3. Reply with `subagent_message` instead of juggling detached terminals manually.
4. Spin up a tracked service with `tmux_service_start` if the task needs an app server, watcher, or dev environment.
5. Focus, capture, reconcile, or stop anything in the pack as needed.

In other words: split the work, keep the replicas coordinated, and avoid the classic "which terminal was doing the important thing?" problem.

## Notes

- Child agents report upward proactively through the registry instead of relying on status polling.
- Search policy is ripgrep-first. `find` is intentionally excluded from the normal workflow.
- Agent profiles live in `agents/` because the extension resolves them relative to its package layout.
- The real superpower here is not just spawning more agents. It is keeping them legible.

## Docs

- `docs/TMUX_SUBAGENTS_IMPLEMENTATION.md`
- `docs/TMUX_SUBAGENTS_PROGRESS.md`

## Final pitch

If Pi needed a hero name for "spawn a bunch of coordinated replicas, talk to them, and keep the whole operation under control," it was always going to be `meepo`.
