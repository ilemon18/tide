---
summary: Scripts, guards, tests, CI, release and verification
scope:
  - package.json
  - pnpm-lock.yaml
  - scripts/**
  - .github/workflows/**
  - .ai/checks.md
  - .ai/context.md
  - .ai/skills/**
  - AGENTS.md
  - CLAUDE.md
  - install.sh
---
# Checks, tests and release wiring

## Guard map

| Command | Protects |
|---|---|
| `pnpm i18n` | Locale key/placeholder/plural parity and error-code coverage |
| `pnpm i18n:scan` | Hardcoded CJK UI literals; genuine non-UI files are explicitly allowlisted |
| `pnpm check:workflows` | Workflow shell expansions followed by non-ASCII text after `$var` |
| `pnpm typecheck` | TypeScript types, including complete typed locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm docs:route` | Select only area docs whose scope matches the supplied touched paths |
| `pnpm docs:sync` | Regenerate the route table in `context.md` from area-doc frontmatter; never hand-edit the generated region |
| `pnpm check:docs` | AI-doc tests, metadata, route precision/budgets, skill metadata, plus paths, relative links and `pnpm` script names in docs and wrappers |

`pnpm check` is the frontend guard set and `pnpm verify` adds Rust and doc checks; outside CI only
[the verification skill](./skills/release-verify/SKILL.md) runs them.

## AI docs

Area docs declare a one-line `summary` and a block-list `scope` of repository-relative POSIX globs in
frontmatter. `pnpm docs:sync` rewrites only the marked route region in `context.md`; `pnpm check:docs` rejects
missing/empty metadata, invalid or unmatched globs, stale/hand-edited routing, and every area doc missing from
the generated table. Repeated hits are valid for cross-domain work, but routing fixtures must resolve exactly
their expected doc set.

Wrappers must have frontmatter whose `name` matches their directory and a non-empty `description`, and must
link to the canonical `.ai/skills/**/SKILL.md`; `CLAUDE.md` must import `AGENTS.md`. `.agents/skills` symlinks
`.claude/skills`, which the guard deduplicates by real path.

Hard limits are `context.md` <=2KB, `AGENTS.md` + `context.md` <=4KB, and each fixture bundle <=16KB. Other
docs warn above 6KB and `.ai` Markdown above 36KB. When over budget, delete duplication before splitting.
Path, guard or behavior-contract changes update their routed docs in the same change.

## Tests and CI

- Run targeted Rust tests through the verification skill when test code changed, or when the change touches
  update, path containment, settings migration, Git commands or agent providers; installer changes belong to
  the release-check surface. Keep unit tests beside the owning Rust module.
- Update tests must keep startup/manual cache freshness unchanged, prove forced checks bypass a fresh cache
  and forbid cached fallback, and assert forced lookup requests carry `Cache-Control: no-cache`.
- Never weaken or delete a guard or test to make a check pass. If a guard is wrong, change the script, this
  map and the owning skill in one edit.
- `.github/workflows/ci.yml` runs frontend guard/build jobs and Rust test jobs on supported platforms, with
  platform prerequisites and generated-icon assertions kept in workflow configuration.
  `.github/workflows/release.yml` is tag-driven: set the version, run frontend guards, build macOS and Windows
  bundles, generate the update manifest and upload installer assets. It does not replace
  [the release-check skill](./skills/release-check/SKILL.md).
- An omitted release-check version defaults to the highest local semver `v*` tag plus one patch (`v1.2.3` →
  `1.2.4`, or `0.0.1` with no tags); an explicit version always overrides it. The static check remains
  network-free.
