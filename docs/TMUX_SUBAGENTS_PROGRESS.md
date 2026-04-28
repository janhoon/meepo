# Pi tmux Subagents: Progress Tracker

This tracker follows `TMUX_SUBAGENTS_IMPLEMENTATION.md`.

---

## Overall status

**Project:** In progress

**Current state:** The original tmux-backed registry/task-board foundation is landed, the RPC bridge migration is actively in progress, and task-linked worktree lifecycle UX is now surfaced. New child runs emit bridge artifacts, launch a tmux-side bridge entrypoint, persist transport metadata in the registry, attempt live downward delivery via the bridge, and surface transport-aware reconcile state. Task/agent detail surfaces now include worktree status, and cleanup previews can remove eligible done-task dedicated worktrees without deleting branches.

**Last updated:** 2026-04-28

---

## Locked decisions checklist

- [x] Use a global SQLite registry
- [x] Make the system global, not only project-local
- [x] Use tmux-backed child pi sessions
- [x] Include dashboard UI and keybindings in initial scope
- [x] Use tools for mechanics and skills for orchestration
- [x] Require child-initiated reporting upward
- [x] Standardize on ripgrep for file/content search
- [x] Exclude `find` from the workflow

---

## Deliverables

### 1. Persistence / registry
- [x] Create SQLite bootstrap module
- [x] Create schema bootstrap / migrations
- [x] Enable WAL mode and busy timeout
- [x] Create `agents` table helpers
- [x] Create `agent_messages` table helpers
- [x] Create `agent_events` table helpers
- [x] Create `artifacts` support if needed

### 2. Spawn/runtime
- [x] Create run directory creator
- [x] Create child id generator
- [x] Create task prompt writer
- [x] Create runtime appendix writer
- [x] Create launch script writer
- [x] Create tmux spawn helper
- [x] Record tmux ids in registry
- [x] Append custom parent-session linkage entry
- [x] Emit bridge config/status/log artifacts in run dirs
- [x] Launch new child tmux windows through a bridge entrypoint instead of invoking pi directly

### 3. Child reporting
- [x] Report `started`
- [x] Report `milestone`
- [x] Report `blocked`
- [x] Report `question`
- [x] Report `question_for_user`
- [x] Report `complete`
- [x] Update registry state and previews continuously
- [x] Persist `latest-status.json`
- [x] Persist `events.jsonl`

### 4. Mailbox / inbox
- [x] Create downward message sender
- [x] Create unread inbox reader
- [x] Create delivery + ack flow
- [x] Rehydrate unread items on primary restart
- [x] Route user-facing child questions visibly in primary UI
- [x] Route primary-facing child questions to coordinator context
- [x] Attempt live RPC bridge delivery before fallback mailbox polling

### 5. Tools
- [x] `subagent_spawn`
- [x] `subagent_list`
- [x] `subagent_get`
- [x] `subagent_focus`
- [x] `subagent_stop`
- [x] `subagent_message`
- [x] `subagent_inbox`
- [x] `subagent_capture`
- [x] `subagent_reconcile`

### 6. Commands and shortcuts
- [x] `/agents`
- [x] `/task-board`
- [x] `/task-spawn`
- [x] `/agent-open`
- [x] `/agent-stop`
- [x] `/agent-message`
- [x] `/agent-sync`
- [x] `Ctrl+Alt+A` dashboard shortcut
- [x] `Ctrl+Alt+N` spawn shortcut
- [x] next/previous active agent shortcuts

### 7. UI
- [x] Footer fleet summary
- [x] Widget with priority items
- [x] Interactive dashboard list view
- [x] Dashboard detail pane
- [x] Dashboard action handlers (focus/stop/reply)
- [x] Unread/question/blocked indicators
- [x] Parent/child relationship view

### 8. Skills
- [x] `dispatch-subagents`
- [x] `communicate-subagents`
- [x] `handoff-subagents`
- [x] `supervise-subagents`

### 9. Agent profiles
- [x] `worker`
- [x] `scout`
- [x] `planner`
- [x] `reviewer`
- [x] optional `coordinator-helper`
- [x] runtime appendix generation

### 10. rg-only enforcement
- [x] Remove `find` from all profiles
- [ ] Remove `find` from skills/examples/docs
- [x] Teach `grep` + `rg --files` as the canonical workflow
- [ ] Add extension guard to block `find` if needed
- [x] Verify prompts never recommend `find`

### 11. Reconciliation / resilience
- [x] Detect stale tmux targets
- [ ] Detect missing child sessions
- [x] Mark `lost` correctly
- [x] Mark `stopped` correctly
- [x] Show reconciliation results in UI/events
- [x] Inspect bridge metadata during reconcile
- [x] Surface transport-aware states across the full vocabulary: `legacy`, `launching`, `listening`, `live`, `fallback`, `disconnected`, `stopped`, `error`, `lost` (healthy launch progresses `launching → listening → live`)
- [x] Surface task-linked worktree lifecycle status in task/agent details and board panes
- [x] Add conservative dedicated-worktree cleanup preview/removal flow that never deletes branches

### 12. Documentation polish
- [x] Keep implementation doc in sync with reality
- [ ] Add usage examples
- [ ] Add troubleshooting notes
- [ ] Add install/stow instructions

---

## Attention-critical requirements

These items are easy to regress and should be verified repeatedly.

- [x] Primary agent does not need to poll children for feedback
- [x] Children publish blockers/questions/completions proactively
- [x] Unread child-originated items survive primary restart
- [x] Search behavior uses ripgrep only
- [x] `find` is not part of the operational workflow
- [x] Dashboard exposes blocked/questions before normal running agents

---

## Progress by milestone

### Milestone A — Registry foundation
**Goal:** global persistence exists and is usable

- [x] DB opens successfully
- [x] Schema bootstraps automatically
- [x] Simple create/list/get agent operations work

### Milestone B — Spawn and tmux linkage
**Goal:** children can be launched and rediscovered

- [x] Child run dir created
- [x] Child session file created
- [x] tmux window created
- [x] tmux ids stored
- [x] parent session link written

### Milestone C — Child-initiated reporting
**Goal:** coordinator can supervise without polling for feedback

- [x] started event works
- [x] milestone event works
- [x] blocked event works
- [x] question event works
- [x] complete event works
- [x] unread inbox survives restart

### Milestone D — UI and commands
**Goal:** user can manage the fleet from pi

- [x] dashboard opens
- [x] filters work
- [x] focus works
- [x] stop works
- [x] reply works
- [x] footer/widget summary works

### Milestone E — Skills and prompt system
**Goal:** coordinator behavior matches system design

- [x] skills exist
- [x] profiles exist
- [x] runtime appendix exists
- [ ] rg-only behavior is reinforced everywhere

### Milestone F — Hardening
**Goal:** system is restart-safe and failure-tolerant

- [x] reconciliation works for tmux + bridge metadata refresh
- [x] stale agents handled
- [x] lost agents handled
- [ ] docs updated

---

## Known non-goals / avoidances

- [ ] Do not make `status_request` / `status_response` the default feedback path
- [ ] Do not rely on fragile pane scraping as the main state mechanism
- [ ] Do not allow `find` to creep back into prompts or tools

---

## Notes / implementation log

### 2026-04-28
- Added task-linked worktree lifecycle UX:
  - task/agent CLI details now show effective worktree strategy, id, cwd, path existence, active linked agents, conflicts, and status (`active`, `reusable`, `ready-cleanup`, `stale-*`, `preserved-existing`, `conflict`).
  - task board detail pane now shows worktree status/id/cwd plus active/conflicting linked worktree agents.
- Added `task_worktree_cleanup` and `/task-worktree-cleanup`:
  - previews by default.
  - only removes eligible `dedicated_worktree` git worktrees for `done` tasks with no active linked agents.
  - preserves `existing_worktree`, `spawn_cwd`, inherited, active, missing, unregistered, conflicting, and dirty worktrees by default.
  - `force` is required for dirty eligible worktrees.
  - branches are never deleted; branch deletion remains a separate manual operator decision.
- Existing provisioning events remain in place for dedicated worktree create/reuse and existing-worktree metadata recording.

### 2026-04-21
- Added RPC bridge migration foundation:
  - `rpc-client.ts`
  - `rpc-bridge.mjs`
- Extended `types.ts`, `db.ts`, `registry.ts`, and `paths.ts` for bridge transport metadata and run-dir artifacts.
- Updated `spawn.ts` so new child tmux windows launch a bridge entrypoint and write bridge config/status/log artifacts.
- Added live downward bridge delivery and coordinator wake-up polling in `index.ts`.
- Added transport-aware reconcile logic and transport visibility in agent/dashboard details.

### 2026-04-15
- Added spawn/runtime modules under `extensions/tmux-agents/`:
  - `profiles.ts`
  - `spawn.ts`
  - `child-runtime.ts`
- Added coordinator-facing spawn/focus/control surface:
  - `subagent_spawn`
  - `subagent_focus`
  - `subagent_stop`
  - `subagent_message`
  - `subagent_capture`
  - `subagent_reconcile`
  - `/task-spawn`
  - `/agent-open`
  - `/agent-stop`
  - `/agent-message`
  - `/agent-capture`
  - `Ctrl+Alt+N`
  - next/previous active agent shortcuts
- Added tmux-backed spawn flow:
  - run directory creation under `~/.pi/agent/subagents/runs/<agent-id>/`
  - `task.md`, `runtime-appendix.md`, `launch.sh`, `latest-status.json`, `events.jsonl`, `debug.log`
  - tmux session/window creation and stored tmux ids
  - parent-session linkage via custom entries
- Added child-mode runtime behavior:
  - auto `started` event
  - `subagent_publish` tool for milestone/blocker/question/question_for_user/complete
  - downward registry messages delivered into child sessions
  - delivery/ack state transitions for downward messages
  - live preview/state updates into registry and `latest-status.json`
  - completion fallback on `agent_end`
- Added reconciliation/stop helpers:
  - tmux focus
  - graceful stop via queued cancel + tmux interrupt
  - force stop via tmux kill + registry update
  - tmux pane capture
  - reconcile against tmux inventory and latest child status snapshots
- Added interactive dashboard behavior:
  - list view with scope/filter/sort controls
  - detail pane with parent/child relationships
  - in-dashboard focus/stop/reply/capture/spawn/sync actions
- Added skills under `skills/`:
  - `dispatch-subagents`
  - `communicate-subagents`
  - `handoff-subagents`
  - `supervise-subagents`
- Added prompt templates under `prompts/`:
  - `scout-and-plan`
  - `implement`
  - `implement-and-review`
- Smoke-tested extension load via:
  - `pi --no-session -p '/agent-sync'`
  - `pi --no-session -p '/task-spawn'`
  - `pi --no-session -p '/agent-message foo answer hi'`
  - `pi --no-session -p '/agent-stop foo force'`
  - `pi --no-session -p '/agent-capture foo 50'`
  - `pi --no-session -p '/agent-open foo'`

### 2026-04-14
- Added `extensions/tmux-agents/` foundation:
  - SQLite bootstrap using `node:sqlite`
  - schema migrations for `agents`, `agent_messages`, `agent_events`, `artifacts`
  - registry helpers for create/update/list/get/message/event/artifact operations
- Added inspection surfaces:
  - `subagent_list`
  - `subagent_get`
  - `subagent_inbox`
  - `/agents`
  - `/agent-sync`
  - `Ctrl+Alt+A`
  - footer + widget fleet status
- Added initial agent profile prompts under `agents/`
- Smoke-tested extension load with:
  - `pi -e ./pi/.pi/agent/extensions/tmux-agents/index.ts --no-session -p '/agent-sync'`

### 2026-04-12
- Planning finalized around:
  - global SQLite registry
  - tmux-backed child sessions
  - dashboard + shortcuts
  - tools + skills split
  - child-initiated feedback model
  - rg-only search policy
- No code implementation started yet

---

## Done definition

The project is considered implementation-ready when all of the following are true:

- [ ] registry is persistent and stable
- [ ] spawn works reliably
- [ ] child reporting works without polling for feedback
- [ ] dashboard is usable
- [ ] keybindings work
- [ ] skills and prompts align with runtime behavior
- [ ] rg-only search policy is enforced
- [ ] docs reflect reality
