---
summary: Workspace tree, folder chains and watchers
scope:
  - .ai/file-tree.md
  - src/components/FileTree.tsx
  - src/store/workspace.ts
  - src/store/fileIndex.ts
  - src/lib/workspaceEntries*.ts
  - src/store/folderChain.ts
  - src/store/watcher.ts
  - src-tauri/src/commands/fs.rs
  - src-tauri/src/watcher.rs
keywords:
  - tree
  - workspace
  - folder
  - watcher
  - 文件树
  - 目录
  - 监听
---
# File tree and workspace refresh

## Ownership

FileTree renders rows; workspace/fileIndex own directory data; folderChain owns compact chains. Rust
watcher emits fs:changed; the frontend watcher coordinates directory, Git and open-file refresh.
workspaceEntries supplies paged root-contained directory/entry reads for mention completion and Git menus;
it preserves symlink metadata, treats missing parents as absent entries, stops obsolete requests between
pages and leaves scan caps to Rust read_dir. Permission/other failures stay distinct from absence.

## Expansion and rows

- Locate/open expands through workspace.expandChain: fetch levels in parallel, commit once. Sequential
  expandDir causes pop-in. Compact rows represent the deepest directory; every action targets it.
  Invalidate folderChain(root, dir) on content changes or stale shapes persist.
- Tree and chain probes share one filter: .DS_Store and (when hidden files are off) dot-entries. Follow
  each file once through the followed ref; scroll only its directory row, never alter expansion or refollow
  on row rebuilds. Rust resolve_dir_chain and frontend buildRows resolve visible rows with local bounds.
- isSymlink comes from link metadata. All symlinks are leaves (isDir=false), even directory links.
  Single click, ⌘↓ and pane drop reject open/expand with error.fs.symlinkUnsupported; rename/delete/move
  operate on the link itself. Double-click remains the tree gesture; its second click must not repeat
  open/toggle or create/switch agent chats. Agent entry points are title bar and row context menu.
- During scrollbar motion retain the settled chain snapshot; defer visible-chain resolution until idle.
  On snapshot change anchor by stable root+start row identity, or stay bottom when already there. Clamp
  scrollTop after row shrink and again against current maxScroll in the render window to avoid blanks.
  Row height is shared layout data; only pointer drag hit testing measures geometry.

## Refresh contracts

- Rust owns debounce/batch limits. Refresh via fileIndex/workspace, Git via [git.md](./git.md), tabs via
  refreshFromDisk. Compare metadata before reads; bump matching diffEpoch to refresh diffs in place.
  Sync changed isRepo back to roots so terminal git init is noticed.
- Fetch suppresses pure .git batches; mixed worktree paths still refresh. Explicit checkout/create uses
  beginBranchTransition plus a short post-success grace period to suppress duplicate .git refreshes;
  accumulate mixed worktree paths and replay once afterward. Rescan/ignore changes always refresh.
- Git status changes never close a file tab. Only confirmed disk disappearance does; empty diffs may
  become ordinary tabs under the Git rules. Preserve loaded page counts/unreadable caches; remove only
  confirmed missing subtrees. Directory versions and workspace lifetimes reject obsolete refresh,
  pagination, chain and expand-all results after collapse/reopen, root replacement or newer reads.
- Worktree .lock files are watched; temporary lock suppression applies only within Git metadata.
  Roots are refcounted; dropping the last reference reaps Rust PTYs/watchers.

## Change map and verification

Keep Rust watcher payloads, IPC and frontend batching aligned; checkout/fetch changes also follow git.md.
Rust tests cover truncation, overflow, continuous-flow deadlines and rescan/errors. Frontend workspace/
watcher tests cover branch batches, ignore rules, cache races, permissions and missing subtrees.
Run gates only as authorized in [checks.md](./checks.md).
