---
summary: Tabs, files, Markdown and CodeMirror
scope:
  - .ai/editor.md
  - src/store/tabs.ts
  - src/store/tabs.test.ts
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
  - src/lib/tabTitle.ts
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

The tabs store owns open/save/restore. CodeMirror views belong to panes; stateCache owns per-tab states.
EditorHost selects tab kinds; markdown helpers own contained links and images.

## Open, save and restore

- Open through FileTree → useTabs.openFile(root, rel) → api.readTextFile → editor/openState (size tier,
  lazy language import) → view.setState → scrollMemory. Failed reads preserve the current tab.
- stat_file/read_text_file/read_image_file reject final-component symlinks with fs.symlinkUnsupported,
  including Quick Open, Agent mentions and Markdown images. Containment runs first so escapes report
  path.outsideWorkspace. FileTree rejects symlink opens before creating tabs.
- Save restores tab.eol before api.writeTextFile, clears dirty after success, then optionally formats.
  CodeMirror always uses LF; every save path must restore CRLF. Writes follow the context atomic contract.
- Indent/newline are per-file (indentSize/useTabs/eol); settings.tabSize is fallback. Untitled tabs have
  state without paths: takeUntitledSeed seeds text, untitledDrafts mirrors it, Save As assigns the path.
- Hydrate project/root/chain/tabs as one gate behind the themed startup frame. Restore metadata first;
  load content/state on activation. Missing eol is safe only while there is no state to save. Restore
  file/cursor state only within the same project; virtual/chat tabs never enter file-layout persistence.

## Tab and pane contracts

- Kinds: file/diff/image/welcome/settings/untitled/chat. Diff/image have no EditorState. Welcome/settings
  are rootless, unpersisted, absent from closedTabs and state caches. Chat history: [agent-storage.md](./agent-storage.md).
- A kind change updates editor/openState.ts, tabs.activate, lib/editorSession.ts's persisted filter and
  TabBar icon/title; chat also updates lib/agentSession.ts and AgentChat wiring in EditorHost.
- Each pane has one clean, unpinned temporary file/image tab. Edit/double-click/pin/drag/split or explicit
  preserve promotes it permanently; undo never demotes. Replacement never enters closedTabs and releases
  caches only when no pane shows it. Restored/virtual tabs are permanent; only title styling differs.
- Chat fills an empty editor; otherwise opens a secondary row split without moving existing tabs. Ordinary
  opens target primary. Measure tab widths once and on resize, outside tab state; wheel writes scrollLeft
  once/frame. TabBar hooks must precede its empty return, including first-open/last-close transitions.
- Closing or dragging away a pane's final tab collapses the split, including when the surviving pane contains
  an Agent. The survivor becomes primary with its selection/preview state; closing all tabs leaves one empty
  primary. Shared files retain the surviving buffer; cancelled unsaved closes leave layout intact. Empty panes
  have no Unsplit button. `src/store/tabs.test.ts` covers single/bulk closes, shared tabs, moves and cancellation.
- Each tab selects its own chat-running flag. Running agents hide close buttons even on hover/focus and block
  middle-click, context-menu close entries, bulk closes whose target set contains that chat, and close shortcuts;
  idle/failed/cancelled restore them. The tab store keeps the same guard for non-UI callers, while force cleanup
  remains available to project teardown.
- Chat tabs/drag ghosts use live provider icon + conversation title + optional execution status, with generic
  loading icon fallback. tabTitle uses tab.name or the localized New chat fallback; tooltips/headers use the
  same conversation title. src/store/agent.ts's titleFromPrompt takes the trimmed first prompt's first line,
  keeping up to 48 Unicode code points and appending an ellipsis only when truncated. Follow-ups keep that
  title; history/session restoration reuses it. /new clears the title so the next prompt names the
  conversation again. Reply links reuse openFile/openAt with the owning root and normalized relative path.

## Keyboard ownership

- App's shared shortcut dispatcher owns managed fold/unfold shortcuts; setup.ts must not register fallback
  foldKeymap aliases that survive a rebind/unbind. Default editing/history/multi-cursor keymaps remain local.
  Runtime shortcut contracts and persistence: [runtime.md](./runtime.md).

## Markdown and CodeMirror

- TabGroup.markdownPreview is per pane/tab and retains the source-pane ratio. Preserve through moves;
  clear on close, rename away from Markdown, replacement or merge (primary wins). Keep source EditorView
  mounted so markdownDocs publishes unsaved text; lazy-load rendering. Reject raw HTML, navigation and
  remote/absolute/escaping/SVG images; lib/markdown.ts and api.readImage allow contained relative raster images.
- One EditorView/pane; stateCache swaps per-tab states through view.setState. editor/mirror.ts forwards
  split ChangeSets. Never store views/states in zustand or share a state between views.
- Reconfigure theme/font/blame/wrap via Compartments; rebuilding state discards undo. DOM extensions
  (conflicts/blame/folds) need editor/locale.ts effects and destroy-time watchLocale unsubscribe. Large-file
  outline traversal must tolerate viewport-only Lezer trees.

## Selection context

- EditorHost registers its live view and mounted tab in editor/selectionRegistry; stateCache publishes only
  selection availability. Read snapshots on explicit actions, by group id, and reject hidden/stale views.
  Capture all nonempty ranges in document order with one-based, end-exclusive UTF-16 line/column metadata.
- EditorContextActions preserves selection on toolbar focus, captures before opening its menu, and offers
  add/explain/refactor. Command palette closures capture their source when commands are built. Untitled
  buffers use the active root and retain a label; file snapshots include dirty text without disk reads.
  Both registrations and tab-store subscriptions are released with the view.

## Change map and verification

Coordinate tab-kind changes across openState, persistence and TabBar; Markdown paths cross Rust containment.
Existing editor/tab/Markdown tests cover replacement, EOL, restoration and links. Native layout/scrolling
needs explicit manual verification. Gate policy: [checks.md](./checks.md).
