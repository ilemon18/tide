---
summary: Windows, settings, themes and memory
scope:
  - .ai/runtime.md
  - src/App.tsx
  - src/App.test.tsx
  - src/main.tsx
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

App owns hydration/window coordination; the settings store and Rust theme commands own migration/defaults.
`src/lib/memoryBudget.ts` owns memory limits. Updates: [updates.md](./updates.md).

## Windows and startup

- Mod+Shift+A opens Agent using the title-bar action, including from editors/terminals/text fields. Mod+A
  always remains native; dialogs/overlays block app shortcuts. Shared shortcut contracts are below.

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

## Keyboard shortcuts

- commandRegistry owns stable metadata/default strokes/scopes; commands owns executable actions and shared
  availability; commandRuntime registers mounted surface callbacks. Shortcuts resolves overrides, platform
  identities and conflicts; App capture dispatches them before CodeMirror/xterm. Settings/palette/tooltips
  use the same resolver. Palette selection closures retain captured context while key labels update live.
- One physical stroke has one owner across managed actions; Mod expands before comparison. The shared
  Mod+Down action opens a focused tree row or jumps in the active chat. Other ordinary widget navigation,
  native editing and terminal character input keep their local handlers.
- Saving a recording transfers the stroke and persists explicit removals for all previous owners in one
  patch, including hidden actions. Keep other aliases. Single reset transfers default strokes the same way;
  global reset clears overrides. Recording captures before dispatch, Escape cancels, modifier-only/repeat/
  composition events never save. Plain/Shift-only typing and native select/copy/paste/cut/undo/redo keys
  cannot be assigned. Only explicit Save commits; no extra conflict confirmation.
- v14 shortcutOverrides defaults to {}; absent id means defaults, [] explicitly unbinds. Normalize damaged
  entries without resetting other settings; retain unknown ids but never execute them. Compare key content,
  preserve override order for deterministic duplicate recovery, save immediately and share across windows.
  Rust handles malformed shortcut fields independently from the remaining settings.

## Settings and memory

- Keep helper copy for non-obvious reload/per-file effects. Format-auto/icon-theme help uses tooltips.
- Read memoryBudget's budget/feature at use time, including lightweight profiles; never copy ceilings.
  Bound caches and explicitly release: evict inactive editor states, preserve active/dirty ones; release
  them, search results and quick-open index on app:hidden.
- `DEFAULT_SETTINGS` in `src/store/settings.ts` and `Settings::default` in
  `src-tauri/src/commands/theme.rs` stay identical. Fresh install uses Rust schema-0 defaults, frontend
  migration and writeback; afterward settings.json wins. Preserve unknown fields from newer versions.
  Automatic save defaults to off; an explicit saved value remains authoritative. The project chat history
  toggle belongs under Settings → Agent, while update preferences belong under Settings → About.
  Composer defaults follow [input contracts](./agent-composer.md): normalize old smaller heights upward,
  preserve larger saved heights, and only clamp for the current window in the composer.
- Add settings in both types/defaults, migration, UI and SHARED_KEYS when shared across windows. Retirement
  removes both defaults and adds RETIRED_KEYS or the old key is written back forever.
- Tasks has an empty state without a project. Disabling tasks hides its activity and stops live runs;
  execution, diagnostics and process ownership follow [tasks.md](./tasks.md).
- Settings → Agent no longer exposes permission defaults or a permission explanation card. Chat composer
  permission controls and the persisted permission field remain runtime contracts for existing and new chats.
- Schema v11 adds agentDefaultPermissionMode=workspace-write, schema v12 adds autoUpdate=false, and schema
  v13 adds agentHistoryEnabled=true; v14 adds shortcutOverrides={}; v15 adds tasksEnabled=true. Invalid
  values fall back without resetting other settings. Provider/model/effort/permission and update preferences
  write immediately and sync windows; UI patches related fields together. Historical chats keep saved options;
  temporary plan options never become defaults.
- settings.json/session.json use app_config_dir and the Rust theme lock; chat storage follows
  [agent-storage.md](./agent-storage.md). `public/theme-boot.js` paints before React with CSP-safe external JS.
  Sidebar width is a per-window layout field: dragging updates it live and the splitter commits the latest value
  immediately, while other windows keep their own layout state.

## Change map and verification

Synchronize setting types/defaults, migrations, shared keys and UI. Theme changes coordinate UI/CodeMirror/
xterm palettes using theme tokens; generated assets retain their generators. App/settings tests protect
startup and migration. Gate execution: [checks.md](./checks.md).
