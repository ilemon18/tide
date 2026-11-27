---
summary: Git workflow dialogs and configuration
scope:
  - .ai/git-ui.md
  - src/components/GitDialogs*.tsx
  - src/components/GitSettings*.tsx
  - src/components/GitBackground*.tsx
  - src/components/GitCommitHistory*.tsx
  - src/components/ProjectMenu*.tsx
  - src/lib/commitMessages*.ts
  - src/lib/commitMessageLimits.json
  - src-tauri/src/commands/git_ui.rs
  - src-tauri/src/commands/git_config.rs
  - src-tauri/src/commands/git_history.rs
  - src-tauri/src/commands/project_tools.rs
keywords:
  - git-settings
  - identity
  - remote
  - stash
  - merge
  - rebase
  - Git设置
  - 提交身份
  - 远程
  - 贮藏
---
# Git workflow UI

`git.rs`/store status and mutation queues: [git.md](./git.md). These dialogs reuse ContextMenu,
SettingsControls and theme tokens; backgrounds stay blocked while destructive calls run. Scope labels
distinguish global preferences, repository remotes and window-only identity. New captions need six locales.

## Commit and identity

Amend/skip-hooks default off and reset after success; ordinary calls retain Git's default behavior.
Only explicit skip-hooks enables `--no-verify`. Amend can edit a message without staged files. Identity
validation and limits belong to `git_ui.rs`; overrides use child-process arguments/environment, never
rewrite config. Temporary identity lives only in the window's Git store, survives project switches and
never enters settings export or cross-window broadcasts. Default identity reads Git's effective repository
configuration, including inherited/conditional global values; display the global identity separately.
The identity row keeps user/text left and dropdown right; temporary identity hints explain session scope.

Commit history mounts only while open, queries once per opening and releases on dismissal. Common messages
are global settings; project recents persist as one atomic compact snapshot. `commitMessageLimits.json`
owns the developer-requested 10 templates/5 recents plus read/byte limits for TypeScript and Rust. Deduplicate
full messages within recents and against templates; track recently used templates with bounded ordering
markers. Search/edit/remove reuse the popup; truncate display with full-message hints. Clearing the input
never mutates history. History-write failures report separately from an already successful commit.

## Branches and network

Targets are full validated refs, never unchecked revision/option strings. Branch create copies HEAD with
optional checkout. Local rename preserves worktree; remote rename publishes/deletes atomically with old-ref
lease and new-ref absence checks, then updates tracking. Local delete/force-delete reject the current branch;
Git protects branches occupied by other worktrees. Optional remote deletion uses a lease and reports partial
completion. Force push pins current HEAD and upstream OIDs and updates only that branch, without tags.

Merge/rebase preserve dirty buffers, serialize with index actions and refresh conflicts even on failure.
Pull fetches first without blocking editor input, then checks dirty buffers and locks only worktree integration
through stateCache/EditorHost Compartments. Swaps reapply/release the root lock without resetting undo.
Metadata-only actions refresh branches/status, never reload editors or rebuild the tree. Modal focus and
`data-shortcut-dialog` block background commands. Editor state/undo remain Compartment-owned.

## Project preferences and tools

`git_config.rs` owns a whitelist: merge.log/merge.ff/pull.rebase and Tide's auto-commit, refresh,
background-fetch and submodule-recursion keys. Read effective Git values and existing SourceTree project
preferences as fallback; each editable preference writes only its changed project-local key. Global config
editing stays in its own section. Preserve edited identity drafts on cache refresh;
settings mutations wait for index work and exclude background fetch.
Git config locks preserve unrelated records. Broadcast changes to refresh window caches, retaining temporary
identity. Background fetch defaults off; scheduling/limits belong to GitBackground/memoryBudget; tests guard disabled/busy scheduling and cleanup.
Auto-refresh disables automatic status scheduling; initial reads and explicit actions still refresh.

Remotes are repository-scoped CRUD. Config editing prepares the actual Git config path and grants only that
file to the editor. Remote browsing converts SSH/SCP to HTTP(S), strips credentials/query fragments and
uses an argument-based OS opener. Folder opening differs from Reveal; native terminals inherit the chosen
directory. `project_tools.rs` intentionally creates a visible Windows console for that explicit action.

## Stash

Stash prompts for a message. Pop pages the newest-first list (`git_ui.rs` owns page size), applies the chosen
immutable SHA, and drops only after success; conflicts retain the entry. App stash mutations serialize.
Clear stash is red and requires explicit confirmation. File-save suspension/refresh stays in the Git store.

Tests live beside owners; gate inventory: [checks.md](./checks.md).
