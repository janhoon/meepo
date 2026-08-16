# MeepoRuntime config contract

Meepo is split into a **platform** (process-hosted subagents via **tmux or herdr**, registry, optional tasks/services) and optional **doctrine presets** (org chart, no-wait enforce, review-lease name compat, dense orchestration personas).

The deep module is **MeepoRuntime**: it loads config, optionally seeds doctrine, and registers tools/commands through a capability filter.

## Defaults (methodology-neutral platform)

Unconfigured installs use the **core** preset:

| Axis | Core default |
|---|---|
| preset | `core` |
| capabilities | `agents.core` + `agents.attention` only |
| policies.noWait | `off` |
| policies.hierarchy | `off` |
| policies.taskLeases | `off` |
| policies.searchGuidance | `null` |
| profiles.dirs | `[]` → consumer `~/.pi/agent/agents` only (Meepo ships **no** agent profiles) |
| profiles.allowUnknownTools | `false` |
| profiles.extraTools | `[]` |
| org seeder | **not** applied |
| profile name-compat | **not** registered |

Core is durable multi-agent process control without company playbook or Kanban tool flood.

## Full operator preset

Set `MEEPO_PRESET=full` (or pass `preset: "full"` to `loadMeepoConfig`):

| Axis | Full |
|---|---|
| capabilities | all (`agents.core`, `agents.attention`, `tasks.core`, `tasks.graph`, `tasks.ops`, `services`, `ui`) |
| policies.noWait | `enforce` |
| policies.hierarchy | `enforce` |
| policies.taskLeases | `on` |
| policies.searchGuidance | `rg-only` (guidance string; not a hard platform ban) |
| org seeder | applied (CEO/CTO/engineer edge chart) |
| profile name-compat | registered (legacy review names / principal-engineer→reviewer) |

## Config shape

```ts
{
  version: 1,
  preset: "full" | "core",
  capabilities: MeepoCapability[],
  policies: {
    noWait: "off" | "prompt" | "enforce",
    searchGuidance: string | null,
    hierarchy: "off" | "advisory" | "enforce",
    taskLeases: "off" | "on",
  },
  profiles: {
    dirs: string[],           // ordered; later shadows earlier by profile name
    allowUnknownTools: boolean,
    extraTools: string[],
  },
  runtime: {
    agentDir: string | null,  // reserved; null = Pi getAgentDir defaults
    detachedSessionName: string, // default "pi-subagents" (tmux agent pool)
    serviceDetachedSessionName: string, // default "pi-services" (tmux service pool)
    processHost: "auto" | "tmux" | "herdr", // default "herdr"
  },
}
```

### Process host backend

Meepo freezes **one** process host per primary session at `MeepoRuntime.start`:

| Selection | Behavior |
|---|---|
| `herdr` (default) | Always use the herdr adapter (fails if herdr is unavailable) |
| `auto` | Prefer **herdr** when on `PATH` and `herdr --version` succeeds; else **tmux** |
| `tmux` | Always use the tmux adapter |

**Precedence:** env `MEEPO_PROCESS_HOST` → config `runtime.processHost` → `herdr`.

Registry stores host-neutral `host_kind` / `host_primary_id` / `host_display_name` / `host_target_json` plus legacy `tmux_*` columns for compatibility.

On the **herdr** backend only, user-facing attention wakes fire `herdr notification show` for:

| Attention | Toast title | Sound |
|---|---|---|
| `question` / `question_for_user` | `Question: <displayName>` | `request` |
| `blocked` | `Blocked: <displayName>` | `request` |
| `complete` | `Done: <displayName>` | `done` |

Rate limit: max one toast per agent per kind per 30s; `complete` once per agent per primary session. The **tmux** backend no-ops `notify` (Pi UI wake path still runs).

### RPC / child control plane (host-agnostic)

Parent↔child control uses the same **`rpc_bridge`** on every ProcessHost backend:

- Spawn writes identical run-dir artifacts and a launch script whose main process is `rpc-bridge.mjs` (not bare `pi`).
- ProcessHost only places that launch command (tmux window or herdr named agent); it does **not** carry send/ping APIs.
- `subagent_message` delivery modes (`immediate` / `steer` / `follow_up` / `idle_only`) map to bridge commands (`prompt` / `steer` / `follow_up`) only.
- Degraded path is inbox/poll + bridge status files — **not** herdr PTY typing or `agent send`.
- Graceful stop: bridge cancel when possible, then ProcessHost `stop` (tmux kill / herdr pane close). Force stop is ProcessHost only.
- Transport kind stays `rpc_bridge` (no `rpc_bridge_herdr`). Host identity lives in `host_*` fields.

### Loading

`loadMeepoConfig(options?)`:

1. Base from `options.preset` or env `MEEPO_PRESET` or **`core`**
2. Optional overrides: `capabilities`, `policies`, `profiles`, `runtime`
3. Env `MEEPO_PROCESS_HOST` overrides `runtime.processHost` when set

### Messaging model

New upward publishes (`subagent_publish`) write the hierarchy (v2) message + attention path only. Legacy `agent_messages` / `attention_items` rows remain readable for pre-migration data and for the downward delivery queue (`subagent_message` → child). Inbox/list/fleet readers merge v2 with non-shadow legacy rows.

### Capabilities → tools

| Capability | Coordinator tools (subset) |
|---|---|
| `agents.core` | spawn, list, get, message, stop, focus, cleanup, reconcile, capture |
| `agents.attention` | inbox, attention |
| `tasks.core` | create, list, get, update, move, note |
| `tasks.ops` | link_agent, unlink_agent, attention, reconcile |
| `tasks.graph` | link, unlink, links, ready, dispatch_ready, subtree_control |
| `services` | `service_*` (plus legacy `tmux_service_*` aliases) |
| `ui` | board/standup chrome + shortcuts |

Slash commands and shortcuts are gated the same way (see `COMMAND_CAPABILITY` in config).

## Policy modes

### noWait

| Mode | System prompt | Bash sleep/watch/tail -f/polling |
|---|---|---|
| `off` | unchanged | allowed |
| `prompt` | inject guidance | allowed |
| `enforce` | inject guidance | **blocked** |

### hierarchy

| Mode | Missing/denied edge policy |
|---|---|
| `off` | allow spawn |
| `advisory` | allow spawn + `hierarchy_policy_advisory` event |
| `enforce` | **deny** spawn (historical behavior) |

## Profiles (bring your own)

**Meepo does not ship agent profiles, role prompts, or a default org of subagents.** Spawn requires a consumer-provided profile name that resolves from markdown on disk.

Default load path when `profiles.dirs` is empty:

1. `getAgentDir()/agents` (usually `~/.pi/agent/agents/*.md`)

Optional extra dirs (project packs, private agent packages) go in `profiles.dirs` — later dirs shadow earlier ones by profile `name`.

Example consumer profile:

```yaml
---
name: my-reviewer
description: Strict code review for this team
tools: read, bash, grep
role: reviewer
lease: review
canSpawn: false
---

You are a reviewer. Follow our team review checklist…
```

Frontmatter fields consumers may set:

- **lease**: `exclusive` | `review` | `shared` | `none` — metadata wins; full preset may also register optional name-compat fallbacks for installs that still use historical names without frontmatter.
- **role**: hierarchy role key — metadata wins; full preset may register optional aliases (still not agent prompts).
- **profiles.dirs**: ordered consumer dirs; empty → user Pi agents dir only.
- **extraTools / allowUnknownTools**: extend closed child tool allowlist.

If no profiles are installed, `subagent_spawn` fails with a clear BYO error listing available names as `(none)`. Author a consumer profile with the `create-subagents` skill, then restart Pi.

## Upgrade notes (existing `subagents.db`)

- Schema migrations remain **non-destructive**.
- Historical `migration_6_seed` role/edge rows stay as `INSERT OR IGNORE`.
- Full preset **re-asserts** the same org chart via `org-preset` seeder (`source: full-org-preset`) on runtime start.
- Core preset does **not** delete existing org rows; it simply does not require them (hierarchy `off`).
- Profile frontmatter `lease`/`role` are additive; agents without metadata still work under full compat registry.

## Tests

```bash
npm test
# or
npx tsx --test extensions/meepo/*.test.ts
```

Acceptance matrix: `extensions/meepo/acceptance-matrix.test.ts` (no tmux).

## Related

- PRD: GitHub issue #4
- Tickets: #5–#14 (MeepoRuntime seam)
