# Tide — AI Context

Follow AGENTS.md; route paths, read matching sections, follow links only across tasks.

## Map

React: components=UI, store=state, editor=CodeMirror under src/. Rust: commands=IPC, agent=providers/storage
under src-tauri/src/. Protocol: `src/lib/ipc.ts`. Generated output belongs to generators;
`src/lib/memoryBudget.ts` owns memory limits.

<!-- BEGIN GENERATED ROUTES -->
| Doc | Summary |
|---|---|
| [agent-composer.md](./agent-composer.md) | Input, mentions, questions and plans |
| [agent-storage.md](./agent-storage.md) | History, paging and persistence |
| [agent.md](./agent.md) | Providers, turns, events and reply UI |
| [checks.md](./checks.md) | Guards, docs, CI and release |
| [editor.md](./editor.md) | Tabs, files, Markdown and CodeMirror |
| [file-tree.md](./file-tree.md) | Workspace tree, folder chains and watchers |
| [git.md](./git.md) | Git actions, diffs and conflicts |
| [i18n.md](./i18n.md) | Locales, UI copy and coded errors |
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
