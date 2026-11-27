---
summary: Guards and documentation contracts
scope:
  - .ai/checks.md
  - package.json
  - pnpm-lock.yaml
  - .ai/context.md
  - .ai/skills/**
  - AGENTS.md
  - CLAUDE.md
  - install.sh
  - assets/dmg-background.png
  - README.md
  - README.zh-CN.md
  - .github/workflows/ci.yml
  - scripts/ai-docs-lib.mjs
  - scripts/ai-docs.test.mjs
  - scripts/check-ai-docs.mjs
  - scripts/check-workflows.mjs
  - scripts/i18n-check.mjs
  - scripts/i18n-scan.mjs
  - scripts/run-tauri.mjs
  - scripts/run-tauri.test.mjs
  - scripts/dmg-contract.mjs
  - scripts/dmg-contract.test.mjs
  - scripts/make-dmg-background.mjs
  - scripts/build-file-icons.mjs
  - scripts/icon-themes/**
  - scripts/collect-app.mjs
  - scripts/make-icon.mjs
  - scripts/set-version.mjs
  - scripts/test-install.sh
  - scripts/archive-release-history.test.mjs
  - scripts/route-ai-docs.mjs
  - scripts/sync-ai-docs.mjs
keywords:
  - docs
  - documentation
  - routing
  - guard
  - ci
  - verify
  - 文档
  - 路由
  - 校验
  - 检查
---
# Checks and documentation

## Guard map

| Command | Protects |
|---|---|
| `node --test scripts/fonts.test.mjs` | Font integrity, source/derived checksums and licenses |
| `node --test scripts/run-tauri.test.mjs` | Dev version from reachable semantic tags, package fallback and branch isolation |
| `node --test scripts/release-git-state.test.mjs` | Release preflight tolerates local tracking-ref drift without fetch/push |
| `node --test scripts/release-history.test.mjs scripts/archive-release-history.test.mjs` | Tag ranges, summary assignment, non-forced archival and concurrent-summary preservation |
| `node --test scripts/dmg-contract.test.mjs` | DMG artwork/layout, dimensions and macOS Finder opt-in before packaging |
| `pnpm release:check` | Local Git/version, workflows, bundle and update-manifest contracts |
| `pnpm i18n` | Six-locale keys/placeholders/plurals and emitted error coverage |
| `pnpm i18n:scan` | CJK UI literals outside allowlists |
| `pnpm check:workflows` | Non-ASCII after shell variable expansion |
| `pnpm test:frontend` | Frontend behavior; area tests define coverage |
| `pnpm typecheck` | Types, missing runtime imports/hooks and complete locale records |
| `pnpm check:rust` | Rust types/borrows without linking |
| `pnpm docs:route` | Exact path matches, --explain reasons and --query candidates |
| `pnpm docs:sync` | Deterministic route table; only the marked region is written |
| `pnpm check:docs` | Doc tests, metadata, fixtures, budgets, index, wrappers and links |

`pnpm check` runs frontend guards; `pnpm verify` adds Rust and doc checks. Native accounts/IME/layout/scrolling/caption cursors require manual verification.

## Feature guards

- `GitPanel.test.tsx`: range selection, staging checkboxes, whole-group operations, busy/conflict guards and
  disabled multi-file path copies. `GitDialogs`/`GitSettings` tests cover selected stash, window identity and
  changed-only project preferences; `GitBackground` tests cover scheduling and teardown.
- `GitCommitHistory.test.tsx`/`commitMessages.test.ts` cover stable popup selection, common-message sharing,
  full-message deduplication, ordering and limits. Native `git_history` tests guard compact atomic storage.
- Native `git.rs`/`git_ui`/`git_config` tests guard branch protections, leases, inherited identity/config
  and unrelated-record preservation. `stateCache.test.ts` protects undo and worktree edit locks.
- `rainbowBrackets.test.ts` bounds syntax scans; `blame.test.ts` guards idle cancellation. Font/settings tests
  guard weights, oblique face integrity, migration, export and cross-window keys; limits retain code owners.

## Documentation contract

- Top-level `.ai` docs need a one-line summary, nonempty scopes and short bilingual keywords. Scope is
  repository-relative POSIX, each glob matches real files, and each doc scopes itself.
- Scopes govern routing; queries advise from metadata, retaining path matches.
- `docs:sync` regenerates the context table; `check:docs` rejects stale tables, bad metadata, unmatched globs
  and missing paths/links/scripts. Repeated prose warns, never deletes.
- Hard limits: context ≤2.5KB, AGENTS+context ≤4.5KB, fixture bundle ≤24KB. Targets: bundle ≤16KB, doc ≤6KB,
  `.ai` ≤80KB. Token counts are rough bytes/4; metadata reads cap at 16KB.
- Skill wrappers need a directory-matching name, description and canonical skill link. CLAUDE.md imports
  AGENTS.md; preserve gate names, triggers and release behavior.

Release history and delivery: [release.md](./release.md).
