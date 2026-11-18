# Checks & packaging

**Policy: do not run any check while coding.** Write code, docs and test code; do not run i18n,
workflow, typecheck, Rust, doc or test guards after edits. Verification is a separate step that the user
triggers:

> User asks to verify / check / 校验 / 收尾 → load and follow
> [`.ai/skills/verify/SKILL.md`](./skills/verify/SKILL.md).
> User asks for a release check / 发布前检查 / 打包前检查 → load and follow
> [the release-check skill](./skills/release-check/SKILL.md).

The verify skill runs the gate in order, fixes failures and reruns. Running the guards after every edit is
slow and memory-heavy, and a failing glossary entry is never what the feature is about. CI runs the
frontend and Rust guards; the skill adds `check:docs` and the full sequence.

One command gates the code part of a release:

```bash
pnpm verify
```

`verify` = `pnpm check && pnpm check:rust && pnpm check:docs`. It is deliberately **not** wired into
`app:build` / `app:build:win` / `app:release` or into `beforeBuildCommand`: temporary debug bundles
should not wait for a Rust type check, and CI already runs the same guards.

**Never build on your own initiative.** Packaging is a user decision: do not run `pnpm app:build`,
`pnpm app:build:win`, `pnpm app:release` or `pnpm tauri build` — **debug bundles included** — unless the
user asked for a build in this conversation. `pnpm verify` is a check, not a build: the verification
skill may run it, and it never produces an artifact.

## What `verify` runs

| Step | Script | What it catches |
|---|---|---|
| 1 | `pnpm i18n` | glossary drift: key sets differ between the 6 locales, `{placeholder}` mismatch, wrong plural-form count, `error.*` text missing for a code Rust emits |
| 2 | `pnpm i18n:scan` | Chinese (CJK) hardcoded in a UI string literal instead of `t()` |
| 3 | `pnpm check:workflows` | `$var` in a workflow immediately followed by a non-ASCII character (bash counts the multibyte bytes as part of the name and `set -u` fails on the runner) |
| 4 | `pnpm typecheck` | `tsc --noEmit` |
| 5 | `pnpm check:rust` | `cargo check` (types / borrows only — no linking, no test build) |
| 6 | `pnpm check:docs` | a path or a `pnpm <script>` written in `.ai/*.md` that no longer exists |

`pnpm check` alone is steps 1–4: that is what CI runs on a PR (fast feedback), so it stays
frontend-only. Steps 5–6 ride along only in `verify`.

`pnpm verify` stops at the first failure. To collect several failures in one pass, run the six commands
individually and continue after each; the skill describes the same flow.

## Release preflight

When the user asks for a release check / 发布前检查 / 打包前检查, load and follow
[the release-check skill](./skills/release-check/SKILL.md). It is separate from verify because it
also covers version/tag state, the Tauri bundle, both workflows and the update manifest.

1. `pnpm release:check <version>` - local git, version, Tauri, workflow and manifest checks. No network.
2. `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm build`, `cargo test --manifest-path src-tauri/Cargo.toml`.
3. An optional local release bundle after the user agrees: macOS universal dmg or Windows NSIS exe.

The skill fixes local files, but it never commits, tags, pushes or publishes. It checks local tags and
the workflow files only; remote tag/release/CI state still needs a manual check after git fetch --tags.

## Typical failures

- **`[zh-CN] missing key common.x`** — you added the key to `src/i18n/messages/en.ts` only. Add it to
  the other five catalogs (details in [i18n.md](./i18n.md)) or the type check fails too.
- **`plural form count mismatch`** — English uses `one | other` (2 forms), so zh-CN / zh-TW / ja / ko
  must use exactly 1 form and es exactly 2.
- **`error code error.io.notOpen sent from Rust has no glossary text`** — a new `AppError::c("...")`
  needs `'error.<code>'` in every catalog.
- **`Found N place(s) that may be hardcoded Chinese`** — route the copy through `t()`. If the string is
  genuinely not UI copy (external tool output, data), add the file to `ALLOW_FILES` in
  `scripts/i18n-scan.mjs` instead of translating it.
- **`pnpm <x> is not a script in package.json`** — the doc told an agent to run something that no
  longer exists; fix the doc or the script name.
- **`<path> does not exist`** — a module moved; update the doc. Paths written in backticks and markdown
  links are checked, `{a,b}` brace groups are expanded, globs are ignored.

## Tests

Write test code during implementation, but do not run it. The verification skill runs
`cargo test --manifest-path src-tauri/Cargo.toml` when the user asked for tests, test code changed, or
the change touches `src-tauri/src/update.rs`, `paths.rs` or `commands/theme.rs`. CI always runs it.
Unit tests also cover Git commands and agent providers, skill discovery and persistence. A test build
uses the dev profile, which the release build does not reuse, which is why `verify` leaves it out.

The release-check skill runs it unconditionally, because it mirrors the tag-time CI job.

## CI

- `.github/workflows/ci.yml` — on every PR and tag: frontend job runs `pnpm check` + `pnpm build` on
  Ubuntu and Windows; Rust job runs `cargo test` on both, after Linux WebKitGTK deps. Windows also
  asserts `src-tauri/icons/icon.ico` exists, because tauri-build hard-errors without it.
- `.github/workflows/release.yml` — on a `vX.Y.Z` tag: resolves the version, runs
  `scripts/set-version.mjs`, then `pnpm check`, then `tauri build` for the universal macOS dmg and the
  Windows NSIS exe, then `scripts/make-latest-json.mjs` writes the update manifest.

Locally: run the verification skill when the user asks; it wraps `pnpm verify` (or the same steps) and
adds tests when in scope. For a release, run the release-check skill first; it adds version, workflow,
bundle and manifest checks around the same gate. `pnpm app:dev` is only for a requested UI check.

---
**Last updated**: 2026-11-18
