# Tide — AI Context

Follow AGENTS.md; route paths, read matching sections, follow links only across task boundaries.

## Map

React: components=UI, store=state, editor=CodeMirror under src/. Rust: commands=IPC, agent=providers/storage
under src-tauri/src/. Frontend protocol: `src/lib/ipc.ts`.
Generated icons/vendor/Tauri output belong to their generators; `src/lib/memoryBudget.ts` owns memory limits.

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
| [terminal.md](./terminal.md) | PTY output, keyboard, IME and geometry |
| [updates.md](./updates.md) | Update checks, download and install |
<!-- END GENERATED ROUTES -->

## Shared contracts

- IPC: UI/stores use `api.*`, never `invoke`. Rust camel-case DTOs match TypeScript; update emitters,
  listeners and IPC types together.
- Paths: file commands take `(root, rel)`. Authorize roots, canonicalize and prefix-check containment;
  reject traversal/symlink escapes and preserve Windows verbatim semantics.
- Writes: flush a temporary sibling, then rename over the target; never overwrite user files in place.
- Errors: `AppResult<T>` with `AppError::c` / `p` for codes/params; `new` only for raw external-tool output.
  Never `unwrap()` user input.
- Resources: Rust creates/reaps PTYs, turns, process groups, grants and watchers; the webview drives them.
