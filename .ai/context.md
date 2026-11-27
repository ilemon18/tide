# Tide — AI Context

Follow AGENTS.md; route paths, read matches, follow links only across domains.

## Map

`src/`: components=UI, store=state, editor=CodeMirror. `src-tauri/src/`: commands=IPC, agent=providers/storage.
IPC: `src/lib/ipc.ts`; generators own output; limits: `src/lib/memoryBudget.ts`.

<!-- BEGIN GENERATED ROUTES -->
| Doc | Summary |
|---|---|
| [agent-composer.md](./agent-composer.md) | Input, mentions, questions and plans |
| [agent-storage.md](./agent-storage.md) | History, paging and persistence |
| [agent.md](./agent.md) | Providers, turns, events and reply UI |
| [checks.md](./checks.md) | Guards, docs, CI and release |
| [configuration.md](./configuration.md) | Configuration transfer and scheduled backups |
| [editor.md](./editor.md) | Tabs, files, Markdown and CodeMirror |
| [file-tree.md](./file-tree.md) | Workspace tree, folder chains and watchers |
| [git.md](./git.md) | Git actions, diffs and conflicts |
| [i18n.md](./i18n.md) | Locales, UI copy and coded errors |
| [live-preview.md](./live-preview.md) | HTML preview and local service lifetimes |
| [runtime.md](./runtime.md) | Windows, settings, themes and memory |
| [tasks.md](./tasks.md) | Project tasks, process execution and Problems diagnostics |
| [terminal.md](./terminal.md) | PTY output, keyboard, IME and geometry |
| [updates.md](./updates.md) | Update checks, download and install |
<!-- END GENERATED ROUTES -->

## Shared contracts

- IPC: UI/stores use `api.*`, never `invoke`; Rust DTOs match TypeScript.
- Paths: file commands take `(root, rel)`; authorize, canonicalize and prefix-check roots, reject traversal/
  symlink escapes and preserve Windows verbatim semantics.
- Writes: flush a temporary sibling, then rename over the target.
- Errors: `AppResult<T>` with `AppError::c` / `p`; never `unwrap()` user input.
- Resources: Rust creates/reaps PTYs, turns, process groups, grants and watchers.

- UI cursors: actions=pointer, text=text, unavailable=not-allowed; retain hints and center row icons/text.
