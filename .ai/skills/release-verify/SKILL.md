---
name: release-verify
description: Run Tide's full verification gate after the user explicitly asks to verify, check, 校验 or 收尾. Runs the i18n glossary, hardcoded-Chinese scan, workflow guard, TypeScript typecheck, Rust cargo check, AI-doc links, then targeted Rust tests, and fixes failures. Never use while implementing, and never build or launch the GUI.
---

# Tide verification gate

Use only when the user explicitly asks for verification. Inspect `git status --short` and `git diff --stat`
first, run checks one at a time (the Rust and TypeScript passes are memory-heavy), and never build, package,
launch the GUI or run Playwright/smoke tests.

## Gate

Run from the repository root, individually, continuing after failures so one pass collects every error.
`pnpm verify` is the fail-fast shortcut for the same steps.

| # | Command | Fix when it fails |
|---|---|---|
| 1 | `pnpm i18n` | Key-set drift, placeholder mismatch, plural-form count, or a missing `error.<code>` — align the six catalogs. |
| 2 | `pnpm i18n:scan` | Hardcoded CJK UI copy — use `t()`; explicitly allowlist only non-UI data/external output, including named IME/Unicode test fixtures, in `scripts/i18n-scan.mjs`. |
| 3 | `pnpm check:workflows` | `$var` followed by non-ASCII — insert braces (`${var}`). |
| 4 | `pnpm typecheck` | Fix the type or DTO in `src/lib/ipc.ts` / Rust, not with `any`. |
| 5 | `pnpm check:rust` | Fix types and borrows; no `unwrap()` on user input. |
| 6 | `pnpm check:docs` | Update the stale path, link or `pnpm <script>` in the AI docs. |

## Tests

After the six static checks pass, run `cargo test --manifest-path src-tauri/Cargo.toml` when the user asked
for the full gate, test code changed, or the change touches update, path containment, settings migration, Git
commands or agent providers; run `sh scripts/test-install.sh` when installer files changed. Docs-only or
frontend-only changes with no test edits leave tests to CI, and that decision is reported.

Run `pnpm test:frontend` when frontend agent code or its tests changed; CI also runs this suite.

## Fix and rerun

Fix independent failures at the root cause rather than suppressing checks, then rerun the failed checks and
the full gate once more. Never weaken a guard or delete a test to get green: if a guard is wrong, change the
script, [`.ai/checks.md`](../../checks.md) and this skill together. Report what failed, what changed, each
final status and any step left to CI. Builds, installers, version bumps, signing and GUI verification are out
of scope — for packaging use [the release-check skill](../release-check/SKILL.md).
