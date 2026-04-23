# First-wave G Stack role rollout

This document describes how to use and validate the first-wave G Stack integration in `meepo`.

## What landed

### New primary org-style roles

- `coo`
- `ceo`
- `cto`
- `engineer`
- `principal-engineer`
- `qa-lead`
- `design-lead`
- `cso`

### Core supporting docs

- `docs/GSTACK_INTEGRATION.md`
- `docs/GSTACK_UPSTREAM_STATUS.md`
- `docs/REVIEW_PACKS.md`

### Updated orchestration guidance

- `prompts/implement.md`
- `prompts/implement-and-review.md`
- `skills/dispatch-subagents/SKILL.md`
- `skills/supervise-subagents/SKILL.md`

## Compatibility and migration

First-wave rollout is **additive**, not destructive.

Legacy helper profiles remain available:

- `scout`
- `planner`
- `worker`
- `reviewer`
- `coordinator-helper`

Recommended usage during migration:

- prefer `engineer` over `worker`
- prefer `principal-engineer` over `reviewer` for non-trivial code review
- prefer `coo` / `ceo` / `cto` over generic planning-only flows when product or architecture judgment is needed
- keep `scout` and `planner` as narrow compatibility helpers when they are still the best fit

## Default first-wave operating model

For a non-trivial implementation task:

1. `coo` owns task routing and acceptance gates
2. `ceo` sharpens wedge/scope when needed
3. `cto` hardens architecture and validation plans when needed
4. `engineer` implements
5. `principal-engineer` review pack runs in `structured`, `adversarial`, and `outside-voice` modes
6. `qa-lead`, `design-lead`, and `cso` join when scope requires them
7. `coo` synthesizes findings and decides whether the task goes back to `in_progress` or can move toward `done`

## Review-pack validation checklist

Use this when validating the new acceptance topology:

1. Confirm the implementation prompt routes a non-trivial task to `in_review` instead of self-accepting it.
2. Confirm the review pack is described as sibling subagents on the same task id.
3. Confirm `outside-voice` is expressed as a `principal-engineer` mode plus a `model` override.
4. Confirm the coordinator synthesis includes:
   - agreed findings
   - unique to structured review
   - unique to adversarial review
   - unique to outside-voice review
   - required fixes before `done`
5. Confirm the task is not moved to `done` until required review-pack members pass or the user explicitly waives a gate.

## Browser-path validation checklist

Use this when validating browser routing:

1. Confirm browser-facing work routes to `qa-lead` or `design-lead`.
2. Confirm those roles read upstream G Stack browser docs rather than defaulting to Pi browser tools.
3. Confirm Pi browser tools are described as fallback-only.
4. Confirm concurrent browser-backed agents are given isolated cwd/worktree boundaries when needed.
5. Confirm headed browser or authenticated flows point at upstream `open-gstack-browser` / `setup-browser-cookies` docs when relevant.

## Upstream verification checklist

Before trusting a newer upstream G Stack revision:

1. resolve `GSTACK_ROOT`
2. compare the installed SHA against `docs/GSTACK_UPSTREAM_STATUS.md`
3. inspect the upstream files touched by the first-wave integration
4. rerun the role-loading, review-pack, and browser-path validation checks above
5. update `docs/GSTACK_UPSTREAM_STATUS.md` once the newer SHA is reviewed

## Known first-wave limits

- `devex-lead` and `sre` are still follow-up roles, not part of the landed first-wave profile set.
- Pi browser tools still exist and remain useful for fallback/troubleshooting, even though they are no longer the preferred browser path.
- Existing prompt flows are now role-aware, but older legacy profile names may still appear in historical task notes or old transcripts.

## Recommended next checks

- smoke a simple `engineer` → `principal-engineer` review-pack flow
- smoke a `qa-lead` browser task against a known G Stack checkout
- verify `GSTACK_ROOT` resolution on the machine or repo where these roles will actually run
