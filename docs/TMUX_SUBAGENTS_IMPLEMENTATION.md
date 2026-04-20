# Pi tmux Subagents: Explicit Implementation Instructions

## Purpose

Build a **global pi extension/package** that allows pi to spawn, track, supervise, and communicate with tmux-backed subagents across:

- multiple projects
- multiple pi sessions
- full restarts of the primary pi session
- full restarts of the terminal / tmux client

This document is the **implementation source of truth** for the feature.

---

## Locked decisions

These decisions are considered settled unless explicitly revised later.

### 1. Global persistence
Use a **global SQLite database** as the system of record.

**Database path:**
- `~/.pi/agent/subagents.db`

Reason:
- the primary agent must be able to rediscover running or historical subagents across projects and after restart
- session-local state is not sufficient

### 2. Global package layout
The implementation should live in the global pi config/package area, not only in a project-local extension.

Target dotfiles layout:
- `~/.pi/agent/extensions/tmux-agents/...`
- `~/.pi/agent/skills/...`
- `~/.pi/agent/agents/...`
- `~/.pi/agent/prompts/...`

### 3. Child-initiated communication
The primary agent **must not depend on polling subagents for feedback**.

Instead, subagents must proactively publish:
- questions
- blockers
- milestone updates
- completion handoffs

The primary agent may inspect already-published registry state, but the normal workflow must be **event-driven upward reporting**, not request/response polling for feedback.

### 4. rg-only search policy
Do **not** use the `find` tool in this system.

All file/content discovery must use **ripgrep**:
- built-in `grep` tool for content search
- `bash` with `rg --files` / `rg --files -g` for file discovery

We should also consider blocking `find` entirely inside the extension runtime so it cannot be used accidentally.

### 5. Bigger initial scope is acceptable
Do **not** artificially shrink the feature into a tiny v1 if that would force redesign later.

The intended initial implementation includes:
- global registry
- tmux integration
- dashboard UI
- keybindings
- mailbox / communication protocol
- tools
- skills
- agent prompts
- progress / blocker / completion reporting

---

## Primary user experience goal

A user should be able to:

1. ask the main pi agent to delegate work
2. have pi spawn one or more tracked child agents in tmux windows
3. see those agents in a dashboard inside pi
4. switch to those tmux windows from pi
5. have child agents proactively surface:
   - questions
   - blockers
   - milestone updates
   - final summaries
6. close pi entirely and later reopen it
7. still have the primary agent rediscover active child agents and unread child-originated messages

---

## System overview

The system has 5 main parts:

1. **Global registry**
   - SQLite DB with agent records, mailbox messages, event log, and artifact references

2. **Run directories**
   - per-agent directories with launch scripts, prompts, session files, and debug artifacts

3. **pi extension runtime**
   - tools
   - slash commands
   - keyboard shortcuts
   - dashboard UI
   - background synchronization / reconciliation

4. **Skills**
   - delegation and orchestration behavior for the coordinator agent

5. **Agent profile prompts**
   - worker/scout/planner/reviewer/etc.
   - runtime communication appendix injected per child

---

## Required filesystem layout

### Global runtime files

- `~/.pi/agent/subagents.db`
- `~/.pi/agent/subagents/runs/<agent-id>/...`

### Dotfiles source layout

Inside the dotfiles repo, place the future implementation under:

- `pi/.pi/agent/extensions/tmux-agents/`
- `pi/.pi/agent/skills/dispatch-subagents/`
- `pi/.pi/agent/skills/communicate-subagents/`
- `pi/.pi/agent/skills/handoff-subagents/`
- `pi/.pi/agent/skills/supervise-subagents/`
- `pi/.pi/agent/agents/`
- `pi/.pi/agent/prompts/`

### Run directory layout

Each child agent run must have its own directory:

```text
~/.pi/agent/subagents/runs/<agent-id>/
  task.md
  runtime-appendix.md
  launch.sh
  session.jsonl
  latest-status.json
  events.jsonl
  debug.log            # optional but recommended
```

---

## SQLite schema requirements

Use Node’s built-in `node:sqlite` module.

### DB behavior requirements

- enable WAL mode
- set a busy timeout
- create migrations / schema bootstrap automatically
- support concurrent readers/writers from multiple pi processes

### Required tables

#### `agents`
Tracks each child agent.

Required fields:
- `id TEXT PRIMARY KEY`
- `parent_agent_id TEXT NULL`
- `spawn_session_id TEXT NULL`
- `spawn_session_file TEXT NULL`
- `spawn_cwd TEXT NOT NULL`
- `project_key TEXT NOT NULL`
- `profile TEXT NOT NULL`
- `title TEXT NOT NULL`
- `task TEXT NOT NULL`
- `state TEXT NOT NULL`
- `model TEXT NULL`
- `tools_json TEXT NULL`
- `tmux_session_id TEXT NULL`
- `tmux_session_name TEXT NULL`
- `tmux_window_id TEXT NULL`
- `tmux_pane_id TEXT NULL`
- `run_dir TEXT NOT NULL`
- `session_file TEXT NOT NULL`
- `last_tool_name TEXT NULL`
- `last_assistant_preview TEXT NULL`
- `last_error TEXT NULL`
- `final_summary TEXT NULL`
- `created_at INTEGER NOT NULL`
- `updated_at INTEGER NOT NULL`
- `finished_at INTEGER NULL`

Allowed states:
- `launching`
- `running`
- `idle`
- `waiting`
- `blocked`
- `done`
- `error`
- `stopped`
- `lost`

#### `agent_messages`
Structured mailbox messages.

Required fields:
- `id TEXT PRIMARY KEY`
- `thread_id TEXT NOT NULL`
- `sender_agent_id TEXT NULL`
- `recipient_agent_id TEXT NULL`
- `target_kind TEXT NOT NULL`
- `kind TEXT NOT NULL`
- `delivery_mode TEXT NOT NULL`
- `payload_json TEXT NOT NULL`
- `status TEXT NOT NULL`
- `created_at INTEGER NOT NULL`
- `delivered_at INTEGER NULL`
- `acked_at INTEGER NULL`

Suggested `target_kind` values:
- `primary`
- `user`
- `child`

Suggested `kind` values:
- `started`
- `milestone`
- `blocked`
- `question`
- `question_for_user`
- `answer`
- `note`
- `redirect`
- `cancel`
- `priority`
- `complete`

Suggested `delivery_mode` values:
- `immediate`
- `steer`
- `follow_up`
- `idle_only`

Suggested `status` values:
- `queued`
- `delivered`
- `acked`
- `failed`
- `expired`

#### `agent_events`
Immutable event log for observability.

Required fields:
- `id TEXT PRIMARY KEY`
- `agent_id TEXT NOT NULL`
- `event_type TEXT NOT NULL`
- `summary TEXT NULL`
- `payload_json TEXT NULL`
- `created_at INTEGER NOT NULL`

#### `artifacts` (recommended)
Tracks references to run-dir/session artifacts and handoff attachments.

---

## Communication model requirements

## Non-negotiable rule

The primary agent should not need to ask subagents for feedback as a normal control flow.

### Normal upward communication flow

Children publish automatically when:
- work begins
- a meaningful milestone is reached
- a blocker is encountered
- a question must be asked
- the task is complete

### Allowed downward communication flow

The coordinator may still send:
- answers
- steering notes
- redirects
- cancellation requests
- priority changes

### What should not be normal

Do **not** make `status_request -> status_response` the standard supervision loop.

The primary can inspect the registry and inbox, but should not need to actively ping children just to know what is happening.

---

## Required child reporting behavior

Every child agent runtime must automatically emit the following:

### 1. Start event
When the child begins real work:
- write a `started` event
- set agent state to `running`
- store initial preview if available

### 2. Milestone event
When the child completes a meaningful chunk:
- write a `milestone` message/event
- include concise summary
- include exact file paths involved when relevant
- update `last_assistant_preview`

### 3. Blocked event
When the child is stuck:
- immediately set state to `blocked`
- write a `blocked` message/event
- include blocker reason
- include what was attempted
- include what answer is needed

### 4. Question event
If clarification is required:
- write a `question` or `question_for_user` message
- ask only one concrete question at a time
- include only the minimum necessary context
- reference exact paths when relevant

### 5. Complete event
When the task is done:
- set state to `done`
- write a `complete` message/event
- include a handoff summary
- include changed files / relevant files
- include blockers left unresolved, if any
- include recommended next action

---

## Required tools

These are model-callable tools to expose through the extension.

### `subagent_spawn`
Spawn a tracked child in a new tmux window.

Inputs should include:
- `title`
- `task`
- `profile`
- optional `cwd`
- optional `model`
- optional `tools`
- optional `parentAgentId`
- optional `priority`

Behavior:
- create DB row
- create run dir
- write task prompt
- write runtime appendix
- write launch script
- create tmux window
- store tmux ids
- append a custom entry in the current pi session linking the child

### `subagent_list`
List agents from the registry.

Must support filters such as:
- current project
- current primary session
- descendants of current primary
- active only
- blocked only
- unread only
- all

### `subagent_get`
Get detailed current state for one or more agents.

Should return:
- state
- profile
- title
- current/last tool
- last preview
- last unread child-originated message
- latest milestone/blocker/completion info
- tmux targeting info

### `subagent_focus`
Switch tmux client to the child’s window.

### `subagent_stop`
Stop child gracefully, with optional force kill.

### `subagent_message`
Send a structured downward message to a child.

Use cases:
- answer a question
- redirect task
- cancel current work
- add note
- change priority

### `subagent_inbox`
Read unread inbound child-originated messages for the current coordinator context.

Important:
- this is not a polling tool for feedback generation
- it only reads messages already published by children

### `subagent_capture`
Capture extra context from tmux pane or transcript.

Important:
- this is a debug/fallback tool, not the normal supervision path
- prefer `subagent_attention`, `subagent_inbox`, `subagent_get`, and structured downward/upward messages first

### `subagent_reconcile`
Reconcile registry state against tmux/session reality.

---

## Required slash commands

- `/agents` — open dashboard
- `/agent-spawn` — spawn wizard
- `/agent-open <id>` — focus tmux target
- `/agent-stop <id>` — stop target
- `/agent-message <id> ...` — send downward message
- `/agent-sync` — reconcile registry state

---

## Required UI behavior

The UI is part of scope.

### Footer status
Use `ctx.ui.setStatus()` to display fleet summary.

Target summary style:
- `🤖 6 active · 2 blocked · 1 user question · 3 unread`

### Widget
Use `ctx.ui.setWidget()` to show the highest-priority items, especially:
- unanswered user-facing questions
- unanswered primary-facing questions
- blocked children
- newly completed children

### Dashboard
Use `ctx.ui.custom()` for an interactive dashboard.

The dashboard must support:
- filtering
- sorting
- unread indicators
- blocked indicators
- viewing details
- focusing tmux target
- stopping child
- replying to child
- viewing recent events
- seeing parent/child relationships

### Required priority ordering
Show child-originated attention in this order:
1. user-facing questions
2. primary-facing questions
3. blocked agents
4. unread completion summaries
5. active running agents
6. idle/done/stopped agents

---

## Required keyboard shortcuts

Recommended defaults:
- `Ctrl+Alt+A` — open agents dashboard
- `Ctrl+Alt+N` — open spawn wizard
- `Ctrl+Alt+J` — focus next active agent
- `Ctrl+Alt+K` — focus previous active agent

These should be surfaced in the UI and remain configurable via pi keybindings.

---

## Skills to create

### `dispatch-subagents`
When to use:
- work should be split across roles or isolated contexts

Rules:
- spawn intentionally by profile
- avoid duplicate spawns if an appropriate agent already exists
- rely on proactive child reporting
- summarize child states for the user based on the registry/inbox

### `communicate-subagents`
When to use:
- a child has asked a question or raised a blocker
- the coordinator needs to answer or redirect

Rules:
- do not ask children for feedback as a normal workflow step
- read inbox / registry
- send downward messages only when needed

### `handoff-subagents`
When to use:
- one child’s completion summary should feed another child

Rules:
- use structured handoff summaries
- include file paths and minimal relevant context
- avoid giant raw dumps

### `supervise-subagents`
When to use:
- multiple subagents are active
- blockers/questions/unread completions must be triaged

Rules:
- dashboard and inbox are the primary supervision surfaces
- blocked/user-question items come first

---

## Agent profiles to create

At minimum:
- `worker`
- `scout`
- `planner`
- `reviewer`
- optional `coordinator-helper`

### Profile-specific rule
None of these profiles should rely on `find`.

Search/discovery expectations:
- `grep` for content search
- `bash` with `rg --files` for file discovery
- `read` for focused inspection
- `ls` only for small directory browsing where useful

---

## rg-only search policy (implementation rule)

This rule must appear in:
- skills
- profile prompts
- tool guidelines if needed
- extension guard logic

### Required behavior

Do not use `find`.

Instead use:
- `grep` tool for content search
- `bash` + `rg --files`
- `bash` + `rg --files -g '<glob>'`
- `bash` + `rg -n '<pattern>'`

### Recommended enforcement

Inside the extension:
- block the `find` tool if it is active
- optionally remove `find` from active tools entirely in relevant subagent profiles

---

## Prompt requirements

## Runtime appendix for every child
Every child prompt must be augmented with a runtime appendix stating:
- child id
- profile
- reporting contract
- communication contract
- question discipline
- requirement to proactively publish started/milestone/blocked/question/complete

### Required completion format
Every child completion should include:
- completed work
- files changed / files involved
- blockers remaining
- recommended next action

---

## tmux requirements

### Spawn behavior
Each child must launch in a tmux window and store stable tmux ids:
- session id
- session name
- window id
- pane id

### Focus behavior
The extension must be able to focus the exact tmux target later.

### Reconciliation behavior
If tmux target disappears unexpectedly:
- mark agent `lost` or `stopped` depending on evidence
- log an event
- show this in dashboard/inbox

---

## Session linkage requirements

Even though SQLite is the global registry, also append a custom entry into the parent pi session containing:
- child id
- title
- profile
- task
- run dir
- session file
- tmux identifiers
- timestamp

Reason:
- preserve lineage within the primary pi session tree
- make parent session history self-describing

---

## Acceptance criteria

The feature is acceptable only when all of the following are true:

1. The primary agent can spawn multiple tracked subagents in tmux.
2. Child agents persist in a global registry across projects and restarts.
3. Child questions/blockers/completions appear without needing the primary to poll for feedback.
4. The primary agent can reopen later and still see unread child-originated items.
5. The dashboard can list/filter/focus/stop/reply.
6. Keybindings work for dashboard and agent focus actions.
7. `find` is not part of the search workflow.
8. ripgrep is the standard discovery/search mechanism.
9. Skills and prompts reinforce the same behavior the tools/runtime expect.

---

## Recommended implementation order

1. Create SQLite bootstrap + schema + helpers.
2. Create run-dir and spawn machinery.
3. Create child runtime reporting hooks.
4. Create inbox processing / unread state.
5. Create dashboard UI.
6. Add slash commands and shortcuts.
7. Create skills.
8. Create agent profiles + runtime appendix generation.
9. Add rg-only enforcement.
10. Add reconciliation and polish.

---

## Important anti-goals

Do not:
- build this around `status_request` polling as the normal supervision path
- rely on fragile pane scraping as the main state source
- rely only on current session memory
- keep `find` in the active workflow
- make the coordinator guess what a child is doing without explicit child reporting

---

## Notes for future implementation

Potential implementation modules:
- `db.ts`
- `registry.ts`
- `mailbox.ts`
- `tmux.ts`
- `spawn.ts`
- `dashboard.ts`
- `status.ts`
- `skills/`
- `agents/`
- `prompts/`

This document should be kept in sync with progress tracking.
