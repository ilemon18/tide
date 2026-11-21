# Tide — Agent Rules (mandatory)

1. This is the only always-active policy. Read [context](./.ai/context.md), then route touched paths with
   `pnpm docs:route <paths>` and load the returned docs. Cross-domain paths may require several.
2. Before paths are known, `pnpm docs:route --query "task"` recommends candidates; locate code and confirm
   scopes before loading. Linked docs are conditional references, not an instruction to load every link.
3. Load skills only on explicit triggers. Search targeted paths first; expand when needed and keep output focused.

## Run policy

Edit code, docs and tests; run checks, builds and tests only when explicitly requested in this conversation.
This includes `pnpm check`, `pnpm verify`, `pnpm i18n`, `pnpm i18n:scan`, `pnpm check:workflows`,
`pnpm typecheck`, `pnpm check:rust`, `pnpm check:docs`, `cargo check`, `cargo test`, `tsc`,
`pnpm build`, `pnpm app:build`, `pnpm app:build:win` and `pnpm tauri build`. No GUI/app smoke tests.
Write/update tests with implementation; leave execution to an explicit gate request or CI. Routing is read-only;
`pnpm docs:sync` only regenerates the doc index. Neither is a verification gate.

## User-triggered gates

- Verify / check / 校验 / 收尾: follow [verify](./.ai/skills/release-verify/SKILL.md) until clean;
  a partial run is incomplete. Verification never produces an artifact without a build request.
- Release check / 发布前检查 / 打包前检查: follow [release-check](./.ai/skills/release-check/SKILL.md).
  Never commit/tag/push/publish; installers require separate agreement. `pnpm release:check` needs this trigger.

## Maintenance

When paths, guards or behavior contracts change, update the owning routed doc and the guard map in
[checks](./.ai/checks.md). Keep one source per rule; cite code owners for changing numeric limits.
