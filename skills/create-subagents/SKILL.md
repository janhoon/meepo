---
name: create-subagents
description: Author a Meepo child profile. Use when adding a new subagent, writing agent markdown, or spawn fails because no consumer profile exists.
---

# Create Subagents

Use this skill to **author a consumer profile**. Meepo does not ship agents. A profile is markdown Meepo can resolve by `name` and launch as a process-hosted child.

Spawn, messaging, and supervision stay in `dispatch-subagents`, `communicate-subagents`, and `supervise-subagents`.

## Rules

- Author **standing behavior**. Put run-specific work in the spawn `task` / ticket, not in the profile.
- Write **one job per profile**. Split jobs instead of growing a persona catalog.
- Set `lease` in frontmatter. Do not rely on full-preset name-compat.
- Name the file after the frontmatter `name` (`diff-reviewer.md` ↔ `name: diff-reviewer`).
- Restart Pi after adding or renaming a profile so `/subagent:<name>` and spawn resolution see it.

## Flow

1. **Name the job** in one line (what this child always does).
   Done when the line is a standing job, not a ticket.

2. **Inventory** existing profiles before writing a new one.
   Read `~/.pi/agent/agents/*.md` and any extra dirs from consumer `profiles.dirs`.
   Done when you have the live name list and either reuse a name or pick a new unique `name`.

3. **Choose the destination.**
   - Operator-global: `~/.pi/agent/agents/<name>.md` (default load path).
   - Project or package pack: a directory listed in `profiles.dirs` (later dirs shadow earlier ones by `name`).
   Done when exactly one write path is chosen. Create the directory if it is missing.

4. **Write the markdown.** Copy [TEMPLATE.md](TEMPLATE.md), then fill frontmatter and body.
   Done when the file exists on disk with `name`, `description`, and a body.

5. **Check the contract** in [FIELDS.md](FIELDS.md).
   Done when `name` + `description` are non-empty, `tools` are on the allowlist (or `profiles.extraTools` / `allowUnknownTools`), and any `lease` / `canSpawn` values are valid.

6. **Hand off to spawn.**
   Done when the operator knows the spawn name, that Pi must be restarted to refresh `/subagent:<name>`, and that `subagent_spawn` / `task_dispatch_ready` must use this exact `name`.

If spawn still says `Available profiles: (none)`, the file is in the wrong directory, missing `name`/`description`, or Pi has not been restarted.

## Body

The body is the child's system prompt. Meepo appends a runtime appendix at spawn (`subagent_publish`, search policy, downward-message handling). Write only what this job adds.

- Steps with completion criteria beat adjectives.
- Exact paths, output shape, and what to publish when blocked.
- Tools must match the job: a reviewer that cannot edit should not list `edit`/`write`.

Keep the body short enough that a child can finish the job without rereading a manifesto.

## After authoring

- Exclusive implementer: `lease: exclusive`, attach one owner per task.
- Sibling reviewers on one task: `lease: review`. Pattern: `docs/REVIEW_PACKS.md`.
- A child that may spawn further children: `canSpawn: true` plus spawn tools (`subagent_spawn`, …).
- Set `recommendedProfile` on tickets to this `name` so `task_dispatch_ready` can launch it.
