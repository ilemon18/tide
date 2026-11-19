# Tide — AI Context

`AGENTS.md` is authoritative. Load only the routed area doc(s) for the paths you touch; load skills only
on their explicit triggers.

## Project

macOS / Windows editor: Tauri 2 + Rust, React 19 + TypeScript + Vite + Tailwind, CodeMirror 6,
xterm.js + portable-pty, and zustand. Themes and six locales are app features; English ships in the
bundle and the other five load on demand. The English catalog is the source of truth. Low memory and
startup cost are product requirements.

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

Gate procedures: [release-verify](./skills/release-verify/SKILL.md) and
[release-check](./skills/release-check/SKILL.md).

## Cross-domain hard rules

- **IPC goes through `api.*`** in `src/lib/ipc.ts`; components/stores never call Tauri `invoke`. Rust DTOs
  use camel-case serialization and match the TypeScript types one-to-one.
- **Workspace file access is `(root, rel)`.** The frontend never sends absolute file paths for file
  operations. Every command authorizes the root, then resolves inside it with canonicalization and a
  prefix check so `..` and symlink escapes are rejected. Preserve native semantics, including Windows
  verbatim prefixes.
- **Writes are atomic:** temporary sibling file, flush/close, then rename over the target. Never modify
  an existing user file in place.
- **Errors cross IPC as `AppResult<T>`:** `AppError::c` / `AppError::p` carry translatable codes and
  parameters; `AppError::new` is only raw external-tool output. Never `unwrap()` user input.
- **React state is selected, not wholesale:** use `useStore(s => s.field)`, and keep CodeMirror
  views/states outside zustand. One `EditorView` serves each pane; tab state is cached and swapped.
- **UI copy uses `t()` / `tp()`** and is added to all six catalogs. Use `--c-*` theme tokens, never literal
  colors. Event names and IPC payloads are shared protocol: update every emitter/listener and `ipc.ts`.
- **Native resources are Rust-owned.** PTYs, agent turns, subprocess groups, workspace grants and watchers
  are created/reaped in Rust; the webview only drives them.
- **Updates fail closed.** Install work runs only in Rust after an explicit user action, over HTTPS GitHub
  URLs with artifact-size and manifest-hash validation. Never commit generated release manifests.
- **One window owns one project.** Only the primary window persists session/chat state.

## Common changes

- **Backend command:** implement in the domain's Rust command module, register it in
  `src-tauri/src/main.rs`, add the typed wrapper in `src/lib/ipc.ts`, consume through a store/action, and
  add palette/error/catalog entries where applicable.
- **Setting:** follow [runtime.md](./runtime.md).
- **Editor extension:** follow [editor.md](./editor.md).
- **Theme:** update the palettes and the UI/CodeMirror/xterm application paths together; syntax colors live
  only in the syntax palette.
- **Guard or release flow:** update [checks.md](./checks.md) and the corresponding skill in one change.

## Generated files and budgets

- Do not hand-edit `src/assets/fileIcons.generated.ts`, `src/vendor/prettier/`, `src-tauri/icons/`, or
  generated Tauri output. Use the generator/build step beside each source.
- `src/lib/memoryBudget.ts` owns memory-profile limits; lightweight mode reads the same source. Read
  `budget.*` / `feature.*` at use time. Other bounded scans, caches and backpressure limits live beside
  their implementation: cite the owning module instead of copying numbers.
