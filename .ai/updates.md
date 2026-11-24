---
summary: Update checks, download and install
scope:
  - .ai/updates.md
  - src/components/UpdateBadge.tsx
  - src/components/UpdateBadge.test.tsx
  - src/lib/update.ts
  - src/lib/updateView.ts
  - src/lib/updateView.test.ts
  - src/store/update.ts
  - src/store/update.test.ts
  - src-tauri/src/update.rs
  - src/App.tsx
  - src/components/SettingsView.tsx
  - src/components/SettingsView.test.tsx
  - src/components/TitleBar.tsx
keywords:
  - update
  - download
  - install
  - 更新
  - 下载
  - 安装
---
# Application updates

## Ownership

Rust update.rs owns the state machine; the frontend update store drives it. Settings/About and TitleBar
share one action model. Packaging and release preflight remain in [checks.md](./checks.md).

## Update contracts

- Debug builds never report updates, run quiet checks or show the update badge, in frontend or backend.
- Check/download/install is a Rust state machine driven by the webview. Release builds run the quiet check
  and background download only when Settings → About → Automatic updates is enabled. Downloads always
  stop at a ready package and ask for confirmation before installation; install and restart require that
  explicit consent. Only HTTPS GitHub URLs are
  accepted, and artifact byte count plus `latest.json` SHA-256 must match before use; never commit generated
  `latest.json`.
- Settings → About has one state-driven update action. Its initial manual check maps to
  `check(true, true)` / `update_check { force: true }`: it skips `update-cache.json`, sends
  `Cache-Control: no-cache` on every lookup, never falls back to an old cache on failure, and writes a
  successful answer back to the cache. When an installer is available the action changes to **Download
  update**; one explicit click downloads and verifies the package, then leaves it in the **Install update**
  state. Installation is a separate explicit action that saves the initiating window before restarting.
  Checks alone never download, and manual downloads never install automatically. Remaining dirty tabs or a
  failed subscription/download/save/install produce a retryable error; busy states reject duplicate actions.
  Native manual-install outcomes still reveal the package, and a restart timeout returns to the install action
  with its error visible.
- Title bar and Settings share action labels and state. The release primary-window badge shows the available
  action as text; downloads use a fixed 16px SVG circle beside the localized percentage, with 8px gap and
  horizontal padding. It never measures text for progress geometry. Missing installers open the release page.
  The About page shows the logo and a `v`-prefixed installed version and no longer exposes update logs.
- The About action owns checking/downloading progress text. Captions only add information: installation
  restart behavior, an actual destination path, version/package details, current-version results or errors.
  Omit duplicate busy/downloaded instructions in the shared presentation model, without comparing translations.

## Change map and verification

Change backend state, IPC payloads, frontend actions and localized labels together. Preserve quiet/manual
check distinctions, HTTPS/size/hash validation and explicit installation consent. Update tests cover cache
bypass with no cached fallback, discovery-only checks, duplicate actions, progress and retry paths.
Native installation/restart behavior requires explicitly requested verification; use [checks.md](./checks.md).
