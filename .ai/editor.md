---
summary: Tabs, files, CodeMirror and formatting
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
  - src/components/SearchBar*
  - src/editor/[!m]*
  - src/editor/m[!a]*
  - src/lib/editorSession.ts
  - src/lib/fileDragState.ts
  - src/lib/untitledDrafts.ts
  - src/lib/externalTabs.ts
  - src/lib/externalTabs.test.ts
  - src/lib/tabTitle.ts
  - src/lib/diffMarks.ts
  - src/lib/diffMarks.test.ts
  - src/components/EditorContextActions*.tsx
  - src/components/EditorContextMenu*.tsx
  - src/lib/formatters.ts
  - src/lib/formatting.ts
  - src/lib/formatterActions.ts
  - src-tauri/src/commands/format.rs
keywords:
  - editor
  - tab
  - codemirror
  - formatting
  - save
  - 编辑器
  - 标签
  - 保存
  - 格式化
---
# Editor, tabs and CodeMirror

## Ownership

Tabs own open/save/restore; CodeMirror views belong to panes, `stateCache` to tabs. EditorHost selects tab
kinds. Markdown: [markdown.md](./markdown.md); `src/editor/markdownDocs.ts` belongs there, so the editor scope
excludes it.

## Open, save and restore

- Open: FileTree → `useTabs.openFile(root, rel)` → `api.readTextFile` → `openState` (size/lazy language) →
  `view.setState` → `scrollMemory`. Failed reads keep the tab.
- File commands reject final-component symlinks (`fs.symlinkUnsupported`) for Quick Open, Agent mentions and
  Markdown images; containment runs first (`path.outsideWorkspace`).
- Save atomically restores `tab.eol` and clears dirty only on success; indent/newline fallback is project
  `tabSize`. Untitled Save As uses project roots, external files outside.
- External tabs (`external`, absolute root, empty rel, file-only grant) skip tree/root switching, blame,
  conflicts, import links and search but keep editing/auto-save/format/images; project switches close them.
- Hydrate behind the startup frame and restore cursors only within the same project; virtual/chat tabs never
  persist layout.

## Tabs and panes

- Kinds: file/diff/image/welcome/settings/untitled/chat; `external` flags file/image. Diff/image have no
  EditorState; welcome/settings are rootless. Chat history: [agent-storage.md](./agent-storage.md).
- Each pane has one clean, unpinned temporary tab; edits/pin/drag/split/preserve promote it. Replacement skips
  `closedTabs`; caches release only without pane references. Final-tab close collapses its split; close all
  leaves one empty primary.
- Running Agent tabs block every close path; the tab store enforces the same guard for non-UI callers.
  Restore can replace a blank Agent tab through `tabs.replaceChatTab`, preserving pane, order and pinning.
  Chats persist: [agent](./agent.md).

## CodeMirror

- One EditorView per pane; `stateCache` swaps via `view.setState`, `editor/mirror.ts` forwards split ChangeSets.
  Never store views/states in zustand or share a state.
- `store/diffMarks` caches disk patches per root+rel; `editor/diffGutter` draws clickable changed-line bars
  ([git.md](./git.md)) and EditorHost reapplies after swaps. Dirty gutter blame reads the buffer, not disk.
- `editor/blame` draws one current-line widget. Edits hide it; queries debounce ~450ms, versioned results
  reject stale rows and time refreshes every 60s. Hover/click opens the card; project files only, dirty rows
  inherit none. Zero-width anchors keep caret geometry; Alt events pass through.
- ⌘/Ctrl-click resolves import paths/identifier chains to the import line with sticky highlight; the scan is
  cached and bounded to 2000 lines/256KB. Theme/font/blame/wrap use Compartments; rebuilding discards undo.
- ⌘F never seeds from selection; confirmed jumps center the match.

## Completion

- Full-tier JS/TS/TSX, Python, Rust, Go, Java and C/C++ use `smartComplete` unless lightweight; other
  full-tier/lightweight use words; large/preview omit it.
- Heuristic only (no type checking/definition/rename); nested owners/Python imports are limited; comments,
  strings/JSX text are ignored.
- Imports use `resolveSpecifier` and `completionFiles`/`completionFileBytes` caps, 60s TTL/reclaim;
  external files stay local.

## Formatting

- Settings owns `formatMode`/`formatTool`; choosing a tool while Off switches to Manual. Manual format is the
  badge, ⇧⌥F, or context menu.
- Prettier uses a runnable project copy or bundled; system tools label version/source via `toolpath.rs`.
- Settings installs rustfmt/Black only, never runtimes. gofmt follows Go; Prettier follows Tide/project manager.
- Missing runtimes get manual guidance; version probes run before install and formatting adds no persisted key
  beyond `formatMode`/`formatTool`.
- stdin -> stdout; empty output errors. Apply results only when the document still matches the snapshot;
  right-click opens `EditorContextMenu`; double-click stays word selection.

## Alt cursors and automatic save

- Alt-click accumulates empty carets. Alt-drag creates empty carets at each dragged logical line's start,
  own end, or matching visual column; short lines clamp to their end. It never selects text. Releasing Alt
  retains carets; a plain click returns to one caret. `altSelection` snaps empty/end hits to real
  positions without jumping across wrapped rows; it owns gesture mapping.
- Automatic save remains opt-in and defaults off: existing input-idle debounce (800ms/full, 1500ms/large)
  saves named writable file tabs only. Untitled buffers stay excluded; queued writes recheck the switch.

## Selection and change map

- `selectionRegistry` snapshots by group reject hidden/stale views. Capture ordered nonempty ranges with
  one-based, end-exclusive UTF-16 positions. `EditorContextActions` keeps selection on toolbar focus and
  includes dirty text for add/explain/refactor. Unregister on view teardown.
- Coordinate kind changes across openState, persistence and TabBar; Markdown contracts live in
  [markdown.md](./markdown.md). Gate: [checks.md](./checks.md).
