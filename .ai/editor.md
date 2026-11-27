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
  - src/components/SearchBar*
  - src/components/MarkdownPreview.tsx
  - src/components/MarkdownRenderer.tsx
  - src/editor/**
  - src/lib/editorSession.ts
  - src/lib/fileDragState.ts
  - src/lib/markdown.ts
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
  - markdown
  - preview
  - codemirror
  - 编辑器
  - 标签
  - 预览
---
# Editor, tabs and Markdown

## Ownership

Tabs own open/save/restore; CodeMirror views belong to panes, `stateCache` to tabs. EditorHost selects
tab kinds; Markdown helpers contain links/images.

## Open, save and restore

- Open: FileTree → `useTabs.openFile(root, rel)` → `api.readTextFile` → `openState` (size/lazy language) →
  `view.setState` → `scrollMemory`. Failed reads keep the tab.
- File commands reject final-component symlinks with `fs.symlinkUnsupported`, including Quick Open, Agent
  mentions and Markdown images; containment runs first so escapes report `path.outsideWorkspace`.
- Save atomically restores `tab.eol` (CodeMirror uses LF), clearing dirty only on success. Per-file indent/
  newline falls back to `settings.tabSize`. Untitled Save As uses project tabs inside roots, external outside.
- External tabs use `external: true`, normalized absolute `root`, empty `rel`; `grant_file` grants the file
  only. Skip tree/root switching/blame/conflicts/import links/project search; keep editing/auto-save/format/
  images. `lib/externalTabs.ts` owns cursors; project switches close them.
- Hydrate project/root/chain/tabs behind the startup frame; restore file/cursor state only within the same
  project. Virtual/chat tabs never persist layout.

## Tabs and panes

- Kinds: file/diff/image/welcome/settings/untitled/chat; `external` flags file/image. Diff/image have no
  EditorState; welcome/settings are rootless. Chat history: [agent-storage.md](./agent-storage.md).
- Each pane has one clean, unpinned temporary tab; edits/pin/drag/split/preserve promote it. Replacement skips
  `closedTabs`; caches release only without pane references. Final-tab close collapses its split; close all
  leaves one empty primary.
- Running Agent tabs block every close path; the tab store enforces the same guard for non-UI callers.
  Restore can replace a blank Agent tab through `tabs.replaceChatTab`, preserving pane, order and pinning.
  Chats persist: [agent](./agent.md).

## Markdown and CodeMirror

- Per-pane/tab `markdownPreview` keeps source ratios on moves; close/rename away/replacement/merge clear it.
  Keep source views mounted for dirty text; reject HTML, navigation and remote/absolute/escaping/SVG images.
- One EditorView per pane; `stateCache` swaps states through `view.setState` and `editor/mirror.ts` forwards
  split ChangeSets. Never store views/states in zustand or share a state between views.
- Gutter/DiffRuler share disk marks: `store/diffMarks` caches patches per root+rel; `editor/diffGutter` draws
  clickable changed-line bars ([git.md](./git.md)). EditorHost reapplies after state swaps; gutter blame uses
  the current buffer, never disk for dirty rows.
- `editor/blame` draws one current-line widget, no gutter/list. Doc changes hide it; queries debounce ~450ms,
  versioned results reject stale rows, and relative time refreshes every 60s. Hover/click opens the card.
  EditorHost wires project files only and reapplies after state swaps; dirty states inherit no rows.
  Zero-width anchors exclude annotations from caret geometry; Alt events pass through.
- ⌘/Ctrl-click resolves an import path then an identifier chain to its import line with a sticky highlight;
  the scan is cached and bounded to 2000 lines / 256KB. Theme/font/blame/wrap use Compartments; rebuilding
  state discards undo. Blame/hover: [git.md](./git.md).
- ⌘F never seeds from the selection; confirmed jumps center the match.

## Formatting

- Settings owns `formatMode`/`formatTool`; choosing a tool while Off switches to Manual. Manual format is the
  badge, ⇧⌥F, or context menu.
- Prettier uses a runnable project copy or bundled; system tools label version/source via `toolpath.rs`.
- Settings installs rustfmt/Black only, never runtimes. gofmt follows Go; Prettier follows Tide/project manager.
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
- Coordinate kind changes across openState, persistence and TabBar; Markdown crosses Rust containment.
  Gate: [checks.md](./checks.md).
