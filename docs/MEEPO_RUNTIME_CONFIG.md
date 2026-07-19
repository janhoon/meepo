# MeepoRuntime config contract

Meepo is split into a **platform** (tmux subagents, registry, optional tasks/services) and optional **doctrine presets** (org chart, no-wait enforce, review-lease name compat, dense orchestration personas).

The deep module is **MeepoRuntime**: it loads config, optionally seeds doctrine, and registers tools/commands through a capability filter.

## Defaults (operator compatibility)

Unconfigured installs use the **full** preset:

| Axis | Full default |
|---|---|
| preset | `full` |
| capabilities | all (`agents.core`, `agents.attention`, `tasks.core`, `tasks.graph`, `tasks.ops`, `services`, `ui`) |
| policies.noWait | `enforce` |
| policies.hierarchy | `enforce` |
| policies.taskLeases | `on` |
| policies.searchGuidance | `rg-only` (guidance string; not a hard platform ban) |
| profiles.dirs | `[]` → package `agents/` only |
| profiles.allowUnknownTools | `false` |
| profiles.extraTools | `[]` |
| org seeder | applied (CEO/CTO/engineer edge chart) |
| profile name-compat | registered (legacy review names / principal-engineer→reviewer) |

## Core consumer preset

Set `MEEPO_PRESET=core` (or pass `preset: "core"` to `loadMeepoConfig`):

| Axis | Core |
|---|---|
| capabilities | `agents.core` + `agents.attention` only |
| policies.noWait | `off` |
| policies.hierarchy | `off` |
| policies.taskLeases | `off` |
| org seeder | **not** applied |
| profile name-compat | **not** registered |

Core is for consumers who want durable multi-agent process control without the company playbook or Kanban tool flood.

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
    detachedSessionName: string, // default "pi-subagents"
  },
}
```

### Loading

`loadMeepoConfig(options?)`:

1. Base from `options.preset` or env `MEEPO_PRESET` or **`full`**
2. Optional overrides: `capabilities`, `policies`, `profiles`, `runtime`

### Capabilities → tools

| Capability | Coordinator tools (subset) |
|---|---|
| `agents.core` | spawn, list, get, message, stop, focus, cleanup, reconcile, capture |
| `agents.attention` | inbox, attention |
| `tasks.core` | create, list, get, update, move, note |
| `tasks.ops` | link_agent, unlink_agent, attention, reconcile |
| `tasks.graph` | link, unlink, links, ready, dispatch_ready, subtree_control |
| `services` | tmux_service_* |
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

## Profiles

Frontmatter fields (package agents already declare these under full preset):

```yaml
---
name: principal-engineer
description: ...
tools: read, bash, grep
role: reviewer
lease: review
canSpawn: false
---
```

- **lease**: `exclusive` | `review` | `shared` | `none` — metadata wins; full preset may also register name-compat fallbacks.
- **role**: hierarchy role key — metadata wins; full preset may alias `principal-engineer` → `reviewer` via compat registry.
- **profiles.dirs**: ordered merge; later dir replaces same `name`. Empty → package `agents/` only (resolved via extension `import.meta.url`, install-safe).
- **extraTools / allowUnknownTools**: extend closed child tool allowlist.

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
npx tsx --test extensions/tmux-agents/*.test.ts
```

Acceptance matrix: `extensions/tmux-agents/acceptance-matrix.test.ts` (no tmux).

## Related

- PRD: GitHub issue #4
- Tickets: #5–#14 (MeepoRuntime seam)
