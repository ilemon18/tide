---
summary: Git actions, diffs and conflicts
scope:
  - .ai/git.md
  - src/store/git.ts
  - src/store/git.test.ts
  - src/store/blame.ts
  - src/store/blame.test.ts
  - src/store/commitHover*.ts
  - src/components/CommitHoverCard*.tsx
  - src/components/AgentTurnChanges*.tsx
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
  - src-tauri/src/commands/blame.rs
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

Git store owns status/actions; Rust owns mutations, paths and processes. DiffView/diffScroll position views;
`editor/conflicts` resolves edits.

## Status and actions

- Stage/unstage/single-file discard move rows optimistically, queue per root so index mutations never race
  `index.lock`, and coalesce status into one refresh. They skip the global busy lock; commit/pull/push/fetch/
  undo/operation controls stay exclusive and wait for queued index work.
- Read NUL-delimited porcelain v2 once; coalesce status, skip unchanged `setState`, respect branch-cache TTL
  and refresh diffs through root/tab `diffEpoch` without closing tabs. Fetch refreshes only branches/status;
  pure Git watcher batches must not rebuild the tree or reload files. Mixed batches:
  [file-tree.md](./file-tree.md).
- Git rows single-click into their diff; double/context-click opens the file menu with lazy metadata.
  Respect Agent/symlink rules; placeholders get no mutations.
- Hover actions share centered 18px slots, with a 2px inset from the right edge. `Icon` owns optical glyph
  alignment; disabled controls retain hints and use not-allowed rather than suppressing pointer events.

## Blame and discard

- `git_blame(root, rel, contents, version)` is content-aware: open / save / watcher read the file on disk,
  while a dirty buffer uses `blame --contents -` after the editor-owned idle delay. Request sequence
  numbers and the result `version` drop stale answers, so a shifted line never keeps the old commit. Disk
  results cache by `root|rel|mtime` under `memoryBudget.blameEntries`; buffer results stay on their tab.
  Porcelain maps `filename` to `origPath` (the rename-aware diff target) and keeps `previous`; 40/64-digit
  SHAs and all-zero uncommitted rows are parsed. `stateCache` applies results; editor scheduling:
  [editor.md](./editor.md).
- `store/commitHover` owns hover intent and completed content: details cache by `root|sha`, file diffs by
  `root|sha|path` (all hunks; the card renders only the added target line) under `memoryBudget.commitDetails`.
  Diff requests use blame's commit path and never fall back to a nearby hunk; an uncommitted row uses its own
  working-tree diff. Foreground reads immediately; background prefetch is serial with only the latest target;
  failures stay silent. Clicking a change bar selects the line and opens the commit card, including uncommitted rows.
- `discardAllChanges` confirms, snapshots, hides changes optimistically, suppresses refresh and suspends
  saves. `git_discard_changes` validates every path, conflict, placeholder and Git category before mutation;
  drift rejects the snapshot. Tracked files restore from the index; untracked files are probed with
  `git ls-files` before unlinking. Stop at first failure and return processed paths plus a coded error.
  IPC failure restores the snapshot; partial failure restores only unprocessed rows.

## Stash, reset and undo

- `stashChanges` saves dirty project files (never untitled), suspends saves, then runs `git stash push`
  (tracked only). `popStash` applies a selected SHA without `--index`, drops it only on success; conflicts retain it. `resetAll` confirms and runs `git reset --hard HEAD`: tracked changes are discarded, untracked files
  stay. Reset without HEAD reports `git.noCommitToReset`.
- `turn_snapshot` copies `<gitdir>/index`, reads its tree, then builds a worktree baseline with
  `GIT_INDEX_FILE=<tmp> git add -A -- .` plus `git write-tree`, leaving the real index/worktree untouched.
  `turn_changes` diffs the two worktree trees; committed agent work still appears and HEAD/index are never
  compared. `git_turn_revert` preflights targets, deletes created files first, writes baseline blobs
  atomically with the exec bit, prunes emptied dirs and restores index entries from the baseline tree.
  Pruned baselines fail with `git.turnSnapshotMissing`; undo restores only listed rows and never rewrites
  commits. Card contract: [agent.md](./agent.md).

## Diff, conflict and process rules

- Compare against `/dev/null` only for untracked files; empty worktree=index or index=HEAD becomes a normal
  tab with scroll preserved. `memoryBudget.diffRows` and `git_diff_full` bound large diffs. Synchronize input per axis/frame and detect echoes from actual
  offsets. Conflicts skip IPC without markers, then use loaded status unless stale. Block conflict actions
  use `StateField` decorations, never a `ViewPlugin` decoration set.
- Use `git -C root`, `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, disabled editors/pager, `LC_ALL=C` and
  closed stdin. Resolve `.git` roots without `rev-parse` when possible; probes use a short poll, network uses
  the longer timeout, and checkout never uses the short deadline. Paths preserve Windows verbatim/UNC semantics; IPC: [context.md](./context.md).

## Workflow UI

[git-ui.md](./git-ui.md) owns branch dialogs/config/identity/stash selection. File groups support Shift range
and Ctrl/Cmd additive selection; highlighting never changes staging. Row checkboxes stage/unstage only that
file; group checkboxes operate on all real files in that group, excluding directory placeholders. Bulk
conflict resolution stays disabled. Context actions snapshot only their group; multi-selection disables
path/name copying. Discard restores from index;
Remove deletes worktree files preserving index; Ignore adds escaped untracked paths atomically. Preflight
all targets; partial deletion closes only completed tabs, resumes saves only for unprocessed paths.

## Change map

Gate: [checks.md](./checks.md).
