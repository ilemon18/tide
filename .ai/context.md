# Tide — AI Context

`AGENTS.md` is authoritative. Load only the routed area doc(s) for the paths you touch; load skills only on
their explicit triggers.

## Project

macOS / Windows editor: Tauri 2 + Rust, React 19 + TypeScript + Vite + Tailwind, CodeMirror 6, xterm.js +
portable-pty, zustand. Themes and six locales are app features, with `src/i18n/messages/en.ts` as the source of
truth and five catalogs loaded on demand. Low memory and startup cost are product requirements.

## Route by change

| Change | Load |
|---|---|
| Editor, tabs, Markdown preview, CodeMirror | [editor.md](./editor.md) |
| File tree, folder chains, workspace refresh | [file-tree.md](./file-tree.md) |
| Git, diff, conflicts, bulk discard | [git.md](./git.md) |
| Terminal, PTY, terminal keyboard/IME | [terminal.md](./terminal.md) |
| App shell, windows, memory, settings, updates, build | [runtime.md](./runtime.md) |
| Built-in agent | [agent.md](./agent.md) |
| UI copy, locales, backend errors | [i18n.md](./i18n.md) |
| Guards, CI, release wiring | [checks.md](./checks.md) |

Gates: [release-verify](./skills/release-verify/SKILL.md) and
[release-check](./skills/release-check/SKILL.md).

## Cross-domain contracts

- **IPC goes through `api.*`** in `src/lib/ipc.ts`; components and stores never call `invoke`. Rust DTOs
  serialize camel-case and match the TypeScript types one-to-one. Event names and payloads are one protocol:
  update every emitter/listener and `ipc.ts` together.
- **Workspace file access is `(root, rel)`, never an absolute path from the frontend.** Every command
  authorizes the root, then resolves inside it with canonicalization and a prefix check so `..` and symlink
  escapes are rejected, preserving native semantics including Windows verbatim prefixes.
- **Writes are atomic**: temporary sibling file, flush/close, rename over the target — never an in-place
  modification of an existing user file.
- **Errors cross IPC as `AppResult<T>`**: `AppError::c` / `AppError::p` carry translatable codes and
  parameters, `AppError::new` is only raw external-tool output, and user input is never `unwrap()`ed.
- **Native resources are Rust-owned**: PTYs, agent turns, subprocess groups, workspace grants and watchers are
  created and reaped in Rust, and the webview only drives them.

## Common changes

A backend command goes in the domain's Rust command module, is registered in `src-tauri/src/main.rs`, gets a
wrapper in `src/lib/ipc.ts`, is consumed through a store or action, and adds palette/error/catalog entries
where applicable. A **setting** follows [runtime.md](./runtime.md), an **editor extension**
[editor.md](./editor.md), a **guard or release flow** [checks.md](./checks.md) plus its skill in the same
change, and a **theme** change touches palettes and the UI/CodeMirror/xterm paths together. Colors come from
`--c-*` tokens, never literals, and syntax colors live only in the syntax palette.

## Generated files and budgets

Do not hand-edit `src/assets/fileIcons.generated.ts`, `src/vendor/prettier/`, `src-tauri/icons/` or generated
Tauri output; use the generator beside each source. `src/lib/memoryBudget.ts` owns the memory-profile limits
and lightweight mode reads the same source, so cite the owning module instead of copying numbers.
