---
summary: Windows, settings, themes and memory
scope:
  - .ai/runtime.md
  - src/App.tsx
  - src/App.test.tsx
  - src/main.tsx
  - src/components/TitleBar.tsx
  - src/components/SettingsView.tsx
  - src/components/ThemeMenu.tsx
  - src/lib/memoryBudget.ts
  - src/lib/displayScale.ts
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

App owns hydration/window coordination; the settings store and Rust theme commands own migration/defaults.
`src/lib/memoryBudget.ts` owns memory limits. Updates: [updates.md](./updates.md).

## Windows and startup

- Cmd/Ctrl+A opens the agent from application chrome and uses the same action as the title-bar agent button;
  editor, terminal, text-field, contenteditable and dialog targets retain native select-all behavior.

- One window/project. Only `IS_PRIMARY_WINDOW` persists session/chat state; secondaries use the window URL
  project without overwriting primary state. `app:open-file` has no listener; do not assume consumption.
- macOS retains traffic-light inset; Windows/Linux use TitleBar's custom drag/control region. Every window
  command needs its `core:window:allow-*` capability in `src-tauri/capabilities/default.json`.
- macOS main-window close hides instead of quitting: Rust prevents close, allows a short frontend
  settings/session flush, then destroys; `app:hidden` releases frontend memory. WindowEvent::Destroyed
  reaps PTYs/grants, so frontend cleanup cannot close them afterward.
- Render the themed startup frame before restoration effects; render failure prevents the reveal timer.
  `src/App.test.tsx` covers initial render with real hooks, without native effects.
- Right editor region owns terminal geometry. Maximize hides its wrapper without unmount/sidebar changes;
  follow [terminal.md](./terminal.md) for drag/restore.

## Settings and memory

- Keep helper copy for non-obvious reload/per-file effects. Format-auto/icon-theme help uses tooltips.
- Read memoryBudget's budget/feature at use time, including lightweight profiles; never copy ceilings.
  Bound caches and explicitly release: evict inactive editor states, preserve active/dirty ones; release
  them, search results and quick-open index on app:hidden.
- `DEFAULT_SETTINGS` in `src/store/settings.ts` and `Settings::default` in
  `src-tauri/src/commands/theme.rs` stay identical. Fresh install uses Rust schema-0 defaults, frontend
  migration and writeback; afterward settings.json wins. Preserve unknown fields from newer versions.
  Composer defaults follow [input contracts](./agent-composer.md): normalize old smaller heights upward,
  preserve larger saved heights, and only clamp for the current window in the composer.
- Add settings in both types/defaults, migration, UI and SHARED_KEYS when shared across windows. Retirement
  removes both defaults and adds RETIRED_KEYS or the old key is written back forever.
- Schema v11 adds agentDefaultPermissionMode=workspace-write and schema v12 adds autoUpdate=false. Invalid
  values fall back without resetting other settings. Provider/model/effort/permission and update preferences
  write immediately and sync windows; UI patches related fields together. Historical chats keep saved options;
  temporary plan options never become defaults.
- settings.json/session.json use app_config_dir and the Rust theme lock; chat storage follows
  [agent-storage.md](./agent-storage.md). `public/theme-boot.js` paints before React with CSP-safe external JS.

## Change map and verification

Synchronize setting types/defaults, migrations, shared keys and UI. Theme changes coordinate UI/CodeMirror/
xterm palettes using theme tokens; generated assets retain their generators. App/settings tests protect
startup and migration. Gate execution: [checks.md](./checks.md).
