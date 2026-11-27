---
summary: HTML preview and local service lifetimes
scope:
  - .ai/live-preview.md
  - src/components/GoLive*.tsx
  - src/store/goLive*.ts
  - src-tauri/src/live_preview.rs
keywords:
  - live
  - html
  - preview
  - server
  - 预览
  - 服务
---
# Local HTML preview

`live_preview.rs` owns loopback listeners, streamed HTTP responses and limits. `goLive` is window-local
UI state; no IPC, listeners or timers start until a user starts a preview or opens the running list.

- StatusBar places Go Live before the theme; it is on by default (`goLiveEnabled`). Disabling it in Settings
  hides the entry and stops running previews. Starting saves a dirty named HTML file first. A window/file
  pair reuses its server; other files/windows get independent listeners. Bind loopback starting at 5500,
  increment only on actual address-in-use failure, and keep owner checks on list/open/stop.
- The centered icon/text trigger uses pointer for HTML and not-allowed with a hint otherwise; the running
  list remains accessible from any file. Busy actions use wait and reject duplicate starts.
- Preview reads stay in the authorized root, reject hidden/traversal/symlink escapes, support relative and
  root-relative resources, and stream files without caching bodies. Exact external-file grants serve only
  that file; related resources require opening the containing folder.
- Existing workspace watchers bump revisions for running servers. Inject a small client which polls only
  while its page is visible; HTML metadata also detects direct file edits. CSP may disallow the reload script.
- Closing a project/window or exiting stops matching services, wakes accept and joins workers. No PTYs,
  child web-server processes or new recursive watchers are created. Buffer/stack/service caps live in Rust.
- The running list has no general local-access paragraph; only an external standalone file keeps its
  related-assets hint.
- Tests cover actual occupied-port fallback, owner isolation, same-file reuse, streamed resources, traversal,
  host checks, reload revisions and teardown. Frontend tests cover lazy start/save and stale-list rejection.
