# meepo

A Pi package for tmux-backed subagents and tracked long-running tmux services.

## Includes

- `extensions/tmux-agents/`
  - subagent registry, spawn, messaging, reconcile, dashboard
  - tracked tmux services for API servers, frontend dev servers, watchers, and other long-running tasks
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

### Subagents

- `subagent_spawn`
- `subagent_list`
- `subagent_get`
- `subagent_focus`
- `subagent_stop`
- `subagent_message`
- `subagent_inbox`
- `subagent_capture`
- `subagent_reconcile`

### Long-running tmux services

- `tmux_service_start`
- `tmux_service_list`
- `tmux_service_get`
- `tmux_service_focus`
- `tmux_service_stop`
- `tmux_service_capture`
- `tmux_service_reconcile`

## Interactive commands

- `/agents`
- `/agent-spawn`
- `/agent-open <id>`
- `/agent-stop <id> [force]`
- `/agent-message <id> <kind> <message>`
- `/agent-capture <id> [lines]`
- `/agent-sync`
- `/service-start`
- `/services [scope]`
- `/service-open <id>`
- `/service-stop <id> [force]`
- `/service-capture <id> [lines]`
- `/service-sync`

## Notes

- Child agents report upward proactively through the registry instead of relying on status polling.
- Search policy is ripgrep-first. `find` is intentionally excluded from the normal workflow.
- Agent profiles are stored in `agents/` because the extension resolves them relative to its package layout.

## Docs

- `docs/TMUX_SUBAGENTS_IMPLEMENTATION.md`
- `docs/TMUX_SUBAGENTS_PROGRESS.md`
