# Review packs in Pi

A **review pack** is the default acceptance topology for non-trivial implementation work in Pi.

Instead of letting one orchestrator or one reviewer do all acceptance work inline, Pi should attach multiple sibling review subagents to the **same task** and synthesize their findings.

## Why review packs exist

Review packs preserve the strongest parts of G Stack's review methodology while using Pi's task-first tmux-backed subagent system.

G Stack contributes:

- structured review methodology
- adversarial review methodology
- outside-voice cross-model review methodology
- specialist review concepts

Pi contributes:

- task-linked subagents
- model overrides per child
- inbox/attention supervision
- synthesis across sibling reviewers
- durable task state and history

## Default review pack

For non-trivial code changes, the default review pack is:

1. `principal-engineer` in `structured` mode
2. `principal-engineer` in `adversarial` mode
3. `principal-engineer` in `outside-voice` mode on a different model/provider

These are **sibling subagents on the same task**, not hidden nested work inside one reviewer.

## Optional review-pack members

Add these reviewers when scope requires them:

- `qa-lead` — browser-visible or user-flow acceptance work
- `design-lead` — UI/UX, visual polish, interaction quality, design regressions
- `cso` — auth, secrets, trust boundaries, supply chain, or internet-facing risk
- later: `devex-lead` — developer-facing APIs, SDKs, CLI, docs, onboarding
- later: `sre` — performance, canary, deploy verification, live environment checks

## Outside-voice review

Outside-voice review is a **mode of the same role**, not a separate agent family.

That means the coordinator should:

- keep the profile as `principal-engineer`
- change the delegated task/mode to `outside-voice`
- set a different `model` on `subagent_spawn`

This keeps role semantics stable while still getting cross-model coverage.

## Coordination rules

When routing a review pack:

1. move the task to `in_review`
2. spawn the required sibling reviewers against the same `taskId`
3. supervise through `subagent_attention`, `subagent_inbox`, `subagent_get`, and `task_attention`
4. synthesize overlap versus unique findings
5. if fixes are needed, message `engineer` and move back to `in_progress`
6. rerun only the necessary reviewers after fixes
7. move to `done` only after required reviewers pass or the user explicitly waives a gate

## Synthesis format

When multiple reviewers report back, the coordinator should summarize findings in this shape:

- **Agreed findings** — surfaced by multiple reviewers
- **Unique to structured review**
- **Unique to adversarial review**
- **Unique to outside-voice review**
- **Unique to QA / design / CSO**
- **Required fixes before `done`**
- **Validation gaps or waived risks**

Do not silently pick one reviewer and discard the rest.

## Browser acceptance

Browser acceptance in a review pack should go to `qa-lead` or `design-lead` and should prefer **G Stack Browser**.

Pi browser tools remain fallback-only during migration and troubleshooting.

## What not to do

Do not:

- self-accept non-trivial code in the coordinator
- hide cross-model review inside one opaque subagent
- invent a separate role just for outside-voice review
- use Pi browser tools as the default browser path for review-pack QA
