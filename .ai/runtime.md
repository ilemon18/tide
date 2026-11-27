---
summary: Windows, settings, themes and memory
scope:
  - .ai/runtime.md
  - src/App.tsx
  - src/App.test.tsx
  - src/store/ui.ts
  - src/lib/actions.ts
  - src/main.tsx
  - src/lib/contextMenu*.ts
  - src/components/TitleBar.tsx
  - src/styles/index.css
  - src-tauri/src/window_cursor.rs
  - src-tauri/Cargo.toml
  - src/components/SettingsView.tsx
  - src/components/SettingsControls.tsx
  - src/components/SettingsView.test.tsx
  - src/components/ThemeMenu.tsx
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
  - src/lib/settingsSections.ts
  - src/lib/fonts.ts
  - src/lib/iconTheme.ts
  - src/store/settings.ts
  - src/store/settings.test.ts
  - src/theme/**
  - src-tauri/src/main.rs
  - src-tauri/src/state.rs
  - src-tauri/src/commands/theme.rs
  - src-tauri/src/toolpath.rs
  - src-tauri/capabilities/**
  - vite.config.ts
  - src-tauri/tauri.conf.json
  - public/theme-boot.js
keywords:
  - runtime
  - settings
  - window
  - theme
  - memory
  - 设置
  - 窗口
  - 主题
  - 内存
---
# Runtime, windows and settings

## Ownership

App owns hydration/windows; settings and Rust theme commands own defaults/migration; `memoryBudget.ts`
owns memory limits. Updates: [updates.md](./updates.md).

## Windows and startup

- Welcome orders Open file/folder; exact grants release on Destroyed. Recents exclude open roots;
  `RECENT_PROJECT_LIMIT` (Welcome.tsx) caps six scrollable cards. `openWorkspace` owns dirty consent/
  other-window focus; menus: new-window/remove.
- Explorer/Search always show; hidden views retain commands. Disabling the current view falls back to Explorer;
  `tasksEnabled` alone controls Tasks.
- Mod+Shift+A opens Agent from any surface; Mod+A stays native and dialogs/overlays block app shortcuts.
- `useUi.page` switches workspace and standalone history; the workspace stays mounted but inert. While
  history is visible, workspace edit/tab/terminal/context commands are unavailable, Find targets history
  search, and hidden Agent handlers must not consume input. Details: [agent-storage.md](./agent-storage.md).
- One window per project. Only `IS_PRIMARY_WINDOW` persists editor/chat state; the last focused layout is
  restored after close, and blank windows never overwrite it.
- macOS hides on close: Rust flushes settings/session, then destroys; `app:hidden` releases memory and
  `Destroyed` reaps PTYs/grants. Window commands need `core:window:allow-*` in
  `src-tauri/capabilities/default.json`.

## Keyboard shortcuts

- `commandRegistry` owns metadata/default strokes/scopes, `commandRuntime` registers callbacks, and the
  resolver handles overrides/platform identities/conflicts. App capture runs before CodeMirror/xterm;
  settings/palette/tooltips share the resolver.
- One stroke has one owner across managed actions; Mod expands before comparison. Close commands are
  unavailable while a target includes a running Agent chat. Native editing and terminal input stay local.
- Recording/reset transfer strokes and unbind old owners atomically; global reset confirms. Escape cancels;
  modifiers alone, repeats and composition never save. Plain/Shift typing and clipboard/undo keys are reserved;
  only explicit Save commits.
- v14 `shortcutOverrides` defaults to `{}`; absent means default, `[]` unbinds. Normalize damaged entries
  without resetting other settings, keep unknown ids but never execute them, and share across windows.
- `ShortcutSettings`: searchable, read-only Alt gesture help in six locales.

## Settings and memory

- Read `memoryBudget` limits/features at use time, including lightweight profiles; never copy ceilings.
  Evict inactive editor states, preserve active/dirty ones, and release editor/search/quick-open caches on
  `app:hidden`.
- `DEFAULT_SETTINGS` (`store/settings.ts`) and `Settings::default` (`commands/theme.rs`) stay identical.
  Fresh installs migrate/write back Rust schema-0 defaults; then `settings.json` wins. Migrations append
  and preserve unknown fields.
- Add settings in types/defaults, migration, UI and `SHARED_KEYS`; retirement removes both defaults and adds
  `RETIRED_KEYS`. Runtime choices write immediately and sync windows.
- Formatting settings query tool availability/version and may install rustfmt (rustup) or Black (pipx/pip)
  after confirmation. Missing Go/Rust/Python environments get manual guidance; gofmt/Prettier have no auto
  updater. Choosing a tool while formatting is off enables manual mode; no extra persisted key is introduced.
- `settings.json`/`session.json` use `app_config_dir` and the Rust theme lock; chat storage follows
  [agent-storage.md](./agent-storage.md). `public/theme-boot.js` paints before React. Sidebar/drawer widths
  are window-local, not synced.

## Native cursors and configuration

- Configuration export precedes About; schema 17 sync defaults off. Transfer/recovery and the primary-window
  scheduler are owned by [configuration.md](./configuration.md).
- `index.css`: actions=pointer, text=text, unavailable=not-allowed with hints, busy=wait, drag=grabbing.
  `window_cursor.rs` registers native cursor rectangles via ivar-free subclasses, preserving actions/layout
  without retained windows/timers. Tests guard instance size/reuse.
  Caption inset: original Y, X shifted left 4px; no native layout overrides.

## Change map

Synchronize setting types/defaults, migrations, shared keys and UI. Theme changes coordinate UI/CodeMirror/
xterm palettes through tokens; generated assets keep their generators. Built-ins follow VS Code's bundled
theme JSON, third-party themes their official VS Code extension, and `tide`/`eyecare` remain custom. Keep
activity/title/tab/status surface tokens explicit; `src/theme/palettes.test.ts` pins upstream projections.
Gate: [checks.md](./checks.md).
