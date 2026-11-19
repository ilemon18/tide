# Git, diff and conflicts

**Load when:** changing Git status/actions, diff tabs or highlighting, conflict detection/resolution,
bulk discard, Git subprocess behavior, or path containment.
**Code:** `src/store/git.ts`, `src/components/{DiffView,GitPanel}.tsx`, `src/lib/conflictFiles.ts`,
`src-tauri/src/commands/git.rs`, `src-tauri/src/{paths,proc}.rs`.

## Git lifecycle

- The Changes view renders `changes` followed by `untracked`; only the UI maps untracked status to the
  green `A` badge. “Stage all” includes both lists.
- Keep Git status repo-local and subscribe only to the active path/id needed for highlighting. Use one
  NUL-delimited porcelain-v2 status read instead of shelling out per file; coalesce refreshes, skip
  `setState` when data is unchanged, and cache branch metadata with the TTL in the store.
- Git file lists use fixed-height virtualization and a small overscan. Cache each list's body offset and
  refresh it from a content `ResizeObserver`/layout version. Scrolling must not measure rows with
  `getBoundingClientRect()`; pointer drag hit-testing is the exception. Create row actions only after
  hover/focus.
- A diff tab refreshes by bumping `useTabs.diffEpoch[root]` plus the tab's `diffEpoch`, not by closing and
  recreating it. Path-scoped refresh bumps only matching tabs, including the file's diff ruler.

## Bulk discard and save safety

- `useGit.discardAllChanges(root)` is a destructive multi-file snapshot operation. After confirmation,
  take a fresh snapshot and calculate separate restore/delete counts. Hide `changes` and `untracked`
  optimistically while the bulk operation runs and suppress watcher/focus refreshes for that window.
- `api.gitDiscardChanges` / `git_discard_changes` validates every path, conflict state, directory
  placeholder and current Git category before mutation. A category change rejects the whole snapshot.
  Tracked files are restored from the index in one `git restore`, preserving staged content. Probe all
  explicitly listed untracked files/symlinks with `git ls-files` before unlinking; never recursively
  delete a directory. Stop at the first failure and return processed paths plus an optional coded error.
  The legacy `api.gitDiscard` / `git_discard` retains single-file behavior.
- Before starting, suspend target saves (`suspendFileSaves` in `store/tabs.ts`), cancel queued autosaves,
  invalidate pending on-save formatting, and wait for in-flight writes. Watcher reloads skip suspended
  files.
- On success, close tabs for deleted paths and force-reload exact restored paths across panes. If a forced
  reload fails, close the obsolete text tab so it cannot write discarded content back. Resume autosave
  only for failed/unprocessed paths, which retain their editor contents.
- An IPC-level failure restores the complete snapshot; a partial backend failure restores only unprocessed
  rows. Git status refresh must wait for older requests before rereading. Regression tests live in
  `src-tauri/src/commands/git.rs`; execution is user-triggered.

## Diff semantics

- An empty diff does not mean a new file. The “compare against `/dev/null`” fallback is only for
  **untracked** files (`is_tracked`); otherwise an untouched file renders a full-height add bar.
- An empty diff is not a dead tab. An unstaged tab whose worktree equals the index, or a staged tab whose
  index equals HEAD after commit/add, becomes the normal file tab. Preserve relative scroll through the
  tabs store and `scrollMemory`. If the path is deleted, a folder, or too large for text, close only the
  diff tab and leave no stale “no changes” notice. `pendingScroll` still restores in-place refreshes.
- Large diffs are bounded twice: `memoryBudget.diffRows()` limits frontend rows/parsing, and
  `git_diff_full` truncates oversized patches. Do not raise either bound without profiling generated-file
  diffs.

## Conflict detection

- Detection is two-stage in `src/lib/conflictFiles.ts`: content without a conflict marker needs no IPC.
  When a marker exists, use the loaded Git status cache unless it may be stale; only files that really
  contain markers ask the backend (`git ls-files -u`). Status can be stale immediately after a terminal
  cherry-pick, so do not rely on it alone to decide conflict state.
- Conflict accept actions must preserve viewport position. `editor/conflicts.ts` records
  `scrollDOM.scrollTop/Left` and restores them with `view.requestMeasure`; never add
  `scrollIntoView: true` to a resolve transaction. Per-line accepts move the line above the block in click
  order and leave remaining markers in place.

## Subprocess, paths and errors

- Git runs as `git -C <root>` with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, editors and pager
  disabled, `LC_ALL=C`, and stdin closed. Do not let Git prompt or inherit a user editor/pager.
- Local read-only probes and checkout preflight checks use a short deadline so a stuck index cannot leave
  the UI loading forever. Network operations use the longer timeout in `proc.rs`. Do not apply the short
  deadline to checkout itself: killing checkout can leave the worktree half-switched.
- Windows containment must treat `C:\...` and `\\?\C:\...`, plus `\\server\share` and
  `\\?\UNC\server\share`, as the same root. Implement this in the shared path-component comparison rather
  than stripping verbatim prefixes globally, which can change path semantics.
- Return `AppResult<T>` with coded `AppError::c` / `AppError::p` for UI failures; raw Git output is only for
  external-tool detail. Paths remain workspace-relative at the IPC boundary.

