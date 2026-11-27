---
summary: Guards, docs, CI and release
scope:
  - .ai/checks.md
  - CHANGELOG.md
  - changes/**
  - changes/releases.json
  - package.json
  - pnpm-lock.yaml
  - scripts/**
  - .github/workflows/**
  - .ai/context.md
  - .ai/skills/**
  - AGENTS.md
  - CLAUDE.md
  - install.sh
  - assets/dmg-background.png
  - README.md
  - README.zh-CN.md
keywords:
  - docs
  - documentation
  - routing
  - guard
  - ci
  - release
  - verify
  - 文档
  - 路由
  - 校验
  - 检查
  - 发布
---
# Checks, docs and release

## Ownership

Package scripts define commands; `scripts/ai-docs-lib.mjs` owns metadata, routing and budgets; CI runs guards.
Gate procedures live in `.ai/skills` and run only when the user triggers them (AGENTS.md).
`.ai/skills/git-commit-message` is the only skill that writes Git state: subject-only commit, never push.

## Guard map

| Command | Protects |
|---|---|
| `node --test scripts/run-tauri.test.mjs` | Dev version from reachable semantic tags, package fallback and branch isolation |
| `node --test scripts/release-git-state.test.mjs` | Release preflight tolerates local tracking-ref drift without fetch/push |
| `node --test scripts/release-history.test.mjs scripts/archive-release-history.test.mjs` | Tag ranges, summary assignment, non-forced archival and concurrent-summary preservation |
| `node --test scripts/dmg-contract.test.mjs` | DMG artwork/layout, dimensions and macOS Finder opt-in before packaging |
| `pnpm release:check` | Local Git/version, workflows, bundle and update-manifest contracts |
| `pnpm i18n` | Six-locale keys/placeholders/plurals and emitted error coverage |
| `pnpm i18n:scan` | Hardcoded CJK UI literals outside explicit allowlists |
| `pnpm check:workflows` | Non-ASCII after shell variable expansion |
| `pnpm test:frontend` | Frontend behavior owned by the area docs; test files are the inventory |
| `pnpm typecheck` | Types, missing runtime imports/hooks and complete locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm docs:route` | Exact path matches, --explain reasons and --query candidates |
| `pnpm docs:sync` | Deterministic route table; only the marked region is written |
| `pnpm check:docs` | Doc tests, metadata, fixtures, budgets, index, wrappers and links |

`pnpm check` runs frontend guards; `pnpm verify` adds Rust and doc checks. Native account compatibility,
IME ordering and native layout/scrolling/caption cursors need explicit manual verification;
automated tests do not prove them.

## Release history

`changes/unreleased.md` owns the current human-written change summary; update it with feature/fix work.
`scripts/release-history.mjs` backfills from v0.0.10 using actual tag ranges and commit SHAs, retains curated notes,
fetches published descriptions with the workflow token, preserves records if tags disappear, and assigns
the summary to the requested version.
`changes/releases.json` and `CHANGELOG.md` are generated project records; no missing tags are invented.
The version job generates one artifact for both builds and publication. `make-latest-json` carries its notes
to existing apps; the complete history remains an archive asset. Publication attaches the history and changelog; `scripts/archive-release-history.cjs`
archives only these records to the default branch via a non-forced Git update, retrying contention. It consumes
only the exact published summary, preserving concurrent new entries. Installers/version stamps are separate.

Go Live lifetimes and HTTP isolation are owned by [live-preview.md](./live-preview.md); Alt gesture tests
are in `src/editor/altSelection.test.ts`; blame geometry and terminal drag teardown have area tests.
`GoLive.test.tsx` covers unavailable cursor/hint semantics; shared cursor policy lives in context.
`window_cursor.rs` tests native subclass reuse/instance-size safety without creating GUI windows.
`ShortcutSettings.test.tsx` covers searchable mouse-gesture help without modifying key bindings.
`FileTree.test.tsx` keeps upper-position tab reveals compatible with paged/settled centered reveals.
`Welcome.test.tsx` covers recent-project order/limit, switching delegation and context actions.
Configuration compatibility/scheduling contracts: [configuration.md](./configuration.md).
`pnpm tauri dev` uses `run-tauri.mjs` to stamp the highest reachable semantic tag via `set-version.mjs`,
falling back to package metadata. UI version comes from native `app_version`; release builds retain tag stamps.

## Documentation contract

- Top-level `.ai` docs use one-line summary, nonempty scope globs and short English/Chinese keywords. Scope is
  repository-relative POSIX, each glob matches real files, and each doc scopes itself.
- Scope is authoritative; query is metadata-only advice. Queries never search bodies or drop path matches.
- `docs:sync` regenerates the context table; `check:docs` rejects stale tables, bad metadata, unmatched globs
  and missing paths/links/scripts. Repeated prose warns, never deletes.
- Hard limits: context ≤2KB, AGENTS+context ≤4KB, fixture bundle ≤24KB. Targets: bundle ≤16KB, doc ≤6KB,
  `.ai` ≤36KB. Token counts are rough bytes/4; metadata reads cap at 16KB.
- Skill wrappers need a directory-matching name, description and canonical skill link. CLAUDE.md imports
  AGENTS.md; preserve gate names, triggers and release behavior.

## Change map

DMG layout is owned by `src-tauri/tauri.conf.json`; regenerate artwork with
`node scripts/make-dmg-background.mjs` after changing dimensions or icon positions. Shared layout checks live
in `scripts/dmg-contract.mjs`. Resource ceilings stay in `src/lib/memoryBudget.ts` and
`src-tauri/src/commands/tasks.rs`.

Keep metadata parser, route/sync, guard and tests aligned; scope/index changes also update fixtures and the
regenerated context. Never weaken or delete a guard to pass. CI runs frontend guards/tests/build and Rust
tests; the tag-driven release workflow does not replace
[release-check](./skills/release-check/SKILL.md).
