# Runtime, memory, settings and updates

**Load when:** changing the app shell/window lifecycle, platform chrome, memory release, settings
persistence/migration, update/install behavior, or build/runtime configuration.
**Code:** `src/App.tsx`, `src/main.tsx`, `src/components/TitleBar.tsx`, `src/lib/{memoryBudget,displayScale,update}.ts`,
`src-tauri/src/{main,state,update}.rs`, `src-tauri/src/commands/theme.rs`, `vite.config.ts`,
`src-tauri/tauri.conf.json`.

## Windows and app shell

- One window owns exactly one project; opening several projects means several app windows. The primary
  window alone persists session/chat state (`IS_PRIMARY_WINDOW`). Secondary windows receive their project
  on the window URL and must not overwrite primary state.
- The Tide window cycle shortcut is `Cmd+\`` / `Ctrl+\`` in stable native order (`main`, then secondary
  windows by creation sequence) with wraparound. Shift is not part of the shortcut.
- macOS reserves the native traffic-light inset. Windows/Linux use a custom title bar and must not reserve
  that macOS-only area; `TitleBar` owns the drag region and right-side window controls. Every window
  command needs the matching `core:window:allow-*` capability in `src-tauri/capabilities/default.json`.
- Display-density adjustments belong in `src/lib/displayScale.ts` and its stylesheet hook, not in individual
  components. It watches scale-factor changes; terminal font-weight and antialiasing compensations should
  stay centralized there.
- Closing the main window on macOS hides it rather than quitting. Rust prevents close, gives the frontend a
  short grace period to flush settings/session, then destroys it. The frontend must release memory on
  `app:hidden`.
- `WindowEvent::Destroyed` is the reaping point for that window's PTYs and workspace grants. The frontend
  cannot close those resources after destruction.
- A second launch with a file emits `app:open-file`; no listener currently reveals that file. Do not assume
  the event is consumed without wiring it end-to-end.
- Debug builds must not perform startup update reporting or quiet checks, and must not show the title-bar
  update badge. Enforce the guard in both frontend and backend; Settings → About remains a manual entry.

## Memory policy

- `src/lib/memoryBudget.ts` is the single source for editor state, search/index and terminal budgets.
  Lightweight mode switches the shared profile; read `budget.*` / `feature.*` at use time and never copy
  numeric ceilings into docs or components.
- Memory strategy is bounded caches plus explicit release, not a different feature set. Evict inactive
  editor states while preserving active/dirty tabs. On `app:hidden`, release inactive `EditorState`s,
  search results and the quick-open index. Keep other backpressure limits beside their owners.

## Settings and config data

- Default settings exist in both `DEFAULT_SETTINGS` (`src/store/settings.ts`) and
  `Settings::default` (`src-tauri/src/commands/theme.rs`); keep them identical. A fresh install starts
  from Rust defaults with schema version 0, migrates in the frontend, and writes the result back. After
  that, `settings.json` wins.
- Add a setting to both types, both defaults, the migration path where needed, `SHARED_KEYS` if every
  window must react, and the settings UI. A missing shared key appears as “only the other window did not
  update”.
- Retire a setting by removing both types/defaults and adding its old key to `RETIRED_KEYS`; otherwise it
  is treated as unknown and written back forever. Preserve unknown fields from newer versions.
- `settings.json` and `session.json` live in `app_config_dir()` and are read/written under the lock in
  `src-tauri/src/commands/theme.rs`. Agent transcript/tab storage is documented in [agent.md](./agent.md).
- `public/theme-boot.js` paints the first theme before React. Keep it CSP-compatible: no inline script.

## Updates and installers

- Update check/download/install is a Rust state machine; the webview only drives it. Release builds may
  run one quiet startup check, but download and install require an explicit user action. Only HTTPS
  GitHub URLs are accepted, and artifact byte count plus `latest.json` SHA-256 must match before use.
  Never commit generated `latest.json`.
- The macOS curl installer accepts only the latest stable manifest, validates the DMG URL/size/hash and app
  version, then replaces the app under `~/Applications` without sudo. Windows distribution remains an
  `.exe` installer.

## Build

- The Vite dev port and Tauri `devUrl` must agree. The webview build target is conservative for WKWebView;
  check it before using newer syntax and add a compatible fallback.

