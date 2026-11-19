# File tree and workspace refresh

**Load when:** changing folder expansion/location, merged folder chains, tree virtualization, workspace
watching, or synchronization between disk, tree, Git and open tabs.
**Code:** `src/components/FileTree.tsx`, `src/store/{workspace,fileIndex,folderChain,watcher}.ts`,
`src-tauri/src/commands/fs.rs`, `src-tauri/src/watcher.rs`.

## Expansion and locating

- Opening or locating a file expands its folder chain through `workspace.expandChain`, which fetches
  levels in parallel and commits once. Do not loop `await expandDir`; incremental commits cause visible
  pop-in.
- When `compactFolders` is enabled, a merged row represents the deepest directory in the chain.
  Expand/collapse, context-menu actions, rename and delete all target that row; intermediate directories
  have no row. Call `folderChain.invalidate(root, dir)` whenever its content changes, or the chain keeps
  displaying the old shape.
- The chain probe and tree must use the same entry filter. The only special exclusions are `.DS_Store` and
  dot-entries when hidden files are off; changing one side without the other makes compacted folders
  disagree with expanded content.
- Switching tabs scrolls only the row for the directory containing the current file into view through the
  `followed` ref; it does not alter expansion. Follow a file once, or row rebuilds fight user scrolling.
- `resolve_dir_chain` in Rust and `buildRows` in the component are one contract. Keep chain resolution
  limited to visible rows and respect the bounded depth/concurrency/cache settings beside the
  implementation; never eagerly resolve every folder.

## Virtual scrolling

- While the scrollbar is moving, keep the last settled folder-chain snapshot and defer visible-chain
  resolution until scroll idle. Applying async results mid-scroll changes row count under the thumb and
  causes flicker or snap-back.
- When the snapshot changes, anchor the row under the viewport by stable `root + start` identity, or stay
  at the bottom when already there. Identity based on visible row index is not stable across compaction.
- When row count shrinks (compaction, collapse, refresh), clamp `scrollTop` to the new content height.
  Clamp again in the render window using the current `maxScroll`. Otherwise absolutely positioned rows
  retain the old scroll range and produce empty space with a tiny scrollbar thumb.
- Treat row height as shared layout data, not an estimate scattered across handlers. Pointer drag
  hit-testing may measure geometry; ordinary scrolling should not call `getBoundingClientRect()`.

## Watcher and state synchronization

- `src-tauri/src/watcher.rs` batches relevant path changes and emits `fs:changed`; the frontend watcher
  store coordinates directory refresh, Git status refresh, and disk reload. Keep the debounce and path
  batching bounded in the watcher implementation rather than duplicating timing constants here.
- Refresh directories through the file index/workspace APIs, refresh Git through [git.md](./git.md), and
  reload open tabs through `refreshFromDisk`. Compare metadata before re-reading; for diff tabs, bump the
  appropriate `diffEpoch` to refresh in place.
- If a status refresh discovers that `isRepo` changed, sync that result back to the workspace root so a
  terminal `git init` is noticed.
- A fetch only updates remote-tracking refs. Suppress its pure `.git` watcher batch so it cannot invalidate
  folder chains or rebuild the expanded tree; worktree paths in the same batch still refresh normally.
- **Never close a tab because Git status changed.** Close only a file that really vanished from disk. The
  one conversion exception is an empty diff tab: Git/diff logic may replace it with the normal file tab.
  If the file is no longer openable as text, close only the diff tab.
- During an explicit checkout/create, `beginBranchTransition` suppresses the watcher's duplicate `.git`
  batch while the command refreshes status, branches, tree and open files. Clear busy immediately after
  checkout succeeds, but retain a short grace window so the watcher debounce cannot repeat the same scans.
- Workspace roots are refcounted. Removing the last reference reaps its PTY and watcher resources in Rust;
  do not model workspace lifetime only in the frontend.

