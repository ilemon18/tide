# Tide — AI Context

`AGENTS.md` is authoritative. Use `pnpm docs:route <paths>` for touched paths; load only returned docs.
Skills need an explicit trigger.

<!-- BEGIN GENERATED ROUTES -->
| Doc | Summary |
|---|---|
| [agent.md](./agent.md) | Agent chat, providers, composer, planning and persistence |
| [checks.md](./checks.md) | Scripts, guards, tests, CI, release and verification |
| [editor.md](./editor.md) | Editor tabs, files, Markdown preview and CodeMirror |
| [file-tree.md](./file-tree.md) | Workspace tree, folders, refresh and watcher sync |
| [git.md](./git.md) | Git actions, diff views, conflicts and bulk discard |
| [i18n.md](./i18n.md) | UI copy, locales, native strings and backend errors |
| [runtime.md](./runtime.md) | App shell, windows, memory, settings and updates |
| [terminal.md](./terminal.md) | PTY lifecycle, terminal output, keyboard and IME |
<!-- END GENERATED ROUTES -->

## Cross-domain contracts

- **IPC protocol:** UI/stores call `api.*` in `src/lib/ipc.ts`, never `invoke`. Camel-case Rust DTOs match
  TypeScript one-to-one. Event names/payloads are one protocol: update emitters, listeners and `ipc.ts`.
- **Workspace paths:** file commands take `(root, rel)`, never a frontend absolute path. Authorize the root,
  resolve inside it, canonicalize and prefix-check to reject `..`/symlink escapes while preserving Windows
  verbatim paths.
- **Atomic writes:** write and flush a temporary sibling, then rename over the target; never modify an
  existing user file in place.
- **Errors:** cross IPC as `AppResult<T>`. `AppError::c` / `p` carry translatable codes/parameters;
  `AppError::new` is only raw external-tool output. Never `unwrap()` user input.
- **Rust ownership:** Rust creates and reaps PTYs, agent turns, subprocess groups, workspace grants and
  watchers. The webview only drives them.

## Gates

Run [verify](./skills/release-verify/SKILL.md) only on explicit verify/check requests;
[release-check](./skills/release-check/SKILL.md) only on explicit release checks.
