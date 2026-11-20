# Checks, tests and release wiring

**Load when:** changing package scripts, a guard, test scope/location, CI, release workflows, update
manifest generation, or the verification/release skills.
**Code:** `package.json`, `scripts/`, `.github/workflows/`, `.ai/skills/`.

## Guard map

| Command | Protects |
|---|---|
| `pnpm i18n` | Locale key/placeholder/plural parity and error-code coverage |
| `pnpm i18n:scan` | Hardcoded CJK UI literals; genuine non-UI files are explicitly allowlisted |
| `pnpm check:workflows` | Workflow shell expansions followed by non-ASCII text after `$var` |
| `pnpm typecheck` | TypeScript types, including complete typed locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm check:docs` | AI-doc routing and skill metadata, plus paths, relative links and `pnpm` script names in `.ai/**/*.md`, root policy files and wrapper directories |

`pnpm check` is the frontend guard set and `pnpm verify` adds Rust and doc checks; outside CI only
[the verification skill](./skills/release-verify/SKILL.md) runs them.

## AI docs

The doc guard hard-fails when a top-level area doc is not routed from `context.md` or lacks its
`**Load when:**` / `**Code:**` headers. Wrappers must have frontmatter whose `name` matches their directory and
a non-empty `description`, and must link to the canonical `.ai/skills/**/SKILL.md`; `CLAUDE.md` must import
`AGENTS.md`. `.agents/skills` symlinks `.claude/skills`, which the guard deduplicates by real path.

Size limits are warnings: `context.md` warns above 4KB, other docs above 6KB and `.ai` above 36KB. When over
budget, delete duplicated prose before splitting a file. The root policy holds only universal rules, task
procedures live in skills, and path, guard or behavior-contract changes update their routed docs in the same
change.

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
