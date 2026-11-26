---
name: release-verify
description: Run Tide's full verification gate after the user explicitly asks to verify, check, 校验 or 收尾. Runs i18n checks, typecheck, Rust check, AI-doc links and targeted tests, fixing failures. Never build or launch the GUI.
---

# Tide verification gate

Use only when the user explicitly asks for verification. Inspect `git status --short` and `git diff --stat`
first, run checks one at a time (Rust and TypeScript are memory-heavy), and never build, package or launch the
GUI.

## Gate

Run from the repository root, individually, continuing after failures so one pass collects every error.
`pnpm verify` is the fail-fast shortcut for the same steps.

| # | Command | Fix when it fails |
|---|---|---|
| 1 | `pnpm i18n` | Key drift, placeholder mismatch, plural count or missing `error.<code>` — align six catalogs. |
| 2 | `pnpm i18n:scan` | Hardcoded CJK UI copy — use `t()`; allowlist only non-UI data and named fixtures in `scripts/i18n-scan.mjs`. |
| 3 | `pnpm check:workflows` | `$var` followed by non-ASCII — use `${var}`. |
| 4 | `pnpm typecheck` | Fix types/DTOs in `src/lib/ipc.ts` or Rust, not with `any`. |
| 5 | `pnpm check:rust` | Fix types/borrows; no `unwrap()` on user input. |
| 6 | `pnpm check:docs` | Fix metadata, fixtures, budgets, routes, links or script references in the owning doc. |

## Tests

After the six checks pass, run `cargo test --manifest-path src-tauri/Cargo.toml` when the full gate was
requested, test code changed, or the change touches update, paths, settings, Git commands or agent providers.
Run `sh scripts/test-install.sh` when installer files changed. Docs-only or frontend-only changes without test
edits leave tests to CI, and that decision is reported. Run `node --test scripts/dmg-contract.test.mjs` when
DMG configuration, artwork, guards or the release workflow changed; it does not build an installer or
automate Finder. Run `pnpm test:frontend` when frontend agent code or tests changed; CI also runs it.

## Fix and rerun

Fix root causes, rerun failed checks, then the full gate once more. Never weaken a guard or delete a test: if
a guard is wrong, change the script, [`.ai/checks.md`](../../checks.md) and this skill together. Report
failures, changes, final status and anything left to CI. Builds, installers, version bumps, signing and GUI
verification are out of scope; packaging follows [release-check](../release-check/SKILL.md).
