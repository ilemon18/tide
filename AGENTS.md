# Tide — Agent Rules (mandatory)

1. Only this policy is always active. Read [context](./.ai/context.md), route touched paths with
   `pnpm docs:route <paths>` and load all matching domains.
2. Use `pnpm docs:route --query "task"` for candidates before paths are known; locate code and confirm scopes.
   Linked docs are conditional: load only applicable ones.
3. Load skills on explicit triggers or required UI copy checks. Search targeted paths first; expand as needed.
4. For user-visible copy, follow the necessity check in [polish-ui-copy](./.ai/skills/polish-ui-copy/SKILL.md);
   keep actions, decisions, recovery and risk, and remove repetition and decoration.

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

## Development standards

- Minimize memory; explain and confirm exceptions with the developer.
- Avoid hardcoded choices; prefer configuration. Ask the developer about unresolved decisions.
- After UI edits follow [polish-ui-copy](./.agents/skills/polish-ui-copy/SKILL.md).
- Before commit/release require changelog; backfill missing notes from relevant history.
