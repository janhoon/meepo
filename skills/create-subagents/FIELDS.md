# Profile fields

Loaded from `*.md` in the consumer Pi agents dir (`~/.pi/agent/agents`) or `profiles.dirs`. A file with no `name` or no `description` is skipped.

## Frontmatter

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Spawn key and `/subagent:<name>` suffix. Unique across merged dirs. |
| `description` | yes | One-line job. Shown in profile lists. |
| `tools` | no | Comma-separated child tools. Default: `read, bash, edit, write`. |
| `model` | no | Default model for children of this profile. Spawn may override. |
| `lease` | no | `exclusive` \| `review` \| `shared` \| `none`. Omit → `exclusive` (core). `shared`/`none` attach like `review`. |
| `role` | no | Hierarchy role key (edges/org), not a prompt. Omit → profile `name`. |
| `canSpawn` | no | `true`/`false`. Hint that this child may launch further children. |

Invalid `lease` or `canSpawn` fails profile load for that file.

## Closed tool allowlist

`read`, `bash`, `grep`, `ls`, `edit`, `write`, `web_search`, `code_search`, plus task/subagent tools (`task_*`, `subagent_*`).

Unknown names fail load unless listed in `profiles.extraTools` or `profiles.allowUnknownTools` is true.

`subagent_publish` is injected at spawn. Do not put it in `tools`.

## Lease

- `exclusive` — one owner on the task (implementers).
- `review` — several siblings may attach (review packs).
- `shared` / `none` — treated as review for task attachment.

## Role

`role` is only a hierarchy key. It does not create an org, an edge, or a Meepo-shipped persona. Set it when the install uses hierarchy policy and the key must match an edge chart.

## Load order

1. If `profiles.dirs` is empty → `~/.pi/agent/agents` only.
2. If set → those directories in order; later `name` wins.
3. Meepo never loads a package `agents/` folder unless a consumer points `profiles.dirs` at one.

## Runtime split

| Layer | Where | Contents |
|---|---|---|
| Profile body | this file | Standing job |
| `task.md` | run directory | This spawn's work + linked ticket |
| Runtime appendix | run directory | Publish / search / downward-message contract |

Keep those layers apart.
