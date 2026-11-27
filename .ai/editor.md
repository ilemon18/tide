---
summary: Tabs, files, Markdown and CodeMirror
scope:
  - .ai/editor.md
  - src/store/tabs.ts
  - src/store/tabs.test.ts
  - src/store/diffMarks.ts
  - src/store/diffMarks.test.ts
  - src/components/EditorHost.tsx
  - src/components/EditorArea.tsx
  - src/components/TabBar.tsx
  - src/components/TabBar.test.tsx
  - src/components/MarkdownPreview.tsx
  - src/components/MarkdownRenderer.tsx
  - src/editor/**
  - src/lib/editorSession.ts
  - src/lib/markdown.ts
  - src/lib/untitledDrafts.ts
  - src/lib/externalTabs.ts
  - src/lib/externalTabs.test.ts
  - src/lib/tabTitle.ts
  - src/lib/diffMarks.ts
  - src/lib/diffMarks.test.ts
  - src/components/EditorContextActions*.tsx
keywords:
  - editor
  - tab
  - markdown
  - preview
  - codemirror
  - 编辑器
  - 标签
  - 预览
---
# Editor, tabs and Markdown

## Ownership

The tabs store owns open/save/restore; CodeMirror views belong to panes and `stateCache` owns per-tab
states. EditorHost selects tab kinds; markdown helpers own contained links and images.

## Open, save and restore

- Open flows FileTree → `useTabs.openFile(root, rel)` → `api.readTextFile` → `editor/openState` (size tier,
  lazy language import) → `view.setState` → `scrollMemory`; failed reads preserve the current tab.
- File commands reject final-component symlinks with `fs.symlinkUnsupported`, including Quick Open, Agent
  mentions and Markdown images; containment runs first so escapes report `path.outsideWorkspace`.
- Save restores `tab.eol`, writes atomically and clears dirty after success. CodeMirror uses LF; every save
  path restores CRLF. Indent/newline are per-file with `settings.tabSize` as fallback.
- Untitled tabs keep state without paths and Save As assigns one. Targets inside a root reopen as project
  files; outside targets become external tabs with the same atomic write path.
- External files use `external: true`, `root =` normalized absolute path and `rel = ''`; `grant_file`
  registers exactly that file, never its parent. External tabs skip tree reveal, root switching, blame,
  conflicts, import links and project search, but keep editing, auto-save, formatting and images. Cursor
  state lives in `lib/externalTabs.ts`; project switch closes them.
- Hydrate project/root/chain/tabs behind the startup frame; restore file/cursor state only within the same
  project. Virtual/chat tabs never persist layout.

## Tabs and panes

- Kinds: file/diff/image/welcome/settings/untitled/chat; `external` flags file/image. Diff/image have no
  EditorState; welcome/settings are rootless. Chat history: [agent-storage.md](./agent-storage.md).
- Each pane has one clean, unpinned temporary tab. Editing, pinning, dragging, splitting or preserving
  promotes it. Replacement never enters `closedTabs` and releases caches only when no pane shows the tab.
  Closing a pane's final tab collapses the split; closing all tabs leaves one empty primary.
- Running Agent tabs block every close path; the tab store enforces the same guard for non-UI callers.
  Restore can replace a blank Agent tab through `tabs.replaceChatTab`, preserving pane, order and pinning.
  Details: [agent.md](./agent.md).

## Markdown and CodeMirror

- `TabGroup.markdownPreview` is per pane/tab, keeps the source ratio through moves and clears on close,
  rename away from Markdown, replacement or merge. Keep the source EditorView mounted so unsaved text
  publishes; reject raw HTML, navigation and remote/absolute/escaping/SVG images.
- One EditorView per pane; `stateCache` swaps states through `view.setState` and `editor/mirror.ts` forwards
  split ChangeSets. Never store views/states in zustand or share a state between views.
- The gutter mirrors the right-edge DiffRuler: `store/diffMarks` caches full-patch marks per root+rel and
  `editor/diffGutter` renders one bar per changed line. Marked rows are click targets ([git.md](./git.md));
  marks are disk-based and EditorHost reapplies them after state swaps. Gutter blame providers receive the
  current buffer, so a dirty row is never blamed from disk.
- Inline blame is GitLens current-line only: `editor/blame` draws one widget on the cursor line (no per-line
  gutter blame, no whole-file list), hides it immediately on a doc change, and asks the content provider
  after a ~450 ms idle. Results carry a doc version; stale ones are ignored. A 60-second timer refreshes the
  relative time, and hover/click open the commit card. EditorHost wires the provider only for project file
  tabs and re-applies blame after state swaps, while dirty states never inherit disk rows.
- ⌘/Ctrl-click resolves an import path, then an identifier chain to its import line with a sticky highlight;
  the scan is bounded to 2000 lines / 256KB and cached. Reconfigure theme/font/blame/wrap through
  Compartments; rebuilding state discards undo. Blame/hover: [git.md](./git.md).

## Selection and change map

- `editor/selectionRegistry` publishes availability; read snapshots by group id and reject hidden/stale
  views. Capture nonempty ranges in document order with one-based, end-exclusive UTF-16 line/column metadata.
  `EditorContextActions` preserves selection on toolbar focus and offers add/explain/refactor; file snapshots
  include dirty text. Release registrations with the view.
- Coordinate kind changes across openState, persistence and TabBar; Markdown crosses Rust containment.
  Gate: [checks.md](./checks.md).
