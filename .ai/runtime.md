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
  - src/components/SettingsView.tsx
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
  - src/components/Welcome.tsx
  - src/lib/settingsSections.ts
  - src/lib/fonts.ts
  - src/lib/iconTheme.ts
  - src/store/settings.ts
  - src/store/settings.test.ts
  - src/theme/**
  - src-tauri/src/main.rs
  - src-tauri/src/state.rs
  - src-tauri/src/commands/theme.rs
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

App owns hydration/window coordination; the settings store and Rust theme commands own defaults/migration;
`src/lib/memoryBudget.ts` owns memory limits. Updates: [updates.md](./updates.md).

## Windows and startup

- Welcome lists Open file before Open folder; external files use exact grants released on Destroyed.
  Explorer and Search always show; other views hide cosmetically (commands still open them, and turning one
  off falls back to Explorer once). `tasksEnabled` is the only Tasks switch.
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
- Recording and reset transfer strokes and explicitly unbind previous owners in one patch; global reset
  confirms first. Escape cancels; modifier-only, repeat and composition events never save. Plain/Shift-only
  typing and native clipboard/undo keys cannot be assigned; only explicit Save commits.
- v14 `shortcutOverrides` defaults to `{}`; absent means default, `[]` unbinds. Normalize damaged entries
  without resetting other settings, keep unknown ids but never execute them, and share across windows.

## Settings and memory

- Read `memoryBudget` limits/features at use time, including lightweight profiles; never copy ceilings.
  Evict inactive editor states, preserve active/dirty ones, and release editor/search/quick-open caches on
  `app:hidden`.
- `DEFAULT_SETTINGS` in `src/store/settings.ts` and `Settings::default` in
  `src-tauri/src/commands/theme.rs` stay identical. Fresh installs use Rust schema-0 defaults, then
  migration/writeback; afterwards `settings.json` wins. Migrations only append and preserve unknown fields.
- Add settings in types/defaults, migration, UI and `SHARED_KEYS`; retirement removes both defaults and adds
  `RETIRED_KEYS`. Runtime choices write immediately and sync windows.
- `settings.json`/`session.json` use `app_config_dir` and the Rust theme lock; chat storage follows
  [agent-storage.md](./agent-storage.md). `public/theme-boot.js` paints before React. Sidebar/drawer widths
  are window-local, not synced.

## Change map

Synchronize setting types/defaults, migrations, shared keys and UI. Theme changes coordinate UI/CodeMirror/
xterm palettes through tokens; generated assets keep their generators. Built-ins follow VS Code's bundled
theme JSON, third-party themes their official VS Code extension, and `tide`/`eyecare` remain custom. Keep
activity/title/tab/status surface tokens explicit; `src/theme/palettes.test.ts` pins upstream projections.
Gate: [checks.md](./checks.md).
