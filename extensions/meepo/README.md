# meepo extension


## Architecture notes (quality pass)

### Entry & coordinator
- `index.ts` (~20) — `MeepoRuntime` boot
- `coordinator.ts` (~700) — wires tool modules, commands, shortcuts, lifecycle
- `coordinator-helpers.ts` — barrel for helper modules:
  - `coordinator-session` — session state, wake, filters
  - `task-interactions` — task interaction projection
  - `agent-lifecycle` — stop/cleanup/reconcile agents
  - `service-ops` — service start/stop/reconcile
  - `spawn-ops` — spawn/dispatch
  - `board-ops` — dashboard/board data
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
- Messaging: v2 canonical upward publish; legacy mailbox for downward + read-compat
- Default preset: **core** (`MEEPO_PRESET=full` for doctrine)
- Services: `service_*` + legacy `tmux_service_*` aliases
- **BYO agents:** profiles load from consumer dirs only (`~/.pi/agent/agents` and/or `profiles.dirs`). Meepo does not ship `agents/` role prompts.

