---
summary: Update checks, download and install
scope:
  - .ai/updates.md
  - src/components/ReleaseNotes*.tsx
  - src/components/UpdateBadge.tsx
  - src/components/UpdateBadge.test.tsx
  - src/lib/version.ts
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

Rust `update.rs` owns the state machine; the frontend update store drives it. Settings → About and TitleBar
share one action model. Packaging and release preflight: [checks.md](./checks.md).

## Update contracts

- Debug builds never report updates, run quiet checks or show the update badge.
- Check/download/install is a Rust state machine driven by the webview. Release builds run the quiet check
  and background download only when Settings → About → Automatic updates is enabled. Automatic and manual
  downloads stop at a ready package; clicking the shared install action is explicit consent to install and
  restart. Only HTTPS GitHub URLs are accepted, and artifact byte count plus `latest.json` SHA-256 must match.
  Never commit generated `latest.json`.
- The About action starts with a manual check mapped to `check(true, true)` / `update_check { force: true }`:
  skip `update-cache.json`, send `Cache-Control: no-cache`, never fall back to stale cache and write a
  successful answer back. An available installer changes the action to Download update; one click downloads
  and verifies, then leaves Install update. Installation saves the window before restarting. Checks never
  download and manual downloads never install automatically. Failures produce a retryable error; busy states
  reject duplicates; restart timeouts return to the install action with the error.
- Title bar and Settings share labels/state. The badge shows the available action as text; missing installers
  open the release page. About shows release notes only when the checked release is newer, using manifest
  `notes` for that version. Current releases and unchecked state show no logs. Full history stays in the
  repository/archive asset and never enters the app bundle or update response. Old caches default notes
  to empty; Markdown rejects HTML/images and links use the allowlisted opener.
- The action owns checking/downloading progress text; captions only add installation behavior, destination
  path, version/package details, current-version results or errors. Omit duplicate busy/downloaded text.

## Change map

Change backend state, IPC, actions and labels together; preserve quiet/manual checks, HTTPS/size/hash
validation and explicit install consent. Gate: [checks.md](./checks.md).
