# Meepo

Meepo is a Pi package that orchestrates plain child sessions on a process host. It tracks Children, Services, Tasks, Inbox mail, and Attention. It does not ship agent roles or methodology.

## Language

**ProcessHost**:
The seam that places, focuses, stops, and captures Child and Service processes. Two adapters exist: tmux and herdr.
_Avoid_: backend, substrate, runner

**HostIdentity**:
The caller-facing token for a live pane, window, or tab. `kind`, `primaryId`, and `displayName` only. A Child or Service has no host until spawn succeeds.
_Avoid_: tmux target, pane id, host fields, HostHandle

**HostTarget**:
The live adapter token returned by ProcessHost.spawnWindow. Includes adapter refs. Callers keep HostIdentity; adapters keep refs.
_Avoid_: exposing refs to callers

**Child**:
A tracked Pi replica launched against a Task. The live process sits on a ProcessHost; the registry row is the source of truth for host identity.
_Avoid_: agent (except as a stored column/legacy tool name), replica, subagent (except tool names)

**Service**:
A tracked long-running command on a ProcessHost. Not a Child.
_Avoid_: tmux service

**Inbox**:
The module that publishes, lists, and marks mail between the coordinator and a Child. One id, one mark.
_Avoid_: mailbox, v2 message, delivery queue

**Attention**:
An open question, blocker, or completion that needs a coordinator or user response.
_Avoid_: notification, wakeup (except the wake action)

**Task**:
A unit of work on the board. Children attach to Tasks; the board tracks Task lifecycle, not Child lifecycle.
_Avoid_: ticket, issue

**Child fleet**:
The module that stops, focuses, captures, and reconciles Children.
_Avoid_: agent-lifecycle, coordinator-helpers

**Board**:
The projection of Tasks, Children, and Attention into an operator view.
_Avoid_: dashboard (except the existing TUI surface)

## Relationships

- A Child or Service has at most one HostIdentity.
- ProcessHost adapters resolve a HostIdentity to a live pane or window. Callers pass the token, never adapter refs.
- Inbox and Attention share one write path. Legacy tables are a private read adapter. Callers see one Attention list.
- The coordinator talks to Children through Inbox, not by polling host panes.
