# meepo

> One Pi agent, many replicas.
> Process-hosted subagents (tmux or herdr), tracked services, and enough coordination to keep the whole pack moving together.

`meepo` is a Pi package for running child agents in tracked host windows/panes and managing long-running services alongside them. The default process host is **auto**: use **herdr** when it is on `PATH`, otherwise **tmux**. Force a backend with `MEEPO_PROCESS_HOST=tmux|herdr|auto` or `runtime.processHost` in config.

It is named after the Dota 2 hero for a very specific reason: Meepo is strongest when one becomes many, and this repo gives Pi that same trick. You can spawn focused replicas, keep each one in its own host context, let them report questions or blockers upward, and message them back without losing track of the squad.

If you want the practical version: this package makes multi-agent Pi workflows feel less like "open a bunch of terminals and hope" and more like "replica control, but with receipts."

## Why the name fits

In Dota, Meepo talks to his replicas.
In this repo, the primary agent can:

- spawn replicas with `subagent_spawn`
- keep tabs on them through a shared registry
- read proactive updates through `subagent_inbox`
- answer, redirect, reprioritize, or stop them with `subagent_message` and `subagent_stop`
- jump into any replica's host window/pane with `subagent_focus`
- capture recent output with `subagent_capture`
- on herdr, get desktop toasts for questions, blockers, and completions

So yes: the repo is literally about coordinating a small army of Meepos.

## What this package adds to Pi

### Task-first process-hosted subagents

Capture work as tracked tasks first, then spawn focused child agents in isolated host windows/panes (tmux or herdr) to execute against those tasks. Agent lifecycle remains visible, but the board now reflects task lifecycle instead of agent lifecycle.

### Replica-to-parent communication

Children report upward proactively instead of making the primary agent poll them for status all day. Questions, blockers, milestones, and completions can all flow back through the registry.

### RPC bridge-backed child control plane

New child launches use an RPC bridge as the child main process (same on tmux and herdr). That bridge runs visibly in the child pane, launches `pi --mode rpc`, persists bridge status/events into the run directory, and gives the coordinator a live control path for prompt/steer/follow-up style child messaging.

### Tracked long-running services

Launch API servers, frontend dev servers, watchers, or other long-running commands in tracked host windows/panes and manage them with the same focus/capture/stop/reconcile workflow.

### Bring your own agents (required)

**Meepo does not ship subagent profiles or role prompts.** It only orchestrates plain Pi child sessions against profile names **you** provide.

- Put agent markdown in `~/.pi/agent/agents/*.md` (default), and/or
- Point `profiles.dirs` at project- or package-specific agent directories

Without at least one consumer profile on disk, `subagent_spawn` has nothing to launch.

### Optional doctrine (not core)

Hierarchy policy knobs, optional org-chart **seed data** (role keys/edges — still not agent prompts), Kanban task tools, and orchestration skills are **optional**. They ship behind the `full` preset / capability flags so the platform stays methodology-neutral by default.

## Included in the box

- `extensions/meepo/`
  - ProcessHost (tmux + herdr), registry, RPC bridge control plane, spawn/runtime, messaging, reconcile
  - optional task board + tracked services (capability-gated)
  - module layout: `index.ts` (entry), `coordinator-ops.ts`, `coordinator-tools.ts`, `tool-schemas.ts`, `registry.ts`, hosts, policies
- `skills/` (optional operator playbooks; profile-agnostic; not a role catalog)
  - `dispatch-subagents`, `communicate-subagents`, `handoff-subagents`, `supervise-subagents`, `manage-tasks`

**Not included:** `agents/`, scout/worker/reviewer packs, org persona prompts, or review-pack profiles. Those belong in consumer config or a separate agent package.

## Install with Pi

```bash
pi install git:github.com/janhoon/meepo
```

Or use it directly from a local checkout:

```bash
pi install /path/to/meepo
```

## Platform vs presets (MeepoRuntime)

Meepo is a **platform** (tracked process-hosted subagents, registry, optional tasks/services) plus optional **doctrine knobs** (hierarchy/org seed data, no-wait enforce). Agent personas stay consumer-owned.

- **Default (core):** methodology-neutral process control — `agents.core` + `agents.attention`, soft policies, no org seeder.
- **Full operator pack:** set `MEEPO_PRESET=full` for tasks/services/ui tools, hierarchy enforce, no-wait enforce, org role/edge seeds, and profile name-compat.

Config keys, capability→tool maps, policy modes, profile frontmatter (`role` / `lease`), and DB upgrade notes live in:

- [`docs/MEEPO_RUNTIME_CONFIG.md`](docs/MEEPO_RUNTIME_CONFIG.md)

Run unit tests (no live tmux/herdr required; adapters are mocked):

```bash
npm test
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

### Long-running service tools

Canonical names are `service_*` (ProcessHost-neutral). Legacy `tmux_service_*` aliases remain registered for compatibility.

- `service_start` (alias: `tmux_service_start`)
- `service_list` (alias: `tmux_service_list`)
- `service_get` (alias: `tmux_service_get`)
- `service_focus` (alias: `tmux_service_focus`)
- `service_stop` (alias: `tmux_service_stop`)
- `service_capture` (alias: `tmux_service_capture`)
- `service_reconcile` (alias: `tmux_service_reconcile`)

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

1. Install at least one consumer agent profile under `~/.pi/agent/agents/` (see [Bring your own agents](#bring-your-own-agents-required)).
2. Create or locate a task with `task_create` / `task_list` (when tasks capability is enabled).
3. `subagent_spawn` with a **profile name that exists on disk**, a concrete `task`, and optional `taskId`.
4. Let the child report back with a question, blocker, or completion.
5. Reply with `subagent_message` and move the task with `task_move` when the real work state changes.
6. Open `/task-board` when you want a Pi-native board view of `todo`, `blocked`, `in_progress`, `in_review`, and `done` work.
7. Spin up a tracked service with `service_start` if the task needs an app server, watcher, or dev environment.
8. Run `subagent_cleanup` or `/agent-cleanup` to remove finished child host windows/panes once their work has been synthesized.

### Process host switch

```bash
# Prefer herdr when installed (default)
export MEEPO_PROCESS_HOST=auto

# Force tmux even if herdr is on PATH
export MEEPO_PROCESS_HOST=tmux

# Force herdr (spawn fails if herdr is unavailable)
export MEEPO_PROCESS_HOST=herdr
```

Backend is frozen once per primary Pi session — restart Pi to switch. See [`docs/MEEPO_RUNTIME_CONFIG.md`](docs/MEEPO_RUNTIME_CONFIG.md).
8. Focus, capture, reconcile, or stop anything in the pack as needed.

In other words: split the work, keep the replicas coordinated, and avoid the classic "which terminal was doing the important thing?" problem.

## Notes

- Child agents report upward proactively through the registry instead of relying on status polling.
- Bridge-backed children expose transport state in operator-facing surfaces. The full vocabulary is `legacy`, `launching`, `listening`, `live`, `fallback`, `disconnected`, `stopped`, `error`, and `lost`. A healthy launch progresses `launching → listening → live`.
- The coordinator can now attempt live downward child delivery through the RPC bridge before falling back to the child-side mailbox poll path.
- Specialist acceptance (browser QA, design, security, harsh maintainability review, …) is entirely defined by **your** profiles and skills — not by Meepo core.
- The task board is task-first. Agents are linked executors, not the board cards themselves.
- Task health/liveness is derived separately from the Kanban lane: `task.status` controls columns and workflow state, while health flags such as `owner_active`, `stale`, `blocked_external`, `approval_required`, `empty_or_no_progress`, and `needs_review` explain operational liveness and next action.
- Search policy is ripgrep-first. `find` is intentionally excluded from the normal workflow.
- Default profile load path is the consumer Pi agents dir (`~/.pi/agent/agents`). Use `profiles.dirs` for additional packs; Meepo package layout does not supply role prompts.
- The real superpower here is not just spawning more agents. It is keeping the task graph legible.

## Consumer agent profile sketch

```markdown
---
name: implementer
description: Focused implementer for a single small task.
tools: read, bash, edit, write, grep
lease: exclusive
---

You complete the assigned task, keep changes small, and publish completion upward.
```

Save as `~/.pi/agent/agents/implementer.md`, then `subagent_spawn` with `profile: "implementer"`.

Optional review-pack patterns (still consumer-owned): [`docs/REVIEW_PACKS.md`](docs/REVIEW_PACKS.md).

## Docs

- `docs/MEEPO_RUNTIME_CONFIG.md` — MeepoRuntime config, presets, policies, upgrades
- `docs/TMUX_SUBAGENTS_IMPLEMENTATION.md`
- `docs/TMUX_SUBAGENTS_PROGRESS.md`
- `docs/REVIEW_PACKS.md`

## Final pitch

If Pi needed a hero name for "spawn a bunch of coordinated replicas, talk to them, and keep the whole operation under control," it was always going to be `meepo`.
