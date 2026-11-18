# Tide — Agent Rules (mandatory)

These rules apply to every session, every agent and every task in this repository. Start a session
with [`.ai/context.md`](./.ai/context.md), then read only the `.ai` doc for the area you touch.

## Default mode: code only — no checks

While implementing, change code, docs and test code only. Do **not** run verification commands,
builds or tests:

- no `pnpm check`, `pnpm verify`, `pnpm i18n`, `pnpm i18n:scan`, `pnpm check:workflows`,
  `pnpm typecheck`, `pnpm check:rust`, `pnpm check:docs`;
- no `pnpm release:check` unless the user explicitly asked for a release check;
- no `cargo check`, `cargo test`, `tsc`, `pnpm build`;
- no `pnpm app:build`, `pnpm app:build:win`, `pnpm app:release` or `pnpm tauri build` — debug bundles
  included;
- no GUI or app smoke test unless the user explicitly asks for one.

Each full pass is slow and memory-heavy; running it after every edit turns feature work into
whack-a-mole. CI runs the frontend and Rust guards in
[`.github/workflows/ci.yml`](./.github/workflows/ci.yml), and the verification skill covers the full
gate, so a missed check is still caught before release.

This is not a suggestion. Do not "just quickly" run a check, and do not run one because a change looks
risky. The only exception is an explicit request from the user in the current conversation.

## Tests

Write or update test code when the change needs it, but do not execute it while coding. Test execution
belongs to the final verification skill, or to CI.

## Verification is a separate, user-triggered step

When the user asks to verify, check, 校验, 收尾 or run the final gate, load and follow
[`.ai/skills/verify/SKILL.md`](./.ai/skills/verify/SKILL.md). It runs the checks in order, fixes what
fails, and reruns until clean.

Do not run the skill on your own initiative. Do not run only part of it and call the task done.

## Release preflight is a separate, user-triggered step

When the user asks for a release check / 发布前检查 / 打包前检查, load and follow
[.ai/skills/release-check/SKILL.md](./.ai/skills/release-check/SKILL.md). It runs the verification gate,
frontend build, Rust tests and release-specific checks, and fixes local files. It never commits, tags,
pushes or publishes, and it builds an installer only after the user agrees.

## Still apply while coding

Skipping execution does not relax the rules: route UI copy through `t()` / `tp()`, add new keys to all
six catalogs, register commands, update `.ai` docs when a module, path or check changes, and follow the
hard rules in [`.ai/context.md`](./.ai/context.md). See [`.ai/checks.md`](./.ai/checks.md) for what each
gate catches.

## Builds and packaging

Never produce an artifact unless the user asked for a build in this conversation. `pnpm verify` is a
check, not a build; it is allowed only through the verification skill. The release-check skill may
build an installer only after the user agrees in that conversation.

---
**Last updated**: 2026-11-17
