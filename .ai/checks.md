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

## Documentation contract

- Top-level `.ai` docs use one-line summary, nonempty scope globs and short English/Chinese keywords. Scope is
  repository-relative POSIX, each glob matches real files, and each doc scopes itself.
- Scope is authoritative; query is metadata-only advice. Queries never search bodies or drop path matches.
- `docs:sync` regenerates the context table; `check:docs` rejects stale tables, bad metadata, unmatched globs
  and missing paths/links/scripts. Repeated prose warns, never deletes.
- Hard limits: context ≤2.5KB, AGENTS+context ≤4.5KB, fixture bundle ≤24KB. Targets: bundle ≤16KB, doc ≤6KB,
  `.ai` ≤80KB. Token counts are rough bytes/4; metadata reads cap at 16KB.
- Skill wrappers need a directory-matching name, description and canonical skill link. CLAUDE.md imports
  AGENTS.md; preserve gate names, triggers and release behavior.

Release history and delivery: [release.md](./release.md).
