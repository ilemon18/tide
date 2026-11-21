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
| `pnpm i18n:scan` | Hardcoded CJK UI literals; named IME/Unicode test-data files and other non-UI files are explicitly allowlisted |
| `pnpm check:workflows` | Workflow shell expansions followed by non-ASCII text after `$var` |
| `pnpm test:frontend` | Vitest/React Testing Library coverage for agent commands, persistence, providers, composer/IME behavior, terminal geometry, tree/watch races, diffs, updates and file links |
| `pnpm typecheck` | TypeScript types, missing runtime imports (including root React hooks), and complete typed locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm docs:route` | Select only area docs whose scope matches the supplied touched paths |
| `pnpm docs:sync` | Regenerate the route table in `context.md` from area-doc frontmatter; never hand-edit the generated region |
| `pnpm check:docs` | AI-doc tests, metadata, route precision/24KB bundle boundaries, skill metadata, plus paths, relative links and `pnpm` script names in docs and wrappers |

Agent command tests cover prompt tags, read-only guidance and the structured-question marker example.
Native provider approval, IME event order, incremental Markdown, bottom-only following and terminal
maximize/drag/restore remain manual review surfaces when explicitly requested. Automated tests do not
establish real-account compatibility or native visual appearance.

`pnpm check` is the frontend guard set and `pnpm verify` adds Rust and doc checks; outside CI only
[the verification skill](./skills/release-verify/SKILL.md) runs them.

## AI docs

The root policy also calls for targeted searches and focused command output; this is an agent workflow
guideline, not an automated guard.

Area docs declare a one-line `summary` and a block-list `scope` of repository-relative POSIX globs in
frontmatter. `pnpm docs:sync` rewrites only the marked route region in `context.md`; `pnpm check:docs` rejects
missing/empty metadata, invalid or unmatched globs, stale/hand-edited routing, and every area doc missing from
the generated table. Repeated hits are valid for cross-domain work, but routing fixtures must resolve exactly
their expected doc set.

Wrappers must have frontmatter whose `name` matches their directory and a non-empty `description`, and must
link to the canonical `.ai/skills/**/SKILL.md`; `CLAUDE.md` must import `AGENTS.md`. `.agents/skills` symlinks
`.claude/skills`, which the guard deduplicates by real path.

Hard limits are `context.md` <=2KB, `AGENTS.md` + `context.md` <=4KB, and each fixture bundle <=24KB. Other
docs warn above 6KB and `.ai` Markdown above 36KB. When over budget, delete duplication before splitting.
The bundle limit includes resident context and routed area docs; `scripts/ai-docs-lib.mjs` shares the
budget decision with the guard and boundary tests. Its separate 16KB metadata-prefix read cap is unchanged.
Path, guard or behavior-contract changes update their routed docs in the same change.

## Tests and CI

- Keep tests beside the owning module. The frontend suite covers agent/settings persistence and provider
  events, editor and diff behavior, tree/watch races, terminal geometry and update recovery; Rust tests cover
  protocol, watcher, settings, Git and path-containment invariants.
- Run targeted Rust or frontend tests through the verification skill when test code changes or when a change
  touches update, path containment, settings migration, Git commands or agent providers. Installer changes
  belong to the release-check surface.
- Never weaken or delete a guard or test to make a check pass. If a guard is wrong, change the script, this
  map and the owning skill in one edit.
- `.github/workflows/ci.yml` runs frontend guard/build jobs and Rust test jobs on supported platforms.
  `.github/workflows/release.yml` is tag-driven and does not replace the
  [release-check skill](./skills/release-check/SKILL.md).
