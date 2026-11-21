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
- Check/download/install is a Rust state machine driven by the webview. Release builds may run one quiet
  startup check, but download and install require an explicit user action. Only HTTPS GitHub URLs are
  accepted, and artifact byte count plus `latest.json` SHA-256 must match before use; never commit generated
  `latest.json`.
- Settings → About has one state-driven update action. Its initial manual check maps to
  `check(true, true)` / `update_check { force: true }`: it skips `update-cache.json`, sends
  `Cache-Control: no-cache` on every lookup, never falls back to an old cache on failure, and writes a
  successful answer back to the cache. When an installer is available the action changes to **Update to
  latest**: one explicit click downloads, verifies, saves the initiating window and starts installation/restart.
  Checks alone never download. Remaining dirty tabs or a failed subscription/download/save/install produce
  a retryable error; busy states reject duplicate actions. Native manual-install outcomes still reveal the
  package, and a restart timeout returns to the install action with its error visible.
- Title bar and Settings share action labels and state. The release primary-window badge shows the available
  action as text; downloads use a fixed 16px SVG circle beside the localized percentage, with 8px gap and
  horizontal padding. It never measures text for progress geometry. Missing installers open the release page.

## Change map and verification

Change backend state, IPC payloads, frontend actions and localized labels together. Preserve quiet/manual
check distinctions, HTTPS/size/hash validation and explicit installation consent. Update tests cover cache
bypass with no cached fallback, discovery-only checks, duplicate actions, progress and retry paths.
Native installation/restart behavior requires explicitly requested verification; use [checks.md](./checks.md).
