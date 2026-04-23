# G Stack integration for Pi

This document defines how `meepo` integrates with [G Stack](https://github.com/garrytan/gstack) without vendoring or copying upstream skill content into this repo.

## Goal

Use G Stack as an **upstream methodology source** and the default **browser substrate** for browser-facing roles, while keeping Pi as the orchestrator for:

- tasks
- tmux-backed subagents
- model routing
- inbox/attention supervision
- durable task history
- memory and project-local orchestration

## Non-goals

This integration does **not**:

- copy G Stack `SKILL.md` bodies into `meepo`
- fork G Stack prompts into local duplicates
- replace Pi task/subagent orchestration with G Stack workflow state
- require Pi browser tools for the primary browser path

## Core principles

1. **Upstream stays upstream.** G Stack remains the source of truth for methodology.
2. **Pi stays the coordinator.** Pi owns task state, delegation, attention, and review-pack orchestration.
3. **Thin wrappers only.** Pi role profiles should load upstream G Stack docs and adapt them to Pi tools, tasks, and subagents.
4. **Verified updates, not blind drift.** Upstream changes should be reviewed and smoke-checked before they become the assumed baseline for Pi workflows.
5. **G Stack Browser is the default browser path.** Pi browser tools remain available as migration/fallback tooling, not the preferred browser substrate.

## `GSTACK_ROOT` resolution order

Pi role profiles that rely on upstream G Stack docs should resolve `GSTACK_ROOT` in this order:

1. `GSTACK_ROOT` environment variable, if set and valid
2. `$HOME/.claude/skills/gstack`
3. `$(git rev-parse --show-toplevel)/.claude/skills/gstack` when running inside a repo that bootstraps a project-local G Stack checkout or symlink

If none of those paths resolve to a valid G Stack checkout, the role should stop and report that G Stack is not installed/configured instead of guessing.

### Valid checkout test

A candidate `GSTACK_ROOT` is valid only if all of the following exist:

- `README.md`
- `VERSION`
- `browse/SKILL.md`
- `review/SKILL.md`
- `qa/SKILL.md`
- `codex/SKILL.md`

A practical bash check is:

```bash
resolve_gstack_root() {
  for candidate in \
    "${GSTACK_ROOT:-}" \
    "$HOME/.claude/skills/gstack" \
    "$(git rev-parse --show-toplevel 2>/dev/null)/.claude/skills/gstack"
  do
    [ -n "$candidate" ] || continue
    [ -f "$candidate/README.md" ] || continue
    [ -f "$candidate/VERSION" ] || continue
    [ -f "$candidate/browse/SKILL.md" ] || continue
    [ -f "$candidate/review/SKILL.md" ] || continue
    [ -f "$candidate/qa/SKILL.md" ] || continue
    [ -f "$candidate/codex/SKILL.md" ] || continue
    printf '%s\n' "$candidate"
    return 0
  done
  return 1
}
```

## Upstream verification and SHA tracking

Pi should treat G Stack updates as **verified** only after:

1. resolving a real `GSTACK_ROOT`
2. capturing `git -C "$GSTACK_ROOT" rev-parse HEAD`
3. comparing that SHA with the last verified SHA recorded in this repo
4. smoke-checking the affected Pi wrappers/prompts against the updated upstream docs

The durable place to record the currently reviewed upstream baseline is:

- `docs/GSTACK_UPSTREAM_STATUS.md`

### Update policy

- If the installed checkout matches the recorded verified SHA, Pi wrappers may assume the documented integration baseline.
- If the installed checkout differs, Pi should treat that as **unverified drift** and surface it in notes, review handoffs, or task history.
- Drift is not automatically a hard failure, but it should be visible before relying on changed upstream behavior.

## Browser ownership

For first-wave integration, browser-facing work should default to **G Stack Browser-backed roles**.

Primary browser owners:

- `qa-lead`
- `design-lead`
- later: `sre`

Expected upstream references for those roles include:

- `browse/SKILL.md`
- `BROWSER.md`
- `open-gstack-browser` guidance
- `setup-browser-cookies`
- `qa/SKILL.md`
- `qa-only/SKILL.md`
- `design-review/SKILL.md`
- later: `benchmark/SKILL.md`, `canary/SKILL.md`

### Pi browser tools policy

Pi browser tools remain available for:

- migration fallback
- break-glass debugging
- low-level troubleshooting when G Stack Browser is unavailable

But they are **not** the preferred browser path once the G Stack-backed roles are in place.

### Browser isolation and worktree policy

G Stack browser state is workspace-scoped. To avoid session collisions, browser-backed Pi subagents should normally run in an isolated cwd or dedicated worktree when multiple browser roles may be active at once.

Recommended practice:

- give `qa-lead`, `design-lead`, and later `sre` their own worktree or isolated project directory when they need concurrent browser sessions
- avoid sharing one browser-backed cwd across multiple active QA/design/browser agents unless that coupling is intentional
- record the chosen cwd or worktree in the task note or delegation handoff when it matters for reproduction

## Wrapper pattern for Pi roles

Pi role profiles should follow this pattern:

1. resolve and validate `GSTACK_ROOT`
2. read the relevant upstream G Stack docs from that root
3. apply the upstream methodology using Pi-native tools, tasks, and subagents
4. report findings and recommendations in Pi-friendly task-aware output formats

That means Pi roles may cite upstream paths like:

- `$GSTACK_ROOT/review/SKILL.md`
- `$GSTACK_ROOT/codex/SKILL.md`
- `$GSTACK_ROOT/browse/SKILL.md`
- `$GSTACK_ROOT/BROWSER.md`

but should not embed large copied prompt bodies from those files.

## Review-pack fit

G Stack's structured/adversarial/outside-voice review model should be expressed in Pi as **sibling subagents on the same task**, not as hidden nested shell work.

Pi owns:

- which reviewer roles are spawned
- which models they use
- how findings are synthesized
- how task state moves between `in_progress`, `in_review`, and `done`

G Stack supplies the review method; Pi supplies the review topology.

## Current rollout expectation

First-wave role work should point back to this document as the source of truth for:

- `GSTACK_ROOT` resolution
- verified SHA handling
- upstream-vs-local ownership
- G Stack Browser default ownership
- Pi browser fallback policy

For rollout and smoke-validation guidance, see `docs/GSTACK_ROLLOUT.md`.
