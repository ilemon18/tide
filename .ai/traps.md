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
git status change** — only a file that really vanished from disk gets closed.

## Editor & tabs

- Tab kinds are `file | diff | image | welcome | settings | untitled`. `diff` and `image` have no
  `EditorState`; `welcome` and `settings` are virtual tabs (`root` empty): they are not written to the
  layout session, do not enter `closedTabs`, and get no state. `untitled` does have a state but no file:
  its text is seeded through `takeUntitledSeed` on the first build, it is mirrored into localStorage for
  hot exit (`lib/untitledDrafts.ts`), and ⌘S goes through `saveAs` instead of writing. Adding a kind means
  touching `editor/openState.ts`, `tabs.activate`, the filter in `lib/editorSession.ts`, and TabBar's
  icon/title.
- CodeMirror documents are always `\n` internally: **every write path must restore `tab.eol`**, or a CRLF
  file is rewritten whole and the diff becomes the entire file.
- Indent/newline are per file (`tab.indentSize` / `tab.useTabs` / `tab.eol`); `settings.tabSize` is only
  the fallback when detection found nothing.
- A diff tab is re-pulled by `useTabs.diffEpoch[root]`, not by closing and recreating it.
- Editor DOM built by extensions (conflict buttons, inline blame, fold arrows) does not re-render with
  React: a locale switch must dispatch `localeEffect` from `src/editor/locale.ts`, and the unsubscribe
  function from `watchLocale` has to be wired into the plugin's `destroy()`.

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

- An empty diff is not a new file: the "compare against /dev/null" fallback in `git_diff` /
  `git_diff_full` is only for **untracked** files (`is_tracked`). Otherwise an untouched file renders as
  a full-height green add bar.
- Conflict detection is two-stage (`lib/conflictFiles.ts`): no `<<<<<<<` in the content means no IPC at
  all; the git status cache is used when loaded, and only files that really contain markers ask the
  backend (`git ls-files -u`), because status can be stale right after a cherry-pick in the terminal.
- Git runs as a subprocess: `git -C <root>` with `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`,
  editors/pager disabled, `LC_ALL=C`, stdin closed; 180s timeout for network operations.

## Window & memory

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
**Last updated**: 2026-11-16
