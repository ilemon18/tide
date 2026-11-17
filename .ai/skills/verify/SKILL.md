---
name: verify
description: Run Tide's full verification gate after the user explicitly asks to verify, check, 校验 or 收尾. Runs the i18n glossary, hardcoded-Chinese scan, workflow guard, TypeScript typecheck, Rust cargo check, AI-doc links, then targeted Rust tests, and fixes failures. Never use while implementing, and never build or launch the GUI.
---

# Tide verification gate

Use only when the user explicitly asks for verification. While coding, do not run any of these commands
(see [AGENTS.md](../../../AGENTS.md)).

## Before you start

- Know what changed: `git status --short` and `git diff --stat`.
- Do not build: no `pnpm app:build`, `app:build:win`, `app:release`, `pnpm tauri build`, and no debug
  bundle.
- Do not launch `pnpm app:dev` or click through the GUI unless the user separately asked for a GUI test.
- Run checks one at a time. Do not run them in parallel: the Rust and TypeScript passes are the memory
  hogs this skill exists to keep out of the coding loop.

## The gate, in order

Run from the repo root. Collect failures in one pass: run the six commands individually and continue
after each failure. `pnpm verify` is the fail-fast shortcut for steps 1–6; if it stops early, run the
remaining commands yourself.

| # | Command | Fix when it fails |
|---|---|---|
| 1 | `pnpm i18n` | Key-set drift, placeholder mismatch, plural-form count, or a missing `error.<code>` — add or align the six catalogs. |
| 2 | `pnpm i18n:scan` | Hardcoded CJK UI copy — route it through `t()`; only add a file to `ALLOW_FILES` in `scripts/i18n-scan.mjs` when the text is data or external tool output. |
| 3 | `pnpm check:workflows` | `$var` immediately followed by non-ASCII in a workflow — insert braces (`${var}`). |
| 4 | `pnpm typecheck` | `tsc --noEmit`; fix the type or the DTO in `src/lib/ipc.ts` / Rust, not with `any`. |
| 5 | `pnpm check:rust` | `cargo check`; fix types and borrows. Do not add `unwrap()` on user input. |
| 6 | `pnpm check:docs` | A path or `pnpm <script>` in `.ai/*.md` no longer exists — update the doc or the script name. |

## Tests

After the six static checks pass, run the tests that are in scope:

- Run `cargo test --manifest-path src-tauri/Cargo.toml` when the user asked for tests, when test code
  changed, or when the change touches `src-tauri/src/update.rs`, `src-tauri/src/paths.rs` or
  `src-tauri/src/commands/theme.rs`.
- If the user asks for the full gate, run it even when the change is frontend-only.
- For a frontend-only change with no test edits, leave tests to CI and say so in the final report.

Unit tests live in those three Rust files. `pnpm verify` deliberately does not build the test profile.

Do not run GUI tests, Playwright, or an app smoke test as part of this skill. They are a separate,
explicitly requested step.

## Fixing and rerunning

1. Fix every failure from one pass together where the fixes are independent. Prefer the root cause
   (catalog entry, type, path) over suppression.
2. Rerun the failed checks, then the whole gate once more. The gate is clean only when all six static
   checks exit 0 and any in-scope tests pass.
3. Do not weaken a guard or delete a test to get green. If a guard is genuinely wrong, change the guard
   and update [`.ai/checks.md`](../../checks.md) in the same edit.
4. Report concisely: what failed, what changed, the final status of each step, and any test step you
   skipped with the reason.

## Out of scope

Builds, installers, version bumps, release manifests, signing and GUI verification. Those need a
separate explicit request from the user.

---
**Last updated**: 2026-11-17
