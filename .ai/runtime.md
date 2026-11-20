# Runtime, memory, settings and updates

**Load when:** changing the app shell/window lifecycle, platform chrome, memory release, settings
persistence/migration, update/install behavior, or build/runtime configuration.
**Code:** `src/App.tsx`, `src/main.tsx`, `src/components/TitleBar.tsx`,
`src/lib/{memoryBudget,displayScale,update}.ts`, `src-tauri/src/{main,state,update}.rs`,
`src-tauri/src/commands/theme.rs`, `vite.config.ts`, `src-tauri/tauri.conf.json`.

## Windows and app shell

- One window owns exactly one project; several projects mean several app windows. Only the primary window
  persists session/chat state (`IS_PRIMARY_WINDOW`), and secondaries receive their project on the window URL
  without overwriting primary state.
- macOS keeps the native traffic-light inset; Windows/Linux use a custom title bar (`TitleBar` owns the drag
  region and right-side controls), and every window command needs the matching `core:window:allow-*`
  capability in `src-tauri/capabilities/default.json`.
- Closing the main window on macOS hides it instead of quitting: Rust prevents close, gives the frontend a
  short grace period to flush settings/session, then destroys it, and the frontend releases memory on
  `app:hidden`. `WindowEvent::Destroyed` reaps that window's PTYs and workspace grants, so the frontend
  cannot close them afterwards.
- Debug builds must not report updates, run quiet checks or show the title-bar update badge, in either
  frontend or backend; `app:open-file` still has no listener, so do not assume it is consumed.

## Memory and settings

- `src/lib/memoryBudget.ts` is the single source for editor state, search/index and terminal budgets, and
  lightweight mode switches the shared profile: read `budget.*` / `feature.*` at use time and never copy
  ceilings into docs or components. The strategy is bounded caches plus explicit release — evict inactive
  editor states while preserving active/dirty tabs, and release them, search results and the quick-open index
  on `app:hidden`.
- Defaults exist twice, `DEFAULT_SETTINGS` (`src/store/settings.ts`) and `Settings::default`
  (`src-tauri/src/commands/theme.rs`), and must stay identical. A fresh install starts from Rust defaults at
  schema version 0, migrates in the frontend and writes back; after that `settings.json` wins.
- Adding a setting touches both types, both defaults, the migration path, `SHARED_KEYS` if every window must
  react, and the settings UI; retiring one removes both defaults and adds the old key to `RETIRED_KEYS`, or it
  is written back forever. Preserve unknown fields from newer versions.
- `settings.json` and `session.json` live in `app_config_dir()` under the lock in
  `src-tauri/src/commands/theme.rs`; agent storage is in [agent.md](./agent.md). `public/theme-boot.js` paints
  the first theme before React and must stay CSP-compatible: no inline script.

## Updates

- Check/download/install is a Rust state machine driven by the webview. Release builds may run one quiet
  startup check, but download and install require an explicit user action. Only HTTPS GitHub URLs are
  accepted, and artifact byte count plus `latest.json` SHA-256 must match before use; never commit generated
  `latest.json`.