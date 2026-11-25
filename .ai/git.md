---
summary: Git actions, diffs and conflicts
scope:
  - .ai/git.md
  - src/store/git.ts
  - src/store/git.test.ts
  - src/store/commitHover*.ts
  - src/components/CommitHoverCard*.tsx
  - src/components/DiffView.tsx
  - src/components/DiffView.test.tsx
  - src/components/diffScroll.ts
  - src/components/diffScroll.test.ts
  - src/components/GitPanel*.tsx
  - src/components/BranchMenu.tsx
  - src/components/BranchMenu.test.ts
  - src/components/DiffRuler.tsx
  - src/components/diffHighlight.ts
  - src/lib/conflictFiles.ts
  - src/editor/conflicts.ts
  - src-tauri/src/commands/git.rs
  - src-tauri/src/paths.rs
  - src-tauri/src/proc.rs
keywords:
  - git
  - diff
  - checkout
  - branch
  - conflict
  - discard
  - 分支
  - 差异
  - 冲突
  - 丢弃
---
# Git, diff and conflicts

## Ownership

The Git store owns repo-local status/actions. Rust git commands own mutations; paths/proc own containment
and subprocess policy. DiffView/diffScroll own positioning; editor/conflicts owns resolution edits.

## Branches and refresh

- Stage / unstage / single-file discard apply an optimistic row move immediately, queue per root so index
  mutations never race `index.lock`, and coalesce the authoritative status into one refresh when the queue
  drains. These operations do not take the global busy lock. Commit / pull / push / fetch / undo / operation
  controls remain exclusive and wait for queued index work before mutating. A failed optimistic mutation
  toasts and lets that forced status restore the real rows.
- Branch dialog is 480px clamped to viewport with a scrolling list. Separate local/remote groups; empty
  search shows ten/group, current local pinned then newest commits (remote recency). Name search spans
  all cached branches, capped at 200 visible matches. Headings are visual; keyboard visits rows/create.
- Read NUL-delimited porcelain v2 once, never per file. Select active path/id, coalesce status refreshes,
  skip unchanged setState and respect branch-cache TTL. Fetch only refreshes branches/status; pure Git
  watcher batches must not rebuild tree or reload files/diffs. Mixed batches follow [file-tree.md](./file-tree.md).
- Refresh diffs via root and tab diffEpoch, only matching tabs for scoped paths; never close/recreate.
- Git rows single-click into their existing diff/worktree view; ignore the second click, then double-click
  or context-click opens the same repo-owned file menu. Inline buttons and completed drags cannot open it.
  Menu metadata is read lazily from the target parent, with obsolete responses discarded. Actual worktree
  existence/type controls file/Agent actions (including staged deletions with a replacement); respect
  agentEnabled and symlink restrictions. Directory placeholders get no file mutations. Reuse existing
  rename/delete/reveal flows and group-specific Git actions; wait for metadata before opening diffs,
  disable mutations while busy/loading or metadata is unreadable, keep
  path copies available, and close obsolete targets after status changes. Menus scroll within the viewport.

## Inline blame hover

- store/commitHover owns requests, hover intent and completed content. Share cached/in-flight details by
  structured root/SHA/path/original-line/current-line keys; use memoryBudget.commitDetails for LRU eviction.
  Foreground hover reads immediately and shares matching background reads; background prefetch is serial
  with only the latest waiting target. Prefetch failures remain silent and hover retries failures.
- CommitHoverCard appears only with a completed diff, empty-change result or error. Measure the full card
  invisibly before first paint; cached results enter synchronously. Keep the existing single-line snippet.
  Target/content updates are atomic so a new target never paints the previous target's snippet.
- Closing or leaving a pending hover invalidates its presentation immediately. Visible cards retain the
  200ms anchor-to-card grace period. Esc, external scroll, edits and file/line changes close pending/visible
  cards; internal scroll stays open. Request sequences reject stale presentation; clearCommitDetails also
  cancels queued prefetch and uses a generation to prevent late requests from refilling reclaimed caches.

## Bulk discard transaction

- useGit.discardAllChanges(root): after confirmation take a fresh snapshot, count restore/delete
  separately, optimistically hide changes/untracked, suppress watcher/focus refresh, suspend target saves
  with suspendFileSaves, and wait for in-flight writes.
- git_discard_changes validates every path, conflict, directory placeholder and Git category before any
  mutation. Category drift rejects the whole snapshot. Restore tracked files from index in one git restore
  (preserve staged content); probe untracked via git ls-files before unlinking, never recursive deletion.
  Stop at first failure; return processed paths plus optional coded error. Legacy git_discard stays single-file.
- Success closes deleted tabs and force-reloads restored tabs. Failed forced reload closes obsolete text
  tabs to prevent writeback. IPC failure restores the whole snapshot; partial backend failure restores only
  unprocessed rows. Status refresh waits for older requests.

## Diff and conflict contracts

- Compare against /dev/null only for untracked files (is_tracked). Empty unstaged worktree=index or staged
  index=HEAD becomes a normal tab with scroll preserved. Deleted/folder/oversized paths close only the diff.
- memoryBudget.diffRows and git_diff_full both bound large diffs; profile generated files before raising limits.
- Synchronize latest real input per axis/frame; detect echoes from actual/clamped offsets, never drop all
  frame-locked events. Narrow-pane vertical movement must not reset the other pane's horizontal position.
- First-change/overview/restore share diffScroll.jumpTo and cancel queued sync. Capture refresh progress
  immediately before response application so intervening input wins. Scroll/ruler/fold invalidates restores;
  settle before folding. Cancel old layout/tab/restore callbacks on replacement/unmount. Only the overview
  viewport slider updates during scrolling; coalesce measurements/frame.
- conflictFiles skips IPC without markers; with markers use loaded status unless stale, then git ls-files -u.
  Terminal cherry-pick can stale status. Conflict accepts preserve scrollDOM scrollTop/Left through
  view.requestMeasure and never set scrollIntoView=true.

## Subprocess and path boundaries

- Use git -C root, GIT_TERMINAL_PROMPT=0, GIT_OPTIONAL_LOCKS=0, disabled editors/pager, LC_ALL=C, closed stdin.
  A workspace root containing `.git` resolves toplevel/gitdir without spawning rev-parse; worktree/submodule
  gitdir files are parsed, and only subdirectory/bare cases fall back to git. Read-only probes use a short
  10ms wait poll; network gets proc.rs's longer timeout; checkout itself never uses the short deadline.
- Undo last commit returns its message plus a fresh status when readable, avoiding a second status
  round-trip; a null status makes the frontend fall back to refresh.
- Shared component comparison equates Windows drive/verbatim and UNC/verbatim-UNC roots; never globally
  strip verbatim prefixes. Errors and relative IPC paths follow [context.md](./context.md).

## Change map and verification

Coordinate Git snapshots, tab save suspension and watcher transitions. Diff tests protect axes, echoes,
refresh input, folds and cancellation; Rust tests protect path/mutation/subprocess invariants. Native scroll
smoothness needs an explicit manual request. Gate policy: [checks.md](./checks.md).
