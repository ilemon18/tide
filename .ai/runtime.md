---
summary: Window shell, lifecycle and memory budget
scope:
  - .ai/runtime.md
  - src/App.tsx
  - src/App.test.tsx
  - src/store/ui.ts
  - src/lib/actions.ts
  - src/main.tsx
  - src/lib/contextMenu*.ts
  - src/components/TitleBar.tsx
  - src-tauri/src/window_cursor.rs
  - src-tauri/Cargo.toml
  - src/lib/memoryBudget.ts
  - src/lib/displayScale.ts
  - src/lib/commandRegistry.ts
  - src/lib/commandRuntime.ts
  - src/lib/shortcuts*.ts
  - src/lib/shortcutDispatch*.ts
  - src/lib/useShortcut.ts
  - src/components/ShortcutSettings*.tsx
  - src/components/ActivityBar.tsx
  - src/components/ActivityBar.test.tsx
  - src/lib/activityBar.ts
  - src/components/StatusBar.tsx
  - src/lib/memory.ts
  - src/components/Welcome*.tsx
  - src-tauri/src/main.rs
  - src-tauri/src/state.rs
  - src-tauri/src/toolpath.rs
  - src-tauri/capabilities/**
  - vite.config.ts
  - src-tauri/tauri.conf.json
keywords:
  - runtime
  - window
  - lifecycle
  - memory
  - shortcut
  - 窗口
  - 生命周期
  - 内存
  - 快捷键
---
# Runtime, windows and lifecycle

## Ownership

App owns hydration/windows; `memoryBudget.ts` owns memory limits. Settings: [settings.md](./settings.md);
themes: [themes.md](./themes.md); updates: [updates.md](./updates.md).

## Windows and startup

- Welcome orders Open file/folder; exact grants release on Destroyed. Recents exclude open roots;
  `RECENT_PROJECT_LIMIT` (Welcome.tsx) caps 12 cards; `.welcome-project-grid` adapts to 2/3/4 columns by pane width.
  Current status shares the heading; `openWorkspace` owns dirty consent/
  other-window focus; menus: new-window/remove.
- Explorer/Search always show; hidden views retain commands. Disabling the current view opens Explorer;
  `tasksEnabled` controls Tasks.
- Mod+Shift+A opens Agent from any surface; Mod+A stays native and dialogs/overlays block app shortcuts.
- `useUi.page` keeps workspace mounted/inert behind history. Workspace edit/tab/terminal/context commands
  are unavailable there; Find targets history; hidden Agent handlers consume no input ([agent-storage.md](./agent-storage.md)).
- One window per project; `IS_PRIMARY_WINDOW` persists editor/chat state. Restore the last focused layout;
  blank windows never overwrite it.
- macOS hides on close: Rust flushes settings/session, then destroys; `app:hidden` releases memory and
  `Destroyed` reaps PTYs/grants. Window commands need `core:window:allow-*` in
  `src-tauri/capabilities/default.json`.

## Keyboard shortcuts

- `commandRegistry` owns defaults/scopes, `commandRuntime` callbacks. The resolver handles platform overrides/
  conflicts; app capture precedes CodeMirror/xterm; settings/palette/tooltips share it.
- Managed strokes have one owner; expand Mod before comparison. Close commands are
  unavailable while a target includes a running Agent chat. Native editing and terminal input stay local.
- Recording/reset transfers strokes atomically; global reset confirms. Escape cancels; modifiers/repeats/IME
  never save. Typing/clipboard/undo keys are reserved; explicit Save commits.
- v14 `shortcutOverrides` defaults to `{}`; absent means default, `[]` unbinds. Normalize damaged entries
  without resetting other settings, keep unknown ids but never execute them, and share across windows.
- `ShortcutSettings`: searchable, read-only Alt gesture help in six locales.
- Quick Open defaults to Mod+P / Ctrl+G / Mod+G; line jumps use the same picker (`:line`), no default binding.

## Memory budget

- Query `memoryBudget` at use time; never copy ceilings. Evict inactive states (keep active/dirty) and
  release editor/search/quick-open caches on `app:hidden`. Lightweight disables `smartCompletion`; reclaim
  clears its completion cache via `clearCompletionCache`.

## Cursors and configuration

- Configuration export precedes About; backup sync defaults off. Transfer/recovery and the primary-window
  scheduler are owned by [configuration.md](./configuration.md).
- `index.css`: actions=pointer, text=text, unavailable=not-allowed with hints, busy=wait, drag=grabbing.
  `window_cursor.rs` uses ivar-free cursor subclasses, preserving native actions/layout without retained
  windows/timers. Tests guard instance size/reuse.
  Caption: original Y, X minus 4px; no native layout overrides.

## Change map

Synchronize window lifecycle, hydration and memory limits; settings and themes have their own change maps.
Gate: [checks.md](./checks.md).
