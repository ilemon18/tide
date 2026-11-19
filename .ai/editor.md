# Editor, tabs and Markdown

**Load when:** changing file opening/saving, editor session restore, tab behavior or layout, Markdown
preview, or CodeMirror state/extensions.
**Code:** `src/store/tabs.ts`, `src/components/EditorHost.tsx`, `src/components/TabBar.tsx`,
`src/editor/`, `src/lib/{editorSession,markdown,untitledDrafts}.ts`.

## Open, save and restore

- **Open:** `FileTree` → `useTabs.openFile(root, rel)` → `api.readTextFile` → `editor/openState` detects
  the size tier and lazily imports language support → `view.setState` → `editor/scrollMemory` restores
  cursor/scroll. A failed read must not replace or close the current tab.
- **Save:** a CodeMirror change marks the tab dirty; autosave (slower for the large tier) calls
  `useTabs.save` → restores `tab.eol` → `api.writeTextFile` (atomic temp-file + rename) → clears dirty →
  optionally formats when the on-save mode is enabled. Every write path must restore `tab.eol`:
  CodeMirror documents are always `\n`, so writing a CRLF file without translation rewrites all lines.
- Indent/newline settings are per file (`tab.indentSize`, `tab.useTabs`, `tab.eol`). Global
  `settings.tabSize` is only the fallback when detection has no result. Untitled tabs have state but no
  path; `takeUntitledSeed` supplies initial text, drafts mirror to `untitledDrafts`, and save goes through
  Save As.
- **Startup:** `App` shows only the themed background until hydration completes, with a timeout fallback.
  Batch project, root, folder-chain and tab restoration into one gate; do not render session-dependent UI
  before it.
- **Lazy restore:** a restored file tab starts as metadata/stat only. Its content and `EditorState` are
  created when first activated, and `applyRestoredMeta` fills EOL/indent. Until then `tab.eol` may be
  undefined; that is safe because a tab without state cannot be saved.
- **Session writes:** tab add/remove/switch debounces `lib/editorSession` → `save_open_tabs`; layout fields
  use a separate path. At startup, restore file/cursor state only when the current project equals the last
  project. Virtual tabs and chat tabs are not written into the file-layout session.

## Tab model

- Kinds are `file | diff | image | welcome | settings | untitled | chat`. `diff` and `image` have no
  `EditorState`. `welcome` and `settings` are virtual tabs with no root: they are not persisted in the
  layout session, never enter `closedTabs`, and have no cached state. Chat restoration belongs to
  [agent.md](./agent.md).
- Adding or changing a tab kind must cover `editor/openState.ts`, `tabs.activate`, the persisted-tab
  filter in `lib/editorSession.ts`, and TabBar's icon/title; chat also needs `lib/agentSession.ts` and
  `AgentChat` wiring in `EditorHost`.
- **Preview tabs:** ordinary file/image opens are temporary. A successful open replaces only the target
  pane's single clean, unpinned temporary file/image tab; another pane and a failed read stay untouched.
  The replaced tab's state, scroll/cursor, autosave and blame cache are released only when no pane still
  shows it. It never enters `closedTabs`. A first edit, double-click, pin, drag threshold, split or other
  explicit preserve action promotes it permanently; undoing the edit must not make it temporary again.
  Restored and virtual tabs are never temporary. Title styling changes only; icon/actions/pill do not.
- **Pane routing:** the first chat creates a row split with primary at 60%, without moving existing tabs.
  An existing split keeps its ratio and becomes row-oriented. While the secondary active tab is chat,
  ordinary opens with no explicit target go to primary; explicit pane targets, drops and in-place
  replacements keep their pane. An empty primary stays split while secondary holds chat; closing that
  chat or choosing unsplit merges normally.
- **Tab-bar layout:** memoized items measure intrinsic width once with `offsetWidth` and update resized
  items from `ResizeObserver`; never use `getBoundingClientRect()` except for pointer-drag hit testing.
  Commit cached width/viewport/layout changes together and keep measured widths out of tab state.
  Horizontal-dominant wheel input stays native; vertical accumulation writes `scrollLeft` once per frame
  without geometry reads. Preserve pill shadow space and active/dragged stacking order.

## Markdown preview

- Preview state is per pane/tab in `TabGroup.markdownPreview`; the value records the source-pane ratio.
  Preserve it through pane/tab moves, and clear it on close, rename away from Markdown, replacement, or
  merge (primary wins). It is session-only.
- Keep the source `EditorView` mounted. `editor/markdownDocs.ts` publishes unsaved source independently of
  split-pane mirroring; preview scroll remains independent.
- Lazy-load the renderer, skip raw HTML, never navigate links, and allow only relative workspace raster
  images. `lib/markdown.ts` plus `api.readImage` must reject remote, absolute, escaping, and SVG paths.
  Revoke Blob URLs when preview unmounts.

## CodeMirror and undo history

- One `EditorView` serves each pane (one, or two after split). Per-tab `EditorState` lives in
  `editor/stateCache.ts` and swaps through `view.setState`; `editor/mirror.ts` forwards split-pane
  ChangeSets. Never put views/states in zustand and never share a state between views.
- Theme, font size, blame, word wrap and other toggleable extensions use `Compartment.reconfigure`.
  Rebuilding state for a setting change discards undo history and must be avoided.
- **Structure outline** walks the Lezer tree, not text. A declaration is a leaf unless it is a container
  (class/struct/interface/module); descending into function bodies would list locals. Very large files may
  expose only a viewport syntax tree, so do not assume a full parse.
- **DOM-producing extensions** (conflict controls, inline blame, fold arrows) do not re-render with React.
  A locale change must dispatch `editor/locale.ts`'s locale effect, and every plugin must unsubscribe
  `watchLocale` from `destroy()`.
