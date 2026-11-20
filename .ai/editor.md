# Editor, tabs and Markdown

**Load when:** changing file opening/saving, session restore, tab behavior, Markdown preview, or CodeMirror
state/extensions.
**Code:** `src/store/tabs.ts`, `src/components/{EditorHost,TabBar}.tsx`, `src/editor/`,
`src/lib/{editorSession,markdown,untitledDrafts}.ts`.

## Open, save and restore

- **Open:** `FileTree` → `useTabs.openFile(root, rel)` → `api.readTextFile` → `editor/openState` picks the
  size tier and lazily imports language support → `view.setState` → `editor/scrollMemory` restores
  cursor/scroll. A failed read must not replace or close the current tab.
- **Symlinks:** `stat_file`, `read_text_file` and `read_image_file` reject a final symlink component with
  `fs.symlinkUnsupported`, including Quick Open, Agent mentions and Markdown image paths. Check workspace
  containment first, so an escaping link still reports `path.outsideWorkspace`; the file tree blocks tree
  opens before a tab is created.
- **Save:** a change marks the tab dirty and autosave calls `useTabs.save` → restores `tab.eol` →
  `api.writeTextFile` (atomic temp-file + rename) → clears dirty → optionally formats. Every write path must
  restore `tab.eol`: CodeMirror documents are always `\n`, so an untranslated CRLF write rewrites every line.
- Indent and newline are per file (`tab.indentSize`, `tab.useTabs`, `tab.eol`), with `settings.tabSize` only a
  fallback. Untitled tabs have state but no path: `takeUntitledSeed` supplies initial text, drafts mirror to
  `untitledDrafts`, and saving goes through Save As.
- **Restore:** `App` shows only the themed background until hydration completes, and project/root/chain/tab
  restoration is one gate. A restored tab starts as metadata only: content and `EditorState` appear on first
  activation, and an undefined `tab.eol` before that is safe because a tab without state cannot be saved.
  File/cursor state restores only within the same project, and virtual or chat tabs never enter the
  file-layout session.

## Tab model

- Kinds are `file | diff | image | welcome | settings | untitled | chat`. `diff` and `image` have no
  `EditorState`; `welcome` and `settings` are rootless virtual tabs that are never persisted, never enter
  `closedTabs` and keep no cached state. Chat restoration belongs to [agent.md](./agent.md).
- A new or changed kind must cover `editor/openState.ts`, `tabs.activate`, the persisted-tab filter in
  `lib/editorSession.ts` and TabBar's icon/title; chat also needs `lib/agentSession.ts` and `AgentChat`
  wiring in `EditorHost`.
- **Preview tabs:** ordinary file/image opens are temporary and replace only the target pane's single clean,
  unpinned temporary tab. A first edit, double-click, pin, drag threshold, split or other explicit preserve
  action promotes it permanently, and undoing the edit must not demote it. Replaced state and caches release
  only when no pane still shows that tab, it never enters `closedTabs`, and restored or virtual tabs are
  never temporary. Only the title styling differs.
- **Panes:** the first chat creates a row split without moving existing tabs, and ordinary opens go to
  primary while the secondary tab is chat. Tab-bar item widths are measured once and refreshed on resize,
  never stored in tab state, and vertical wheel input writes one `scrollLeft` per frame.

## Markdown preview

Preview state is per pane/tab in `TabGroup.markdownPreview` and records the source-pane ratio: preserve it
through pane/tab moves and clear it on close, rename away from Markdown, replacement or merge (primary wins).
Keep the source `EditorView` mounted so `editor/markdownDocs.ts` can publish unsaved source, and lazy-load the
renderer: skip raw HTML, never navigate links, and allow only relative workspace raster images, because
`lib/markdown.ts` plus `api.readImage` must reject remote, absolute, escaping and SVG paths.

## CodeMirror and undo history

- One `EditorView` per pane; per-tab `EditorState` lives in `editor/stateCache.ts` and swaps through
  `view.setState`, while `editor/mirror.ts` forwards split-pane ChangeSets. Never put views/states in
  zustand, never share a state between views.
- Theme, font size, blame, word wrap and other toggleable extensions use `Compartment.reconfigure`;
  rebuilding state for a setting discards undo history and must be avoided.
- **DOM-producing extensions** (conflict controls, inline blame, fold arrows) do not rerender with React: a
  locale change must dispatch `editor/locale.ts`'s locale effect, and every plugin must unsubscribe
  `watchLocale` from `destroy()`. The structure outline walks the Lezer tree, and a very large file may expose
  only a viewport syntax tree, so never assume a full parse.
