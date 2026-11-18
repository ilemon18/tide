# Traps & data flows

Load this when changing the editor, the file tree, Git/diff, window lifecycle or settings. Each line is
something that already cost a debugging session.

## Data flows

**Open a file**: `FileTree` → `useTabs.openFile(root, rel)` → `api.readTextFile` → `editor/openState`
builds the `EditorState` (size tier + lazy language pack import) → `view.setState` → cursor/scroll
restored by `editor/scrollMemory`.

**Save**: CodeMirror change → autosave debounce (800ms, 1500ms for the large tier) → `useTabs.save` → restore
`\n` to `\r\n` per `tab.eol` → `api.writeTextFile` → temp file + rename → `dirty = false` → optional
format when `formatMode` is `onSave`.

**Startup**: `App` renders only a themed background until `hydrated` (the startup effect's `finally`),
with a 1.5s fallback. Restoring paints in several steps (project → root dir → folder chain → tabs), and each
one used to be a visible pop. So: restore paths must commit once (expanded folders and tabs are batch
committed), and nothing may render before the gate that would need the session.
**Lazy tabs**: a restored tab is only a `stat` — no content read, no `EditorState`. `editor/openState`
reads the file when the tab is activated and fills in `eol` / indent through `applyRestoredMeta`; until
then `tab.eol` is undefined, which is safe because a tab without an EditorState cannot be saved.

**Editing session**: tab add/remove/switch → `lib/editorSession` debounces 1.2s → `save_open_tabs`
(separate from the layout fields). At startup `restoreEditorSession` only restores files and cursors
when the current project equals the last project.

**External change**: `src-tauri/src/watcher.rs` (300ms debounce, ≤32 paths) → `fs:changed` →
`src/store/watcher.ts` → refresh directory / refresh Git (350ms; if `isRepo` changed, sync it back to the
workspace root so `git init` in the terminal is noticed) / `refreshFromDisk` (400ms; compares mtime +
size first, then re-pulls diff tabs in place by bumping `diffEpoch`). **Never close a tab because of a
git status change** — only a file that really vanished from disk gets closed. The one exception is a
diff tab whose diff turned empty: it has nothing left to show and becomes the file tab instead.
During an explicit checkout/create, `beginBranchTransition` suppresses the watcher's duplicate `.git`
batch while the command refreshes status, branches, the tree and open files in the background. The busy
state clears as soon as checkout succeeds; the transition keeps a short grace window so the watcher's
350ms debounce cannot immediately repeat the same scans.

## Editor & tabs

- TabBar uses intrinsic tab widths capped at 220px (including icon and action slots). A ResizeObserver
  measures tabs and the viewport for absolute positioning, drag centers and active-tab visibility;
  140px is only an initial position estimate. Never write measured widths back to the tabs. The 36px
  bar gives 28px pills vertical shadow space; active tabs stack above normal tabs, dragged tabs above both.
- Tab kinds are `file | diff | image | welcome | settings | untitled | chat`. `diff` and `image` have no
  `EditorState`; `welcome` and `settings` are virtual tabs (`root` empty): they are not written to the
  layout session, do not enter `closedTabs`, and get no state. `untitled` does have a state but no file:
  its text is seeded through `takeUntitledSeed` on the first build, it is mirrored into localStorage for
  hot exit (`lib/untitledDrafts.ts`), and ⌘S goes through `saveAs` instead of writing. Adding a kind means
  touching `editor/openState.ts`, `tabs.activate`, the filter in `lib/editorSession.ts`, and TabBar's
  icon/title, and (for chat) `lib/agentSession.ts` for restore plus `AgentChat` in `EditorHost`.
- **Temporary preview tabs**: ordinary `openFile` file/image opens set `temporary: true`; the title is
  italic while the icon, close button and pill styling stay unchanged. A successful open replaces the
  target pane's single clean, unpinned temporary file/image tab in place; it does not replace tabs in
  another pane, and a failed read leaves the current preview untouched. The replaced tab's state,
  scroll/cursor, autosave and blame cache are released only when no other pane still shows it; it never
  enters `closedTabs`. First document change, double-click, pin, drag-threshold crossing, split and
  explicit preserves (drag to pane, save-as, diff-to-file, reopen) call `promoteTab`; undoing an edit
  must not make it temporary again. Restored and non-file virtual tabs are always non-temporary.
  Double-click promotes a tab; "Close others" remains available only from the context menu.
- CodeMirror documents are always `\n` internally: **every write path must restore `tab.eol`**, or a CRLF
  file is rewritten whole and the diff becomes the entire file.
- Indent/newline are per file (`tab.indentSize` / `tab.useTabs` / `tab.eol`); `settings.tabSize` is only
  the fallback when detection found nothing.
- **Structure outline** walks the Lezer tree, not the text: a declaration is a leaf unless it is a container
  (class / struct / interface / module). Descending into function bodies would list locals. `ensureSyntaxTree`
  is forced only under 512KB, so a very large file may show a viewport-only tree.
- A diff tab is re-pulled by `useTabs.diffEpoch[root]` plus `diffEpoch[tab.id]`, not by closing and
  recreating it. Path-scoped refreshes bump only matching tabs (including the file's diff ruler).
- Editor DOM built by extensions (conflict buttons, inline blame, fold arrows) does not re-render with
  React: a locale switch must dispatch `localeEffect` from `src/editor/locale.ts`, and the unsubscribe
  function from `watchLocale` has to be wired into the plugin's `destroy()`.

## Agent

**Entry → tab**: title-bar button, explorer double-click / context menu
(`e.detail > 1` suppresses the second row click) or the palette → `useAgent.newChat`,
which creates `chats[chatId]`, opens a `kind: 'chat'` tab and seeds any
`@file` / `@folder` mention into the composer draft. Sending runs `agent_send`
(headless CLI in the workspace root). One turn per chat, four at once.

**Interject**: sending during a turn appends to a per-chat FIFO (`queues` in the store),
not the running stdin. `done` drains one message as the next turn; Stop also drains, so
“send now” = queue + Stop. Auto-drained turns must not clear a draft typed meanwhile.

**CLI config wins**: an empty model / effort sends no `--model` / `--effort` flag, so a
custom Codex provider or model in the user config still applies. Never auto-select a catalog model,
and a per-chat pick must not rewrite the global default (that would override their config forever).

**Streaming**: Rust parses JSONL into `agent:event` (session / textDelta / tool* / done), coalesces
text every 24ms, and the store reducer appends by item id. `done` writes the transcript; Stop,
window close, app exit and disabling the setting kill the process group.

**Persistence**: `agent/chats/<id>.json` (opaque frontend JSON) and `agent/tabs.json`; both flush
on `app:hidden`. Closing a chat tab stops its turn and keeps the file.

## File tree

- Opening/locating a file must expand the folder chain through `workspace.expandChain` (parallel fetch,
  one state write). Looping `await expandDir` makes directories pop open level by level, which reads as
  lag.
- A merged row (`compactFolders`) stands for the deepest directory in the chain: expand / context menu /
  rename / delete all act on it, intermediate levels have no row. When its content changes call
  `folderChain.invalidate(root, dir)`, or the chain keeps showing the old shape. The chain probe must use
  the same filter as the tree (only `.DS_Store` and dot-entries are skipped).
- Switching tabs only scrolls the row of "the directory containing the current file" into view (the
  `followed` ref) and does **not** change expansion. Follow a file once, or row rebuilds fight the user's
  scrolling.
- Virtual scrolling: when the row count shrinks (compaction, collapse, refresh) clamp `scrollTop` back to
  `rows.length * ROW_H - clientHeight`, otherwise absolutely positioned rows sit past the new content
  height and inflate the scroll range (symptom: lots of empty scrollable space, a tiny scrollbar thumb).
  Clamp again in the render window with `maxScroll`.

## Git & diff

- The Changes group displays `changes` followed by `untracked`; only the UI maps `?` to a green `A`.
  Stage all includes both lists. `useGit.discardAllChanges(root)` snapshots both categories before one
  dangerous confirmation with separate restore/delete counts. `api.gitDiscardChanges` /
  `git_discard_changes` validates all paths, conflicts, directory placeholders and current Git categories
  before mutation; changed categories reject the whole snapshot. Tracked files restore from the index
  (staged content survives); only explicitly listed untracked files/symlinks are deleted, never directories.
  Processing stops at the first failure and returns restored/deleted paths plus an optional coded error.
  Legacy `api.gitDiscard` / `git_discard` retains its single-file behavior.
- Bulk discard suspends target saves (`suspendFileSaves` in `store/tabs.ts`), cancels queued autosaves,
  invalidates pending on-save formatting and waits for in-flight writes. Watcher reloads skip suspended
  files. Successful deletions close matching tabs; successful restores force-reload exact paths across
  panes. If a forced reload fails, the obsolete text tab is closed so it cannot write discarded content
  back later. Only failed/unprocessed paths resume autosave, retaining their editor contents. Git status
  refresh waits for older requests before rereading. Regression tests live in `commands/git.rs` and run
  only through the user-triggered verification / release gate.
- An empty diff is not a new file: the "compare against /dev/null" fallback in `git_diff` /
  `git_diff_full` is only for **untracked** files (`is_tracked`). Otherwise an untouched file renders as
  a full-height green add bar.
- An empty diff is not a dead tab: an unstaged tab (worktree == index) and a staged tab (index == HEAD
  after a commit / `git add`) is replaced by the normal file tab, which keeps the reader's relative
  scroll position (`switchDiffToFile` in the tabs store hands a ratio over through `scrollMemory`). If the
  file cannot be opened as text (deleted, folder, too large) only the diff tab is closed; no
  "no changes in the index" notice remains. `pendingScroll` still restores in-place diff refreshes.
- Conflict detection is two-stage (`lib/conflictFiles.ts`): no `<<<<<<<` in the content means no IPC at
  all; the git status cache is used when loaded, and only files that really contain markers ask the
  backend (`git ls-files -u`), because status can be stale right after a cherry-pick in the terminal.
- Git runs as a subprocess: `git -C <root>` with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
  editors/pager disabled, `LC_ALL=C`, stdin closed. Read-only `status` / `branches` / `repo_paths` probes
  and checkout's existence / branch-name preflights use a 20s deadline so a stuck index cannot leave the
  UI loading forever; network operations keep the 180s timeout. Do not add the short deadline to checkout
  itself, because killing it can leave the worktree half-switched.
- Large diffs are bounded twice: `memoryBudget.diffRows()` caps frontend rows/parsing (3k normal,
  1.5k light), and `git_diff_full` switches files over 1MB to `-U3`, then cuts the patch at 512KB.
  Do not raise these thresholds without profiling a generated-file diff.
- Conflict accept actions must preserve the viewport: `editor/conflicts.ts` records
  `scrollDOM.scrollTop/Left` and restores them with `view.requestMeasure`; never add
  `scrollIntoView: true` to a resolve transaction. Per-line accepts move the line above the block in
  click order and leave the remaining markers in place.

## Window & memory

- Terminal `Cmd/Ctrl +/-` character input must pass through App's capture-phase handler before
  TerminalView can send it to the PTY. Outside the terminal those keys still adjust editor font size.

- macOS reserves the left 92px for native traffic lights. Windows and Linux use `decorations(false)`, so
  they must not reserve that macOS-only inset; `TitleBar` draws the drag region and right-side
  minimize/maximize/close buttons instead. The window commands are gated by the matching
  `core:window:allow-*` capabilities in `src-tauri/capabilities/default.json`.

- Fonts follow the display density: `lib/displayScale.ts` watches the window's scale factor, and the
  stylesheet only applies `-webkit-font-smoothing: antialiased` at 1.5dppx and above. On a 1x screen the
  terminal also uses a heavier weight. Put new density compensations there, not per component.
- Closing the main window on macOS is a hide, not a quit: `prevent_close`, then destroy after ~180ms so
  the frontend can flush settings and session. The frontend must respond to `app:hidden` by releasing
  memory.
- `WindowEvent::Destroyed` is where PTYs and workspace grants are reaped for that window — the frontend
  cannot call `close_folder` anymore at that point.
- A window owns exactly one project. Multiple projects = multiple windows (`main` + `win-<pid>-<seq>`,
  project passed as `?open=<path>`).
- `app:open-file` is emitted by Rust on a second launch with a file argument, but nothing listens to it
  yet: the file is not revealed, only the project opens.

## Config & settings

- Default settings live in two places and must match: `DEFAULT_SETTINGS` in `src/store/settings.ts` and
  `Settings::default` in `src-tauri/src/commands/theme.rs`. A fresh install reads the Rust one
  (`schemaVersion` 0 → frontend migrates → writes back), after that `settings.json` wins.
- A new setting missing from `SHARED_KEYS` shows up as "the other window does not update".
- Retiring a setting means deleting it from both types, `DEFAULT_SETTINGS` and `Settings::default`, and
  adding the old key to `RETIRED_KEYS` in `src/store/settings.ts` — otherwise it is treated as an unknown
  field and written back forever.
- Unknown fields from a newer version are preserved on purpose; do not "clean them up".

## Build

- Port 1420 in `vite.config.ts` must match `devUrl` in `tauri.conf.json`.
- The build target is `safari15` (WKWebView). Newer syntax needs a fallback.
- `src/assets/fileIcons.generated.ts` comes from `scripts/build-file-icons.mjs`; `src/vendor/prettier/`
  is a vendored standalone build — do not hand-edit either.

---
**Last updated**: 2026-11-18
