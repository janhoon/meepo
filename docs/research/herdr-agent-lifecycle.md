# Research: herdr agent lifecycle and multi-agent integration surface

- **Version pinned:** herdr `0.7.4` (channel `stable`, API protocol `16`, schema_version `1`)
- **Binary:** `/home/janhoon/.local/bin/herdr`
- **Socket (this machine):** `/home/janhoon/.config/herdr/herdr.sock`
- **Primary sources:** `herdr --help`, subcommand help, `herdr api schema --json`, `herdr api snapshot`, non-destructive list/get plus short-lived `meepo-research-*` agents (`cat` / `true`), cleaned up after
- **Ticket:** [meepo#16](https://github.com/janhoon/meepo/issues/16) (map #15 ProcessHost)

## Executive answer

herdr 0.7.x is a **persistent multi-workspace terminal host** with a rich socket API. For Meepo ProcessHost it already provides:

| Meepo need | herdr primitive |
| --- | --- |
| spawn child | `herdr agent start <unique-name> --cwd … --workspace … [--tab …] --no-focus -- <argv…>` |
| list/get | `herdr agent list` / `herdr agent get <target>` / `herdr api snapshot` |
| focus | `herdr agent focus <target>` (also workspace/tab focus) |
| capture | `herdr agent read` / `herdr pane read` (`visible` \| `recent` \| `recent-unwrapped`) |
| stop | `herdr pane close <pane_id>` (no dedicated `agent stop`) |
| reconcile | snapshot + `agent get` + `pane process-info` + optional status wait helpers |
| notify user | `herdr notification show <title> [--body] [--sound none\|done\|request]` |
| services | same as agents: named `agent start` with service argv, or `pane split` + `pane run`; stop via `pane close` |
| type into pi | `herdr agent send` / `pane send-text` = **literal text, no Enter**; use `pane run` for command+Enter; `pane send-keys` for key names |

Meepo should **not** treat herdr as a task board: status is **pane/agent UI state** (detected and/or reported), not Meepo task state.

---

## 1. Agent lifecycle

### CLI surface (`herdr agent --help`)

```
herdr agent list
herdr agent get <target>
herdr agent read <target> [--source visible|recent|recent-unwrapped] [--lines N] [--format text|ansi]
herdr agent send <target> <text>
herdr agent rename <target> <name>|--clear
herdr agent focus <target>
herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]
herdr agent attach <target> [--takeover]
herdr agent start <name> [--cwd PATH] [--workspace ID] [--tab ID] [--split right|down]
                 [--env KEY=VALUE] [--focus|--no-focus] -- <argv...>
herdr agent explain <target> [--json]
```

Help text (authoritative for targets):

> targets accept terminal ids, unique agent names, detected/reported agent labels, and legacy pane ids
> agent send writes literal text; use pane run when you want command text plus Enter

### `agent start` parameters (schema `AgentStartParams`)

| Field | Required | Notes |
| --- | --- | --- |
| `name` | yes | Human/registry name; uniqueness enforced while live |
| `argv` | yes | Process argv after `--` |
| `cwd` | no | Working directory |
| `workspace_id` | no | CLI: `--workspace` |
| `tab_id` | no | CLI: `--tab` |
| `split` | no | `right` \| `down` relative to placement |
| `env` | no | `KEY=VALUE` map (CLI repeatable `--env`) |
| `focus` | no | **API default `false`**; CLI exposes `--focus` / `--no-focus` |

Observed start result shape:

```json
{
  "type": "agent_started",
  "argv": ["cat"],
  "agent": {
    "name": "meepo-research-long",
    "agent_status": "unknown",
    "cwd": "/tmp",
    "focused": false,
    "pane_id": "w4:p6",
    "tab_id": "w4:t1",
    "terminal_id": "term_657756577e87bf",
    "workspace_id": "w4",
    "revision": 0
  }
}
```

### Name uniqueness

- While an agent with that **name** is live: second `agent start` fails with
  `agent_name_taken` and lists candidates (`terminal_id`, `pane_id`, workspace/tab, cwd, status).
- After the process/pane is gone, the name is free (`agent_not_found` on get).
- Earlier experiment with quickly exiting `true` showed a **race**: if the first process exits before the second start, duplicate names can succeed (name released). Meepo must treat uniqueness as **server-enforced only while the named agent exists**, and should still store **terminal_id** as the durable host id.

### Placement behavior (experiments, workspace `w4` / meepo)

1. `agent start … --workspace w4 --no-focus -- cat`
   - Creates a **new pane in the active tab** of that workspace (`w4:t1`), not a new tab.
   - Does **not** steal focus when `--no-focus` / default false.
2. `agent start … --workspace w4 --tab <tab> --no-focus -- cat`
   - Places in that tab, but **still creates a new pane** alongside the tab's root shell pane. Does **not** reuse the empty root pane.
3. `tab create` then `agent start` → **orphan shell pane** left in the tab unless closed.
4. `workspace create` then `agent start --workspace new` → same: agent is a **second pane** in the default tab.
5. Exiting short commands (`true`, finished short processes) → named agent disappears quickly; panes often vanish (exit cleanup). Long-lived `cat` stays until `pane close`.

**Implication for Meepo layout:** prefer either:

- **A (minimal):** `agent start --workspace <current> --no-focus -- <pi argv>` and accept new panes in the primary tab, **or**
- **B (recommended for many children):** `tab create --workspace … --label <title> --no-focus`, then start agent in tab and **close the unused root pane**—today start does not occupy root.

**Meepo implemented B** in `HerdProcessHost.spawnWindow` (2026-08-11): one dedicated tab per child/service, orphan root shell pane closed after `agent start`, so the coordinator tab is not split. Closing the agent pane removes the last pane and herdr drops the tab.

There is no CLI flag "use existing empty pane". Closest building blocks: `pane split`, `pane move --new-tab`, `tab create`, `agent start`.

### Other lifecycle ops

| Op | Behavior |
| --- | --- |
| `list` | Agents with detection and/or names; includes named non-pi processes and detected `agent: "pi"` entries (often `name: null`) |
| `get` | Resolves target → `AgentInfo` |
| `read` | Screen/buffer capture (same sources as pane read) |
| `send` | Literal text into terminal input |
| `rename` / `--clear` | Changes or clears unique name; old name immediately `agent_not_found` |
| `focus` | Focus that agent's pane |
| `wait` | Block until status in {idle, working, blocked, unknown} (**no `done`** on this CLI form) |
| `attach` | Attach UI to agent (`--takeover`) |
| `explain` | Detection debug (manifest rules, matched rule, fallback_reason) |

### Target resolution

Accepted (help + experiments):

| Target kind | Example | Works? |
| --- | --- | --- |
| unique agent **name** | `meepo-research-long` | yes while named |
| **terminal_id** | `term_657756577e87bf` | yes (stable across rename) |
| **pane_id** | `w4:p6` | yes ("legacy pane ids") |
| detected label | e.g. `pi` | only if **unique**; many `pi` panes exist → not unique on this machine |

**Persist for Meepo registry:** prefer `terminal_id` as host-stable id; also store `pane_id`, `tab_id`, `workspace_id`, and Meepo-chosen `name`. Pane ids look like `wN:pX` and can be recycled after close—do not use alone across restarts without reconcile.

---

## 2. Status model

### Enums (schema)

- **`AgentStatus`** (info/snapshot/API): `idle` | `working` | `blocked` | `done` | `unknown`
- **`PaneAgentState`** (`pane report-agent --state`): `idle` | `working` | `blocked` | `unknown` (**no `done`**)

### How status is produced

Two layers:

1. **Screen / manifest detection** (e.g. pi via remote manifest under agent-detection). `herdr agent explain --json` shows rules (e.g. `working_literal` looking for `Working...`) and `fallback_reason` such as `default_known_agent_idle_fallback`.
2. **Explicit report** from integrations:
   `herdr pane report-agent <pane_id> --source ID --agent LABEL --state idle|working|blocked|unknown […]`
   plus `report-agent-session`, `release-agent`, `report-metadata`.

On this machine `herdr integration status` shows **pi integration not installed** (`~/.pi/agent/extensions/herdr-agent-state.ts` missing). Live pi panes still get `agent: "pi"` and idle/working via **detection**, not the formal integration hook.

### CLI wait surfaces

| Command | Status set | Target |
| --- | --- | --- |
| `herdr agent wait <target> --status …` | idle, working, blocked, **unknown** (no done) | agent target resolver |
| `herdr wait agent-status <pane_id> --status …` | idle, working, blocked, **done**, unknown | **pane_id only** |
| `herdr wait output <pane_id> --match …` | n/a (output match) | pane |

### `done`

Present in schema `AgentStatus` and `wait agent-status`, but **not** in `pane report-agent` states and **not** in `agent wait`. Treat `done` as a wait/detection outcome, not something Meepo can always report via `report-agent`. Meepo task completion remains Meepo's own domain.

### Live snapshot sample (this host)

Pi agents showed `idle` / `working`; plain shells `unknown`; focused flags on workspace/tab/pane; `revision` counters on panes.

---

## 3. Notifications

```
herdr notification show <title> [--body TEXT]
  [--position top-left|top-right|bottom-left|bottom-right]
  [--sound none|done|request]
```

Schema sounds: `none` | `done` | `request`.

**When Meepo should fire (recommendation):**

| Meepo event | Title/body | Sound |
| --- | --- | --- |
| question_for_user / needs user | agent/task id + short question | `request` |
| blocked (user or external) | agent/task + reason | `request` |
| complete / done handoff | agent/task + summary | `done` |
| internal milestone / noise | usually skip | — |

Notifications are **UI toasts**, not a durable inbox. Keep Meepo registry/attention as source of truth; notification is optional UX on herdr backend only.

---

## 4. Layout

### Model

- **Session** (persistent server; named sessions via `herdr session …`; default socket above)
- **Workspace** (`wN`) — project-like container, label, tabs
- **Tab** (`wN:tM`) — pane tree / layout
- **Pane** (`wN:pX`) — terminal; has `terminal_id`
- **Agent** — optional name + detection metadata on a pane/terminal

### Spawning many agents without stealing focus

- Use `--no-focus` on `agent start`, `tab create`, `workspace create` (API defaults focus false for agent start).
- Prefer **one tab per child** (or denser panes) rather than splitting the primary coordinator pane.
- Coordinator stays on existing pi pane; children never focused unless user or `agent focus`.

### Recommended minimal layout for a Meepo primary session

1. Run primary Meepo/pi in the user's normal workspace (e.g. `meepo` workspace).
2. On spawn (many children): `tab create --workspace <primary_workspace_id> --cwd <spawnCwd> --label <uniqueTitle> --no-focus`, then `agent start --tab <new_tab> --no-focus -- <bridge-or-pi argv>`, and cleanup the extra root pane — **this is Meepo's current layout**.
3. ~~Simpler v1 pane-in-active-tab~~ — rejected; burns coordinator screen real estate.
4. Do **not** create a new **workspace** per child by default (map preference: current workspace + no-focus).

Remote: `herdr --remote <ssh-target>` attaches to remote server; sessions are server-local. Meepo ProcessHost should assume **one herdr server/socket per primary**, not mix remote children unless explicitly designed.

---

## 5. Services (long-running non-agent commands)

| Pattern | Use |
| --- | --- |
| `herdr agent start svc-… --no-focus -- <cmd…>` | **Preferred** for Meepo services: stable name, same get/read/focus/close path as agents |
| `pane split` + `pane run` | Fine for ad-hoc; weaker naming unless rename |
| Plain shells without name | Harder to reconcile |

**Stop/close:**

- `herdr pane close <pane_id>` — observed ok; ends process tree for that pane
- `herdr tab close` / `workspace close` — closes contained panes
- No `agent stop` / no dedicated SIGTERM API in CLI help—closing the pane is the host kill
- `agent rename --clear` only clears name, does not stop process

Map service names to `svc-…` (per #15) and enforce uniqueness like children.

---

## 6. Control plane inputs (RPC bridge vs typing into pi)

| API | Enter? | Use |
| --- | --- | --- |
| `agent send` / `pane send-text` | **No** | Paste/literal text into program input |
| `pane run <pane_id> <command>` | **Yes** (command + Enter) | Run shell command in pane |
| `pane send-keys <pane_id> <key>…` | keys | Ctrl+C style interrupts |
| `pane send_input` (API only) | text and/or keys | Combined low-level |

Help explicitly: **agent send = literal; pane run = command + Enter**.

**RPC bridge:** Prefer **not** depending on PTY typing. Meepo's tmux path already uses a bridge socket + status files. On herdr:

- Launch bridge as `agent start` argv (same idea as tmux launch script).
- Parent↔child control via bridge socket/files (host-agnostic).
- Fallback interrupt: `pane send-keys` once key names are verified.
- Fallback "type a prompt into pi": `agent send` then Enter via `send-keys`—not `pane run` (shell syntax).

---

## 7. API: snapshot / schema fields to persist

### Snapshot (`herdr api snapshot`)

Top-level `result.snapshot` (`SessionSnapshot`):

- `version`, `protocol`
- `workspaces[]`, `tabs[]`, `panes[]`, `layouts[]`, `agents[]`
- `focused_workspace_id`, `focused_tab_id`, `focused_pane_id`

### `AgentInfo` / pane fields Meepo should store

| Field | Role |
| --- | --- |
| `terminal_id` | **Primary host id** (stable while pane lives) |
| `pane_id` | Close/read/process-info/status wait |
| `tab_id` | Layout / tab close |
| `workspace_id` | Placement / list filter |
| `name` | Meepo unique title (`agent start` name) |
| `agent` | Detected/reported kind (`pi`, null for bare cmd) |
| `display_agent` | Optional UI override |
| `agent_status` | Host view of busyness |
| `cwd` / `foreground_cwd` | Reconcile working dir |
| `focused` | UX only |
| `revision` | Change counter for polling |
| `agent_session` | Optional session ref from report-agent-session |
| `title` / `terminal_title` / `terminal_title_stripped` | Display |
| `tokens` / `state_labels` | Metadata channel (`report-metadata`) |

### Events (for future push reconcile)

`EventKind` includes `pane_created`, `pane_closed`, `pane_exited`, `pane_agent_detected`, `pane_agent_status_changed`, `pane_output_changed`, tab/workspace lifecycle, etc. Schema also has `events.subscribe` / `events.wait`—useful later; v1 can poll `session.snapshot`.

### Methods count

Schema lists **85** request methods. Meepo should wrap a **thin** subset only (map out-of-scope: full herdr tool dump).

---

## 8. Gaps vs Meepo tmux today

| Area | tmux today (meepo) | herdr | Gap / risk |
| --- | --- | --- | --- |
| Host ids | session/window/pane | terminal_id + pane/tab/workspace | Registry migration (`host_kind`, neutral targets) |
| Spawn | new window in detached/primary session | agent start pane/tab | Extra root pane when using tab create; no "window" abstraction |
| Unique names | Meepo agentId / title | server `agent_name_taken` | Good—but race if process dies between check and start |
| Capture | tmux capture-pane | agent/pane read | Source modes differ; bridge mirror still required |
| Stop | kill pane / graceful bridge cancel | pane close | Map interrupt keys; no agent-level stop |
| Services | `tmux_service_*` | same agent start path | Easy parity if named `svc-…` |
| Status | bridge + Meepo DB | detection + optional report | pi integration not installed; detection ≠ task state |
| Notify | none in core | notification show | herdr-only UX |
| Focus steal | controllable | default no focus | OK if always `--no-focus` |
| Remote | local tmux | `--remote` SSH server | Out of scope unless specified |
| List noise | Meepo DB | `agent list` mixes all pi in all workspaces | Filter by workspace_id + name prefix / stored ids |
| Attach | tmux attach | agent attach | Human debugging, not coordinator default |

### Open risks for ProcessHost design

1. **Layout policy:** tab-per-child leaves unused root panes; split-in-primary-tab crowds coordinator—needs an explicit decision.
2. **Stable identity:** `pane_id` recycles; must key registry on `terminal_id` + Meepo `name`, reconcile via snapshot.
3. **Status coupling:** Do not block Meepo task state on herdr `idle/working`; optional notify/wait only.
4. **`done` asymmetry** across wait/report APIs.
5. **Name uniqueness races** on fast exit; concurrent coordinators.
6. **RPC typing fallback** depends on send-keys vocabulary (not fully enumerated here).
7. **Integration install** for authoritative report-agent vs screen scrape.
8. **No mixed tmux+herdr** in one primary (map decision)—selection must be sticky per session.
9. **pane close** is hard stop—graceful bridge cancel must happen *before* close (same as tmux).
10. **Protocol 16** may change—pin version in adapter tests; re-check schema on upgrade.
11. **agent list** focuses on agents; services still need name + terminal_id.
12. Always use `--no-focus`; avoid closing user workspaces.

---

## Meepo adapter implications

### ProcessHost method → herdr mapping

| ProcessHost op | herdr |
| --- | --- |
| `spawn(name, cwd, argv, env)` | `agent start <name> --cwd --workspace <sticky> [--tab] --no-focus [--env] -- argv` |
| `list` / `get` | `agent list` filtered / `agent get` by name or terminal_id |
| `focus` | `agent focus` |
| `capture` | `agent read --source recent` (or visible) |
| `stop` | bridge cancel then `pane close` |
| `reconcile` | `api snapshot` + process-info; mark lost if terminal_id missing |
| `notify` | `notification show` (optional) |
| `service_start` | `agent start svc-…` same path |

### Config

- `processHost: auto|tmux|herdr` and `MEEPO_PROCESS_HOST`
- auto = herdr on PATH **and** server compatible (`herdr status`: protocol match)—else tmux
- One backend per primary session

### Registry fields (host-neutral + herdr)

- Keep Meepo `agentId`, title, runDir, bridge paths
- Add `hostKind: 'herdr' | 'tmux'`
- herdr: `terminalId`, `paneId`, `tabId`, `workspaceId`, `agentName`
- tmux: existing `tmuxSessionId`, `tmuxWindowId`, `tmuxPaneId`, …

### What not to wrap

workspace/tab/pane layout algebra, plugins, worktrees, graphics, full event bus—except as internal implementation for spawn/cleanup.

---

## Command evidence log (abbreviated)

```text
$ herdr --version
herdr 0.7.4

$ herdr status
client: version 0.7.4, protocol 16
server: running, compatible yes, socket ~/.config/herdr/herdr.sock

$ herdr agent start meepo-research-long --cwd /tmp --workspace w4 --no-focus -- cat
→ agent_started name=meepo-research-long terminal_id=term_… pane_id=w4:p6

$ herdr agent start meepo-research-long … -- cat
→ error agent_name_taken (candidates include terminal_id/pane_id)

$ herdr agent get term_… / w4:p6 / meepo-research-long
→ same AgentInfo

$ herdr agent rename meepo-research-long meepo-research-long2
→ name updates; old name agent_not_found

$ herdr agent send meepo-research-long2 'hello-research'
→ ok (literal)

$ herdr pane close w4:p6
→ ok; name released

$ herdr tab create --workspace w4 --label meepo-research-clean --no-focus
→ root_pane + tab; agent start adds second pane in tab
$ herdr tab close …
→ ok

$ herdr api schema → protocol 16; AgentStatus includes done; PaneAgentState does not
$ herdr integration status → pi not installed (detection still labels pi panes)
```

All `meepo-research-*` panes/tabs/workspaces created for this note were closed; user workspaces ace/list/meepo/obsidian-memory-pi left intact.

---

## Acceptance checklist (issue #16)

- [x] Concrete answers for areas 1–8 with herdr `0.7.4` pinned
- [x] Explicit primitive map for spawn/focus/capture/stop/reconcile/notify
- [x] Open risks listed for ProcessHost design
- [x] Written to `docs/research/herdr-agent-lifecycle.md`
