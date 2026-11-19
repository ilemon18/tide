# Tide — Agent Rules (mandatory)

## Loading

1. This file is the single always-active policy source.
2. Before implementation, read [`.ai/context.md`](./.ai/context.md), then load only the area docs routed
   by the paths you will touch. Cross-domain changes may load several related docs.
3. Load a skill only when its explicit trigger applies.

## While coding: code only

Change code, docs and tests only. Do not run checks, builds or tests unless the user explicitly requests
them in the current conversation:

- no `pnpm check`, `pnpm verify`, `pnpm i18n`, `pnpm i18n:scan`, `pnpm check:workflows`,
  `pnpm typecheck`, `pnpm check:rust`, or `pnpm check:docs`;
- no `pnpm release:check` unless the user explicitly asks for a release check;
- no `cargo check`, `cargo test`, `tsc`, or `pnpm build`;
- no `pnpm app:build`, `pnpm app:build:win`, `pnpm app:release`, or `pnpm tauri build`;
- no GUI or app smoke test.

An explicit request from the user is the only exception.

## Tests

Write or update tests with implementation, but do not execute them. Execution belongs to a
user-triggered verification skill or CI.

## User-triggered gates

- **Verify:** when the user asks to verify, check, 校验, 收尾 or run the final gate, follow
  [`.ai/skills/release-verify/SKILL.md`](./.ai/skills/release-verify/SKILL.md). It fixes failures and
  reruns until clean; a partial run is not completion.
- **Release check:** when the user asks for a release check / 发布前检查 / 打包前检查, follow
  [`.ai/skills/release-check/SKILL.md`](./.ai/skills/release-check/SKILL.md). It never commits, tags,
  pushes or publishes, and builds an installer only after separate user agreement.

`pnpm verify` is a check, not a build. Never produce an artifact unless the user asks for a build in the
current conversation.

## Coding invariants

Route UI copy through `t()` / `tp()` and add keys to all six catalogs; register new commands and keep
TypeScript/Rust DTOs aligned; update the routed `.ai` docs when a module, path, guard or behavior contract
changes. Apply the hard rules in [`.ai/context.md`](./.ai/context.md) and the guard map in
[`.ai/checks.md`](./.ai/checks.md).
