# meepo extension


## Architecture notes (quality pass)

### Entry & coordinator
- `index.ts` (~20) — `MeepoRuntime` boot
- `coordinator.ts` (~700) — wires tool modules, commands, shortcuts, lifecycle
- `coordinator-helpers.ts` — leftover compatibility barrel. Callers import named modules; delete this file once nothing re-exports it.
  - `child-fleet` — stop/focus/capture/reconcile Children
  - `attention` — inbox snapshot → notify / wake
  - `board-projection` — Tasks + Children + Attention → operator view
  - `coordinator-session` — session state, fleet UI chrome
  - `task-interactions` — task interaction projection
  - `service-ops` — Service start/stop/reconcile
  - `spawn-ops` — Child launch / dispatch
  - `standup` — standup digest builders
- `tools/agent-tools.ts` / `task-tools.ts` / `service-tools.ts`
- `formatters.ts`, `subtree-control.ts`, `bridge-delivery.ts`, `tool-schemas.ts`

### Registry barrels
- `registry.ts` → `agent-store`, `message-store`, `hierarchy-store` (barrel), `registry-shared`, `registry-types`
  - hierarchy: `hierarchy-actors`, `hierarchy-edges-read`, `hierarchy-routing`, `message-v2-store`, `hierarchy-org`
- `task-registry.ts` → `task-store`, `task-graph`, `task-health`, `task-leases`, `task-links-agents`, `task-ops`, `task-shared`

### Child runtime
- `child-runtime.ts` — register + env
- `child-publish.ts` — upward publish
- `child-downward.ts` — parent→child delivery
- `child-status.ts` — status snapshot disk/DB

### Platform defaults
- Messaging: Inbox publish/list/mark on v2; leftover legacy rows are a read adapter
- Default preset: **core** (`MEEPO_PRESET=full` for doctrine)
- Services: `service_*` + legacy `tmux_service_*` aliases
- **BYO agents:** profiles load from consumer dirs only (`~/.pi/agent/agents` and/or `profiles.dirs`). Meepo does not ship `agents/` role prompts.
- **Slash UX:** each consumer profile registers `/subagent:<name>` (skill-style autocomplete). See `subagent-commands.ts`.

