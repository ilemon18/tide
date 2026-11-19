---
name: release-verify
description: Run Tide's full verification gate after the user explicitly asks to verify, check, 校验 or 收尾. Runs the i18n glossary, hardcoded-Chinese scan, workflow guard, TypeScript typecheck, Rust cargo check, AI-doc links, then targeted Rust tests, and fixes failures. Never use while implementing, and never build or launch the GUI.
---

# Tide verification gate

Use only when the user explicitly asks for verification.

## Before you start

- Inspect `git status --short` and `git diff --stat`.
- Do not build, package or launch the GUI.
- Run checks one at a time. The Rust and TypeScript passes are memory-heavy.

## Gate

Run from the repository root. Run the six commands individually and continue after failures so one pass
collects every error. `pnpm verify` is the fail-fast shortcut for these steps.

| # | Command | Fix when it fails |
|---|---|---|
| 1 | `pnpm i18n` | Key-set drift, placeholder mismatch, plural-form count, or a missing `error.<code>` — align the six catalogs. |
| 2 | `pnpm i18n:scan` | Hardcoded CJK UI copy — use `t()`; allowlist a file in `scripts/i18n-scan.mjs` only for data or external tool output. |
| 3 | `pnpm check:workflows` | `$var` followed by non-ASCII — insert braces (`${var}`). |
| 4 | `pnpm typecheck` | Fix the type or DTO in `src/lib/ipc.ts` / Rust, not with `any`. |
| 5 | `pnpm check:rust` | Fix types and borrows. Do not add `unwrap()` on user input. |
| 6 | `pnpm check:docs` | Update the stale path, link or `pnpm <script>` in the AI docs. |

## Tests

After the six static checks pass:

- Run `cargo test --manifest-path src-tauri/Cargo.toml` when the user asks for the full gate, test code
  changed, or the change touches update, path containment, settings migration, Git commands or agent
  providers.
- Run `sh scripts/test-install.sh` when installer files changed; stubs prevent network and real installs.
- For docs-only or frontend-only changes with no test edits, leave tests to CI and report that decision.

Do not run GUI tests, Playwright or app smoke tests as part of this skill.

## Fix and rerun

1. Fix independent failures together at the root cause rather than suppressing checks.
2. Rerun failed checks, then the full gate once more.
3. Never weaken a guard or delete a test to get green. If a guard is wrong, change the script,
   [`.ai/checks.md`](../../checks.md) and this skill together.
4. Report what failed, what changed, each final status and any test step left to CI.

## Out of scope

Builds, installers, version bumps, release manifests, signing and GUI verification. For packaging and
publishing, use [the release-check skill](../release-check/SKILL.md).
