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
| `pnpm check:docs` | Paths, relative links and `pnpm` script names in all `.ai/**/*.md`, `AGENTS.md` and `CLAUDE.md` |

`pnpm check` is the frontend guard set; `pnpm verify` adds Rust and doc checks. Outside CI, only
[the verification skill](./skills/release-verify/SKILL.md) runs them. The doc guard is intentionally soft:
`context.md` has the tightest limit, each other Markdown file has an 8KB warning, and the `.ai` Markdown
total has a separate target.

## Test surface

- Run targeted Rust tests through the verification skill when test code changed or the change touches
  update, path containment, settings migration, Git commands or agent providers. Installer changes belong
  to the release-check/installer test surface.
- Keep unit tests beside the owning Rust module unless the module explicitly groups integration tests.
- Never weaken or delete a guard or test to make a check pass. If a guard is wrong, change the script, this
  map and the owning skill in one edit.

## CI and release

- `.github/workflows/ci.yml` runs frontend guard/build jobs and Rust test jobs on supported platforms.
  Keep platform prerequisites and generated-icon assertions in workflow configuration.
- `.github/workflows/release.yml` is tag-driven: set the version, run frontend guards, build macOS and
  Windows bundles, generate the update manifest and upload installer assets. It does not replace
  [the release-check skill](./skills/release-check/SKILL.md).
