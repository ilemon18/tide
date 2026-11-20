---
summary: Git actions, diff views, conflicts and bulk discard
scope:
  - src/store/git.ts
  - src/components/DiffView.tsx
  - src/components/GitPanel.tsx
  - src/components/DiffRuler.tsx
  - src/components/diffHighlight.ts
  - src/lib/conflictFiles.ts
  - src/editor/conflicts.ts
  - src-tauri/src/commands/git.rs
  - src-tauri/src/paths.rs
  - src-tauri/src/proc.rs
---
# Git, diff and conflicts

## Lifecycle

- Keep status repo-local and subscribe only to the active path/id needed for highlighting. Read porcelain v2
  status once, NUL-delimited, rather than shelling out per file; coalesce refreshes, skip `setState` when data
  is unchanged, cache branch metadata with the store TTL.
- Fetch refreshes branches and status only: it does not touch the worktree, so it must not rebuild the
  explorer tree or refresh open file/diff contents, and its metadata-only watcher batch is suppressed.
- A diff tab refreshes by bumping `useTabs.diffEpoch[root]` plus the tab's `diffEpoch`, never by closing and
  recreating it, and a path-scoped refresh bumps only matching tabs.

## Bulk discard and save safety

`useGit.discardAllChanges(root)` is a destructive multi-file snapshot operation: after confirmation take a
fresh snapshot, compute separate restore/delete counts, hide `changes`/`untracked` optimistically, suppress
watcher and focus refreshes, and suspend target saves (`suspendFileSaves` in `store/tabs.ts`) while waiting
for in-flight writes.

`api.gitDiscardChanges` / `git_discard_changes` validates every path, conflict state, directory placeholder
and Git category before mutating, and a category change rejects the whole snapshot: tracked files are restored
from the index in one `git restore` (staged content preserved), untracked ones are probed with `git ls-files`
before unlinking, never by recursive directory delete. Stop at the first failure and return processed paths
plus an optional coded error; the legacy `api.gitDiscard` / `git_discard` keeps single-file behavior.

On success, close tabs for deleted paths and force-reload restored ones, and a failed forced reload closes
the obsolete text tab so it cannot write discarded content back. An IPC-level failure restores the whole
snapshot, a partial backend failure only unprocessed rows, and status refresh waits for older requests.

## Diff semantics

- An empty diff does not mean a new file: the “compare against `/dev/null`” fallback is only for **untracked**
  files (`is_tracked`). An empty unstaged tab whose worktree equals the index, or staged tab whose index
  equals HEAD, becomes the normal file tab and keeps its scroll; a deleted path, folder or oversized file
  closes only the diff tab.
- Large diffs are bounded twice: `memoryBudget.diffRows()` limits frontend rows/parsing and `git_diff_full`
  truncates oversized patches. Do not raise either bound without profiling generated-file diffs.

## Conflicts and subprocess

- Detection is two-stage in `src/lib/conflictFiles.ts`: content without a marker needs no IPC, and with a
  marker the loaded status cache is used unless it may be stale — only files that really contain markers ask
  the backend (`git ls-files -u`), because status can be stale right after a terminal cherry-pick.
- Conflict accepts preserve viewport position: `editor/conflicts.ts` records `scrollDOM.scrollTop/Left` and
  restores them with `view.requestMeasure`, and a resolve transaction never gets `scrollIntoView: true`.
- Git runs as `git -C <root>` with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, editors and pager
  disabled, `LC_ALL=C` and stdin closed. Read-only probes and checkout preflight use a short deadline; network
  operations use the longer timeout in `proc.rs`, and checkout itself never gets the short deadline.
- Windows containment treats `C:\...` and `\\?\C:\...`, plus `\\server\share` and `\\?\UNC\server\share`, as
  the same root in the shared path-component comparison, not by stripping verbatim prefixes globally. Return
  `AppResult<T>` with coded `AppError::c` / `AppError::p` for UI failures, and keep paths workspace-relative
  at the IPC boundary.