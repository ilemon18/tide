# File tree and workspace refresh

**Load when:** changing folder expansion/location, merged folder chains, tree virtualization, workspace
watching, or synchronization between disk, tree, Git and open tabs.
**Code:** `src/components/FileTree.tsx`, `src/store/{workspace,fileIndex,folderChain,watcher}.ts`,
`src-tauri/src/commands/fs.rs`, `src-tauri/src/watcher.rs`.

## Expansion and locating

- Opening or locating a file expands its chain through `workspace.expandChain`, which fetches levels in
  parallel and commits once; do not loop `await expandDir`, because incremental commits cause pop-in.
- With `compactFolders`, a merged row is the deepest directory in the chain and every action targets that
  row — intermediate directories have no row. Call `folderChain.invalidate(root, dir)` on content change or
  the chain keeps the old shape.
- The chain probe and the tree share one entry filter: `.DS_Store`, and dot-entries when hidden files are
  off, are the only special exclusions. Switching tabs scrolls only the current file's directory row into
  view through the `followed` ref and never alters expansion; follow a file once, or row rebuilds fight user
  scrolling.
- `DirEntryInfo.isSymlink` comes from link metadata. Every symlink is a leaf row (`isDir = false`), including
  links to directories, and single-click, ⌘↓ or a pane drop must not call `openFile` or expand it. Tree opens
  show `error.fs.symlinkUnsupported` immediately; rename, delete and move still operate on the link itself.
- Single click opens a file or toggles a folder. Double-click is only the normal tree gesture: it must not
  create or switch agent chats, and the second click must not repeat the open or toggle. Agent entry points are
  the title bar and the row context menu.
- `resolve_dir_chain` in Rust and `buildRows` in the component are one contract: resolve chains only for
  visible rows and respect the bounded depth/concurrency/cache settings beside the implementation.

## Virtual scrolling

While the scrollbar moves, keep the last settled chain snapshot and defer visible-chain resolution until
scroll idle — mid-scroll async results change row count under the thumb and cause flicker — and on snapshot
change anchor the row under the viewport by stable `root + start` identity, or stay at the bottom when already
there. When row count shrinks, clamp `scrollTop` to the new content height and again in the render window with
the current `maxScroll`, or absolutely positioned rows keep the old range and leave empty space. Row height is
shared layout data, and only pointer drag hit testing measures geometry.

## Watcher and state synchronization

- `src-tauri/src/watcher.rs` batches path changes and emits `fs:changed`; the frontend watcher store
  coordinates directory refresh, Git status refresh and disk reload, with debounce and batching bounded in
  the watcher itself.
- Refresh directories through the file index/workspace APIs, Git through [git.md](./git.md), and open tabs
  through `refreshFromDisk`, comparing metadata before re-reading and bumping the matching `diffEpoch` so
  diff tabs refresh in place. A status refresh that finds `isRepo` changed syncs that back to the root, so a
  terminal `git init` is noticed, and a fetch — which only updates remote-tracking refs — has its pure `.git`
  batch suppressed, while worktree paths in the same batch still refresh.
- **Never close a tab because Git status changed**, only a file that really vanished from disk; the one
  exception is an empty diff tab, which Git/diff logic may replace with the normal file tab.
- During an explicit checkout/create, `beginBranchTransition` suppresses the watcher's duplicate `.git` batch,
  with a short grace window after success so the debounce cannot repeat the same scans.
- Workspace roots are refcounted: dropping the last reference reaps its PTY and watcher resources in Rust, so
  never model workspace lifetime only in the frontend.
