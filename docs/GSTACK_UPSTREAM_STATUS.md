# G Stack upstream status

This file records the upstream G Stack baseline that `meepo` has reviewed for its integration layer.

## Current reviewed baseline

- Upstream repo: `https://github.com/garrytan/gstack`
- Last reviewed upstream SHA: `656df0e37e67f8e6256d9e14d664a10b6db9c413`
- Reviewed on: `2026-04-22`
- Review basis: upstream repo clone inspected during Pi integration planning and role-mapping work

## What this status means

This SHA is the **last reviewed baseline**, not a guarantee that every machine using Pi has that exact checkout installed.

When Pi roles rely on G Stack:

1. resolve `GSTACK_ROOT`
2. capture the installed SHA with:

```bash
git -C "$GSTACK_ROOT" rev-parse HEAD
```

3. compare it to the reviewed baseline above

If the installed SHA differs, treat it as **unverified drift** until smoke validation is complete.

## Refresh procedure

When adopting a newer upstream revision:

1. update the local G Stack checkout
2. inspect any affected upstream docs/skills used by Pi wrappers
3. smoke-check the impacted Pi roles/prompts/review-pack behavior
4. update this file with the new reviewed SHA and date
5. note any migration or compatibility implications in the relevant task/docs

## First-wave integration scope

The first-wave Pi integration depends most directly on these upstream artifacts:

- `README.md`
- `BROWSER.md`
- `browse/SKILL.md`
- `review/SKILL.md`
- `codex/SKILL.md`
- `qa/SKILL.md`
- `qa-only/SKILL.md`
- `plan-ceo-review/SKILL.md`
- `plan-eng-review/SKILL.md`
- `plan-design-review/SKILL.md`
- `plan-devex-review/SKILL.md`
- `autoplan/SKILL.md`
- `cso/SKILL.md`

Changes to those files should trigger renewed review of the corresponding Pi wrappers or orchestration prompts.
