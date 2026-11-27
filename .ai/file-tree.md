---
summary: Workspace tree, folder chains and watchers
scope:
  - .ai/file-tree.md
  - src/components/FileTree*.tsx
  - src/components/BreadcrumbMenu*.tsx
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

FileTree renders rows; workspace/fileIndex own directory data; `folderChain` owns compact chains. Rust
watcher emits `fs:changed`; the frontend coordinates directory, Git and file refresh. `workspaceEntries`
pages root-contained reads for mentions/Git menus, preserves symlink metadata and stops obsolete requests.
Permission failures stay distinct from absence.

## Expansion and rows

- Loaded trees with no visible rows render no empty-folder copy or placeholder space. Unread roots keep the
  reading hint; fully collapsed roots keep the expand button.
- Locate/open expands through `workspace.revealPath`: page each ancestor until the next path component is
  loaded, fetch levels in parallel, commit once; a first-page-only `expandChain` leaves later entries
  undrawable. Keep normal scrolling on the small page size and use the backend's maximum page size only for
  reveal. Compact rows represent the deepest directory and every action targets it. Invalidate
  `folderChain(root, dir)` on content changes or stale shapes.
- Tree and chain probes share one filter: `.DS_Store` and, when hidden files are off, dot-entries. Follow
  each file once through the followed ref; scroll only its directory row. Rust `resolve_dir_chain` and
  frontend `buildRows` resolve visible rows with local bounds.
- `TreeReveal.center` (tab double-click) re-reveals by paging to the target, centring its label vertically and
  horizontally and forcing layout even when selected. Keep centring through late folder-chain compaction,
  then release on the settle timer or a user scroll/pointer/key gesture; plain reveals only scroll into view
  when needed. A missing target falls back to the deepest loaded ancestor and reports `io.notFound`.
- Switched file-tab clicks request `TreeReveal.upper`: use the same paged reveal and settle lifecycle,
  selecting at one quarter of the viewport height while preserving horizontal scroll.
- TitleBar breadcrumbs browse siblings via `BreadcrumbMenu` and `readDirectoryEntries`; directory entries
  expand lazily, files open in the active pane, and symlinks remain unavailable. Match Explorer's hidden-file
  filter. Obsolete reads cannot update a closed picker; keyboard selection and Escape stay within it.
- Project badge/label double-click opens the root folder; context actions use [git-ui.md](./git-ui.md).
  Explorer open-folder action is penultimate.
- On macOS TitleBar measures `data-explorer-project-label` to align the badge/path with the project name,
  accounting for UI scale. Resize observers release on teardown; hidden Explorer uses the 84px fallback.
- `isSymlink` comes from link metadata and all symlinks are leaves, even directory links. Single click, ⌘↓
  and pane drop reject open/expand with `error.fs.symlinkUnsupported`; rename/delete/move operate on the link.
  Double-click remains the tree gesture and its second click must not repeat open/toggle or switch chats.
- Preserve the settled chain during scrollbar motion and resolve visible chains at idle. Anchor by stable
  root+start row identity. Only a shrinking list stays pinned to the bottom; a growing list keeps the anchor
  so expansion extends downward, then clamp after row shrink to avoid blanks.
- Folder menus place Open terminal here directly after Ask Agent; if Agent is disabled, terminal comes
  first. Keep the same root/relative-directory target and existing symlink guards.

## Refresh contracts

- Rust owns debounce/batch limits. Refresh via fileIndex/workspace, Git via [git.md](./git.md), tabs via
  `refreshFromDisk`. Compare metadata before reads and bump matching `diffEpoch` to refresh diffs in place.
  Sync changed `isRepo` back to roots so terminal `git init` is noticed.
- Suppress pure `.git` batches; mixed worktree paths still refresh. While a root's optimistic Git index queue
  is pending, skip only the watcher's Git status request; the queue drain owns the authoritative refresh.
  Checkout/create uses `beginBranchTransition` plus a short grace period. Rescan/ignore changes always
  refresh.
- Git status changes never close a tab; only confirmed disk disappearance does. Preserve loaded page counts
  and unreadable caches; remove only confirmed missing subtrees. Directory versions and workspace lifetimes
  reject obsolete refresh, pagination, chain and expand-all results after collapse/reopen or root replacement.
- Worktree `.lock` files are watched; suppression applies only inside Git metadata. Roots are refcounted and
  reaping the last one releases Rust PTYs/watchers.

## Change map

Keep Rust watcher payloads, IPC and batching aligned; checkout/fetch also follows [git.md](./git.md).
Tests cover truncation, deadlines, ignore rules, cache races and empty states. Gate: [checks.md](./checks.md).
