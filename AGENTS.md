# Tide — Agent Rules (mandatory)

1. This file is the only always-active policy source.
2. Before implementing, read [`.ai/context.md`](./.ai/context.md), then only the area docs routed by the
   paths you touch; cross-domain changes may load several.
3. Load a skill only when its explicit trigger applies.
4. Search targeted paths first, then read the relevant sections; expand the scope when needed.
   Keep command output focused while retaining the context required for correctness.

## Run policy

Limit edits to code, docs and tests. Do not run checks, builds or tests unless the user explicitly asks for
them in this conversation:

- no `pnpm check`, `pnpm verify`, `pnpm i18n`, `pnpm i18n:scan`, `pnpm check:workflows`, `pnpm typecheck`,
  `pnpm check:rust`, `pnpm check:docs`, and no `pnpm release:check` without a release-check request;
- no `cargo check`, `cargo test`, `tsc`, `pnpm build`, `pnpm app:build`, `pnpm app:build:win`,
  `pnpm tauri build`;
- no GUI or app smoke test.

Write or update tests with the implementation but never execute them; execution belongs to a user-triggered
skill or CI. `pnpm verify` is a check, not a build: never produce an artifact unless the user asks for a
build in this conversation.

## User-triggered gates

- **Verify** (verify / check / 校验 / 收尾): follow
  [`.ai/skills/release-verify/SKILL.md`](./.ai/skills/release-verify/SKILL.md) until clean; a partial run
  is not completion.
- **Release check** (发布前检查 / 打包前检查): follow
  [`.ai/skills/release-check/SKILL.md`](./.ai/skills/release-check/SKILL.md). It never commits, tags, pushes
  or publishes, and builds an installer only after separate agreement.

## Doc maintenance

When a module, path, guard or behavior contract changes, update the routed `.ai` doc and the guard map in
[`.ai/checks.md`](./.ai/checks.md). Apply the contracts in [`.ai/context.md`](./.ai/context.md).
