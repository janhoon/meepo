# Review packs (consumer pattern, not Meepo-shipped agents)

A **review pack** is an optional **consumer** acceptance topology for non-trivial implementation work.

Meepo does **not** ship reviewer profiles, principal-engineer prompts, or a default review roster. This document describes a pattern you can implement with **your own** agent markdown under `~/.pi/agent/agents` (or `profiles.dirs`).

Instead of letting one orchestrator or one reviewer do all acceptance work inline, attach multiple sibling review subagents to the **same task** and synthesize their findings.

## Why review packs exist

Review packs use Meepo’s task-first process-hosted subagents to get multi-angle acceptance coverage when **you** provide the profiles:

- structured review methodology (your profile)
- adversarial review methodology (your profile or mode)
- outside-voice cross-model review (same profile name, different `model` on spawn)
- specialist review concepts (your security/design/QA profiles)

Meepo contributes only:

- task-linked subagents
- model overrides per child
- inbox/attention supervision
- synthesis surfaces across sibling reviewers
- durable task state and history

## Example consumer pack

If your install defines profiles such as `structured-reviewer`, `adversarial-reviewer`, and optional specialists, a typical pack is:

1. structured review profile on the implementation task
2. adversarial review profile on the same task
3. outside-voice pass: same review profile (or a dedicated one) with a different `model` / provider

These are **sibling subagents on the same task**, not hidden nested work inside one reviewer.

Add specialists only when **your** pack includes them (browser QA, design, security, etc.).

## Outside-voice review

Outside-voice review is usually a **mode or model override**, not a Meepo-built agent family.

Coordinator pattern:

- keep the consumer profile name you already use for review
- change the delegated task/mode text to outside-voice expectations
- set a different `model` on `subagent_spawn`

## Coordination rules

When routing a review pack with **your** profiles:

1. move the task to `in_review`
2. spawn the required sibling reviewers against the same `taskId` (profiles with `lease: review` avoid exclusive-owner conflicts)
3. supervise through `subagent_attention`, `subagent_inbox`, `subagent_get`, and task attention tools when enabled
4. synthesize overlap versus unique findings
5. if fixes are needed, message the implementer profile and move back to `in_progress`
6. rerun only the necessary reviewers after fixes
7. move to `done` only after required reviewers pass or the user explicitly waives a gate

## Synthesis format

When multiple reviewers report back, summarize:

- **Agreed findings** — surfaced by multiple reviewers
- **Unique findings** — per child / mode
- **Required fixes before `done`**
- **Validation gaps or waived risks**

Do not silently pick one reviewer and discard the rest.

## What not to do

Do not:

- assume Meepo provides `principal-engineer`, `qa-lead`, or similar names
- self-accept non-trivial code in the coordinator when your pack requires siblings
- hide cross-model review inside one opaque subagent without a reason
- invent Meepo core roles just to match an old doc name — put roles in the consumer agent pack
