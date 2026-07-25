# Research: Meepo tmux host coupling inventory

- **Ticket:** [#17](https://github.com/janhoon/meepo/issues/17) (part of map [#15](https://github.com/janhoon/meepo/issues/15))
- **Date:** 2026-07-25
- **Branch:** `research/meepo-tmux-host-coupling`
- **Primary source:** `/home/janhoon/projects/meepo` codebase (especially `extensions/tmux-agents/`)
- **Scope:** Where Meepo is hard-coupled to tmux today, and a minimal **ProcessHost** boundary grounded in real call sites.

---

## Executive summary

Meepo’s process host is **tmux CLI via `spawnSync("tmux", …)`**, duplicated in three modules:

| Module | Role |
|--------|------|
| `extensions/tmux-agents/tmux.ts` | Shared ops: focus, stop, capture, inventory, target-exists |
| `extensions/tmux-agents/spawn.ts` | Agent window spawn (`new-window` / detached `new-session`) |
| `extensions/tmux-agents/service-spawn.ts` | Service window spawn (parallel to agents, different detached session name) |

Consumers:

- `extensions/tmux-agents/index.ts` — coordinator tools (`subagent_*`, `tmux_service_*`), cleanup, reconcile, dashboard-facing formatters
- Registry/DB — columns `tmux_session_id|name`, `tmux_window_id`, `tmux_pane_id`; table `tmux_services`
- Config — `runtime.detachedSessionName` is **declared but not wired** into spawn; spawn hardcodes `"pi-subagents"` / `"pi-services"`
- Child runtime / RPC bridge — **not** tmux-coupled for messaging; they use files/sockets. Pane capture is explicitly a **debug fallback**

**Minimal ProcessHost boundary:** wrap the operations already implemented in `tmux.ts` plus the spawn path in `spawnTmuxWindow` (agents + services), returning a host-neutral `HostTarget` instead of four tmux id fields.

---

## 1. Call sites that shell out to `tmux` or import `tmux.ts`

### 1.1 Direct `spawnSync("tmux", …)` / `runTmux`

#### `extensions/tmux-agents/tmux.ts` (shared host ops)

| Lines | Operation | tmux argv |
|------:|-----------|-----------|
| 39–44 | `runTmux` | any |
| 73–77 | focus (when `process.env.TMUX` set) | `switch-client -t`, `select-window -t`, optional `select-pane -t` |
| 88–103 | force stop | `kill-pane` / `kill-window` / `kill-session` |
| 118 | graceful stop | `send-keys -t <pane> C-c` |
| 134 | capture | `capture-pane -p -S -<n> -t <target>` |
| 147 | inventory | `list-panes -a -F "#{session_id}\t#{session_name}\t#{window_id}\t#{pane_id}"` |

Exported API (this is the de-facto host surface today):

- `focusTmuxTarget` (55–82)
- `stopTmuxTarget` (84–125)
- `captureTmuxTarget` (127–136)
- `getTmuxInventory` (138–160)
- `tmuxTargetExists` (162–168)

Types: `TmuxTargetInput` (3–8), result types (10–33).

#### `extensions/tmux-agents/spawn.ts` (agent spawn)

| Lines | Operation | tmux argv |
|------:|-----------|-----------|
| 85–91 | local `runTmux` | any |
| 96 | current target | `display-message -p` + format |
| 354–355 | spawn in current session | `new-window -t <sessionId> -P -F … -n <windowName> <launchCommand>` |
| 357 | detached session probe | `has-session -t pi-subagents` (stdio ignore) |
| 360–361 | spawn in detached | `new-window -t pi-subagents …` |
| 364–365 | create detached | `new-session -d -P -F … -s pi-subagents -n …` |
| 346–347 | preflight | `commandExists("tmux")` via bash |

Constants:

- `DETACHED_SESSION_NAME = "pi-subagents"` (35)
- `TMUX_OUTPUT_FORMAT` (36)
- Local `TmuxTarget` interface (39–44) — **not** imported from `tmux.ts`

#### `extensions/tmux-agents/service-spawn.ts` (service spawn)

| Lines | Operation | notes |
|------:|-----------|-------|
| 47–53 | local `runTmux` | duplicate of spawn/tmux |
| 58 | current target | same as agents |
| 179–189 | spawn path | same shape as agents |
| 11 | `DETACHED_SESSION_NAME = "pi-services"` | **different** session than agents |

### 1.2 Import of `./tmux.js`

Only:

- `extensions/tmux-agents/index.ts:86`  
  `import { captureTmuxTarget, focusTmuxTarget, getTmuxInventory, stopTmuxTarget, tmuxTargetExists } from "./tmux.js";`

**No other package files import `tmux.ts`.** Spawn modules reimplement `runTmux` instead of sharing.

### 1.3 Call sites of host ops inside `index.ts` (by concern)

| Concern | Approximate lines | Host functions |
|---------|-------------------|----------------|
| Cleanup inventory pass | 2051, 2070–2075 | `getTmuxInventory`, `tmuxTargetExists` |
| Cleanup kill | 2098–2106 | `tmuxTargetExists`, `stopTmuxTarget(..., true)` |
| Agent stop | 2622–2706 | `tmuxTargetExists`, `stopTmuxTarget` |
| Agent reconcile | 2752, 2772–2777 | inventory + exists |
| Agent focus | 3127+ | `focusTmuxTarget` |
| Agent capture | 3148–3149 | `tmuxTargetExists`, `captureTmuxTarget` |
| Service stop | 3180, 3214 | exists + stop |
| Service reconcile | 3238, 3242 | inventory + exists |
| Service focus | 3642 | `focusTmuxTarget` |
| Service capture | 3657–3666 | exists + capture |
| Task / UI paths | 4221+, 4767+, 6086+ | `tmuxTargetExists` for “live target?” checks |

Spawn does **not** go through `tmux.ts`; it is only reached via `spawnSubagent` / `spawnService` from tools in `index.ts`.

### 1.4 Docs / skills / agents (mention-only; no shell-out)

Mentions of tmux as product language (not executable coupling):

- `docs/TMUX_SUBAGENTS_IMPLEMENTATION.md`, `docs/TMUX_SUBAGENTS_PROGRESS.md`, `docs/MEEPO_RUNTIME_CONFIG.md`
- `skills/supervise-subagents/SKILL.md` (cleanup/reconcile/focus wording)
- `agents/*.md`, `prompts/*.md` — “tmux-backed”, “pane capture is fallback”
- `package.json` description: `"tmux-backed Pi subagents…"`
- Extension package name / paths: `tmux-agents`, `getTmuxAgentsDb`, UI status keys `tmux-agents`

---

## 2. Registry/DB columns and events that are tmux-shaped

### 2.1 Schema (`extensions/tmux-agents/db.ts`)

**`agents` (migration v1, lines 100–103):**

```text
tmux_session_id TEXT NULL
tmux_session_name TEXT NULL
tmux_window_id TEXT NULL
tmux_pane_id TEXT NULL
```

**`tmux_services` (migration v2, lines 171–188):** table name itself is host-branded.

```text
tmux_session_id / tmux_session_name / tmux_window_id / tmux_pane_id
```

plus service-specific: `ready_substring`, `ready_matched_at`, `log_file`, `latest_status_file`, `command`, `env_json`, …

Indexes: `idx_tmux_services_*` (199–203).

### 2.2 Row mapping

| File | Mapping |
|------|---------|
| `registry.ts` 77–80, 150–153, 455–458, 497–500 | camelCase ↔ snake for agent tmux fields |
| `service-registry.ts` 23–26, 85–88, 104–119, 141–144 | same for services; SQL `INSERT INTO tmux_services` |

### 2.3 TypeScript types

| File | Fields |
|------|--------|
| `types.ts` 136–139, 198–201, 323–326, 632–635, 674–677 | `SessionChildLinkEntryData`, `SpawnSubagentResult`, `AgentSummary`, create/update inputs |
| `service-types.ts` 26–29, 52–55, 77–80, 125–128 | `ServiceSummary`, create/update, `SpawnServiceResult` |

### 2.4 Event types (agent_events.event_type) that are host-shaped

| eventType | Where written | Payload |
|-----------|---------------|---------|
| `tmux_spawned` | `spawn.ts` 695–699 | full `TmuxTarget` `{sessionId, sessionName, windowId, paneId}` |
| `spawn_failed` | `spawn.ts` 675–679 | often tmux binary/errors |
| `cleaned_up` | `index.ts` ~2143 | after force kill of pane/window |
| `force_stopped` | `index.ts` ~2653, 2732 | stop path; reason may be missing tmux target |
| `graceful_stop_requested` | `index.ts` ~2688 | may precede tmux `C-c` fallback |
| `reconciled` | `index.ts` ~2890 | reasons include `"tmux target missing during reconcile"` |

Run-dir JSONL mirrors: `appendRunEvent(..., "tmux_spawned", …)` (`spawn.ts` 699).

Services do **not** currently write a parallel `tmux_spawned` agent_events row (services use status files + `tmux_services` columns only).

### 2.5 Naming that is tmux-shaped but not a process target

- DB helper `getTmuxAgentsDb` / `closeTmuxAgentsDb` (`db.ts` 1160+)
- Path constant `SESSION_CHILD_LINK_ENTRY_TYPE = "tmux-agents-child-link"` (`paths.ts` 5)
- Child env prefix `PI_TMUX_AGENTS_*` (`spawn.ts` 250–260, `child-runtime.ts` 354+)
- Custom message type `"tmux-agents-downward"` (`child-runtime.ts` 755, 835)
- Tool names `tmux_service_*` (`config.ts` 111–117, `index.ts` 5654+)
- Capability key `"services"` for those tools (`config.ts` 151–157)

These are **branding/path coupling**, not host process IDs, but they leak into operator-facing surfaces and migrations.

---

## 3. Tool results / UX strings that expose tmux targets

### 3.1 Tools (registered in `index.ts`)

| Tool | Host coupling in description / result |
|------|----------------------------------------|
| `subagent_spawn` | Result lines include `tmuxSession`, `tmuxWindow`, `tmuxPane` (~2195–2197) |
| `subagent_focus` | “focus in tmux”; result `Focused … in tmux` + ids (~2204–2209, schema ~179) |
| `subagent_stop` | force kills pane/window; results include `tmux command: …` (~2604) |
| `subagent_capture` | “capture from tmux pane” (~200–201, 4840+) |
| `subagent_reconcile` | “when tmux windows disappear” (~4865); reason strings cite missing tmux target |
| `subagent_get` / list formatters | dump `tmuxSessionId/Name/WindowId/PaneId` (~616–619) |
| `subagent_cleanup` | “killing tmux targets” (~250, 5072) |
| `tmux_service_*` | entire family name; start/list/get/focus/stop/capture/reconcile (~5653–5792) |

### 3.2 Dashboard / status widget

- `dashboard.ts` 282–283: `tmux: … / …`, `pane: …`
- `dashboard.ts` 302: title `"tmux agents dashboard"`
- `index.ts` 1482–1506: UI status/widget keys `"tmux-agents"`

### 3.3 Operator-facing command strings

`tmux.ts` returns human `command` strings such as:

- `tmux attach-session -t … ; select-window …`
- `tmux kill-pane -t …`
- `tmux send-keys -t … C-c`
- `tmux capture-pane -p -S -… -t …`

These are echoed into tool results so operators can re-run CLI manually when focus fails outside tmux (`process.env.TMUX` unset → `focused: false` with reason, lines 66–71).

### 3.4 Policy text

- `no-wait-policy.ts` 11–13, 23, 115: pane capture as snapshot; prefer `tmux_service_start` with `readySubstring`
- Skills: `skills/supervise-subagents/SKILL.md` 30–32

---

## 4. Spawn path: launch script, detached session, RPC bridge pane assumptions

### 4.1 Agent spawn pipeline (`spawn.ts` → `spawnSubagent`)

1. **Artifacts** (`writeRunArtifacts`, 275+): under run dir — task file, runtime appendix, bridge config JSON, **launch.sh**, latest-status, bridge status/events/log/pid/socket paths.
2. **Launch script** (`buildLaunchScriptContent`, 266–273):

```bash
#!/usr/bin/env bash
set -euo pipefail
cd <spawnCwd>
exec <node> <rpc-bridge.mjs> --config <bridgeConfigFile>
```

3. **tmux window** (`spawnTmuxWindow`, 345–366):
   - Require `tmux` on PATH.
   - If `process.env.TMUX`: `display-message` for current session → `new-window -t <sessionId>`.
   - Else if session `pi-subagents` exists: `new-window -t pi-subagents`.
   - Else: `new-session -d -s pi-subagents` (first window = this agent).
   - Window name: sanitized title + last 6 of agent id (`sanitizeWindowName`, 102–106).
   - Launch command: `exec '<launchScript>'` (quoted).
   - Print format returns stable ids: session_id, session_name, window_id, pane_id.

4. **Registry update** (683–699): write four tmux columns; event `tmux_spawned`.

5. **RPC bridge assumptions (pane-related):**
   - The **pane’s main process** is the bridge (`rpc-bridge.mjs`), not `pi` directly (`README.md` 100–105; spawn launch script).
   - Bridge mirrors activity into the tmux pane while talking RPC/socket (`README.md`).
   - Graceful agent stop prefers **bridge cancel**, then falls back to tmux `send-keys C-c` (`README.md` 166; `index.ts` stop path ~2688–2706).
   - Reconcile combines **tmux target existence** + **bridge health** (`index.ts` ~2772–2828).
   - Child detection is via env `PI_TMUX_AGENTS_CHILD=1`, not by inspecting the pane (`child-runtime.ts` 354+).

### 4.2 Config mismatch

`config.ts` 62–63, 182, 205 defines `runtime.detachedSessionName: "pi-subagents"`, but **spawn does not read config** — it uses the module constant. Services always use `"pi-services"`. Any future ProcessHost should take detached session name as constructor/options input.

### 4.3 Service spawn pipeline (`service-spawn.ts` → `spawnService`)

Parallel structure:

- Launch script runs **user command** with `tee` to log + status JSON (`buildLaunchScriptContent`, 83–112) — **no RPC bridge**.
- Detached session: `pi-services`.
- Optional ready wait: poll log for `readySubstring` (async sleep loop in spawnService; also reconcile/helper in `index.ts` ~2968–3096).
- Stores same four tmux id columns on `tmux_services`.

### 4.4 Pane assumptions summary

| Assumption | Agents | Services |
|------------|--------|----------|
| One primary pane per window used as target | yes (stored pane id) | yes |
| Process in pane is long-lived supervisor | bridge | bash pipeline of user cmd |
| Interrupt = Ctrl+C to pane | fallback after bridge | primary graceful stop |
| Force = kill-pane (prefer) / kill-window | yes | yes |
| Focus requires operator process inside tmux | yes (`TMUX` env) | yes |
| Capture uses pane id preferentially | yes | yes |

---

## 5. Service path: parity with agents for host ops

| Capability | Agents | Services | Shared host helper? |
|------------|--------|----------|---------------------|
| Spawn window | `spawn.ts` `spawnTmuxWindow` | `service-spawn.ts` `spawnTmuxWindow` | **No** — duplicated |
| Focus | `subagent_focus` → `focusTmuxTarget` | `tmux_service_focus` → same | Yes (`tmux.ts`) |
| Stop graceful | bridge cancel + `stopTmuxTarget(false)` | `stopTmuxTarget(false)` only | Partial |
| Stop force | `stopTmuxTarget(true)` | same | Yes |
| Capture | `captureTmuxTarget` | same | Yes |
| Inventory / exists | reconcile + cleanup | reconcile | Yes |
| Detached session name | `pi-subagents` | `pi-services` | different constants |
| Registry table | `agents` | `tmux_services` | separate |
| Tool naming | `subagent_*` | `tmux_service_*` | services still branded tmux |
| Events | `tmux_spawned`, stop/reconcile events | status file + DB state | agents richer |
| Ready probe | N/A (agent state via bridge/status) | `readySubstring` | service-only |

**Parity gap for ProcessHost:** spawn is the only major host path **not** shared; services and agents should call one `host.spawnWindow({ title, launchCommand, kind: "agent"|"service" })`.

---

## 6. Tests: real tmux binary vs pure unit

| File | Requires real `tmux`? | What it covers |
|------|----------------------|----------------|
| `acceptance-matrix.test.ts` | **No** (header line 3) | capability tool registration matrix; mentions `tmux_service_*` names only |
| `runtime.test.ts` | **No** | tool filter includes/excludes `tmux_service_*` |
| `no-wait-policy.test.ts` | **No** | policy text / patterns |
| `hierarchy-policy.test.ts`, `org-preset.test.ts`, `profiles.test.ts`, `profile-metadata.test.ts` | **No** | non-host logic |
| Integration / e2e against live tmux | **None in-repo** under `extensions/tmux-agents/**/*.test.ts` | README manual checks imply live tmux |

`package.json` test script: `tsx --test 'extensions/tmux-agents/**/*.test.ts'` — all pure unit relative to host.

**Implication:** ProcessHost can be injected/mocked in unit tests without a tmux binary; today nothing tests the real argv sequences except manual README flows.

---

## 7. Recommended ProcessHost port surface (from real call sites)

### 7.1 Host-neutral types (replace tmux-shaped IDs over time)

```ts
/** Stable process placement as returned by any host backend. */
export interface HostTarget {
  /** Opaque backend id (tmux session_id, container id, …). */
  sessionId: string;
  /** Human-readable session label (tmux session_name, workspace name). */
  sessionName: string;
  /** Window / tab / group id. */
  windowId: string;
  /** Fine-grained process attachment (pane, tty, container exec). */
  paneId: string;
  /** Discriminator for multi-backend registries. */
  hostKind: "tmux"; // extend later: "process" | "docker" | …
}

export interface HostTargetRef {
  sessionId?: string | null;
  sessionName?: string | null;
  windowId?: string | null;
  paneId?: string | null;
}

export interface HostInventory {
  sessions: Set<string>;
  sessionNames: Set<string>;
  windows: Set<string>;
  panes: Set<string>;
}

export interface HostSpawnWindowInput {
  title: string;
  /** Used only for window name suffix / logging. */
  entityId: string;
  /** Shell command or path executed as the window’s main process (today: launch.sh). */
  launchCommand: string;
  /** Selects default detached session name (agent vs service). */
  pool: "agents" | "services";
  /** Optional override for detached session name. */
  detachedSessionName?: string;
}

export interface HostFocusResult {
  focused: boolean;
  /** Operator-reproducible hint (may be host CLI string). */
  command: string;
  reason?: string;
}

export interface HostStopResult {
  stopped: boolean;
  graceful: boolean;
  command: string;
  reason?: string;
}

export interface HostCaptureResult {
  content: string;
  command: string;
}
```

### 7.2 ProcessHost methods (1:1 with today’s call sites)

```ts
export interface ProcessHost {
  /** Preflight: binary/backend available. */
  isAvailable(): boolean;

  /** spawn.ts / service-spawn.ts spawnTmuxWindow */
  spawnWindow(input: HostSpawnWindowInput): HostTarget;

  /** Optional: current client placement when parent is already hosted. */
  getCurrentTarget(): HostTarget | null;

  /** tmux.ts focusTmuxTarget */
  focus(target: HostTargetRef): HostFocusResult;

  /** tmux.ts stopTmuxTarget */
  stop(target: HostTargetRef, options?: { force?: boolean }): HostStopResult;

  /** tmux.ts captureTmuxTarget */
  capture(target: HostTargetRef, options?: { lines?: number }): HostCaptureResult;

  /** tmux.ts getTmuxInventory */
  listInventory(): HostInventory;

  /** tmux.ts tmuxTargetExists */
  targetExists(target: HostTargetRef, inventory?: HostInventory): boolean;
}
```

**Not on ProcessHost** (keep outside host boundary — already host-neutral):

- RPC bridge socket / `sendRpcBridgeCommand` / `pingRpcBridge` (`rpc-client.ts`)
- Registry, tasks, attention, hierarchy
- Child publish tools
- Ready-substring **policy** (may call `capture` or read log files, but matching logic stays in service layer)
- Launch script / artifact generation (`writeRunArtifacts`) — host only receives the final `launchCommand`

### 7.3 First backend: `TmuxProcessHost`

Implement by **moving** bodies of:

- `tmux.ts` → methods `focus/stop/capture/listInventory/targetExists`
- shared spawn helper extracted from `spawn.ts` + `service-spawn.ts` → `spawnWindow` + `getCurrentTarget` + `isAvailable`

Delete duplicated `runTmux` / `parseTmuxTarget` / `sanitizeWindowName` once.

Wire `MeepoRuntime` (or tool registration) with `new TmuxProcessHost({ detachedAgentsSession, detachedServicesSession })` reading config.

### 7.4 Types that should become host-neutral

| Today | Proposed |
|-------|----------|
| `TmuxTargetInput` | `HostTargetRef` |
| Local `TmuxTarget` in spawn modules | `HostTarget` |
| `TmuxInventory` | `HostInventory` |
| `FocusTmuxTargetResult` etc. | `HostFocusResult` … |
| Agent/service fields `tmuxSessionId`… | keep columns as **legacy** (below) or add parallel `host_*` |
| Event `tmux_spawned` | `host_spawned` (payload includes `hostKind` + target) |
| Table `tmux_services` | eventually `hosted_services` or `services` (rename is costly) |
| Tools `tmux_service_*` | optional rename `service_*` (UX/capability map) |

---

## Migration notes (registry fields)

### What stays legacy (read/write for long time)

Keep physical columns for compatibility with existing local DBs and operator muscle memory:

- `agents.tmux_session_id|name|window_id|pane_id`
- `tmux_services.tmux_*` same
- Event type string `tmux_spawned` still written **or** dual-written

### What becomes host_* (additive)

Preferred low-risk migration:

1. **Application layer first:** introduce `HostTarget` in TS; map to existing `tmux_*` columns in `registry.ts` / `service-registry.ts` (no SQL rename yet).
2. **Optional additive columns** (only if multi-backend appears):

   ```text
   host_kind TEXT NOT NULL DEFAULT 'tmux'
   host_target_json TEXT NULL  -- serialized HostTarget
   ```

   While present, prefer `host_target_json` when non-null; else fall back to `tmux_*`.

3. **Do not rename `tmux_services` in early migration** — table name is cosmetic; tool names and docs can soften branding first.
4. **Event dual-write:** emit `host_spawned` with `{ hostKind: "tmux", ...target }` and keep `tmux_spawned` until consumers (none in-repo beyond human logs) are updated.
5. **Config:** wire `runtime.detachedSessionName` into `TmuxProcessHost` for agents; add `detachedServicesSessionName` (or derive `pool` defaults).
6. **Tests:** unit-test `TmuxProcessHost` with a fake `runTmux` injector; keep acceptance matrix host-free.

### Explicit non-goals for first port

- Abstracting RPC bridge into ProcessHost
- Supporting non-tmux backends in the same release as the interface extraction
- Renaming extension directory `tmux-agents` (package path churn)

---

## Coupling heat map (priority for extraction)

| Priority | Area | Why |
|----------|------|-----|
| P0 | `tmux.ts` + spawn `spawnTmuxWindow` duplicates | All host argv live here |
| P0 | `index.ts` tool handlers using inventory/focus/stop/capture | Only consumer of shared ops |
| P1 | Registry column names / spawn result types | API surface for operators |
| P1 | Event `tmux_spawned` + reason strings | Observability coupling |
| P2 | Tool names `tmux_service_*`, DB table name, package branding | Rename after interface exists |
| P3 | Docs/skills/agents wording | Follow product rename |

---

## Acceptance checklist (ticket #17)

- [x] Complete inventory of host coupling for spawn / focus / capture / stop / reconcile / services
- [x] Draft ProcessHost interface sketch grounded in call sites
- [x] Migration notes for registry fields (legacy vs host_*)
- [x] File:line oriented inventory in this note

---

## Recommended next steps (for implementers / map #15)

1. Extract `ProcessHost` + `TmuxProcessHost` under e.g. `extensions/tmux-agents/host/` without behavior change.
2. Route `spawn.ts` / `service-spawn.ts` / `index.ts` through it; delete duplicate `runTmux`.
3. Wire config detached session names.
4. Add injectable runner for unit tests of argv sequences.
5. Only then consider multi-host or column renames.

