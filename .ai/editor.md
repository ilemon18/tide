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
  Save As accepts any existing directory. A target inside a root reopens as a project file; an outside
  target becomes an external tab, with the same atomic write path and no project-tree refresh.
- Files outside every project open as `external: true`, `root = normalized absolute file path`, `rel = ''`.
  The backend `grant_file` registers exactly that file (canonical parent + final name, symlink or directory
  rejected); it never grants the parent directory. External tabs skip tree reveal, active-root switching,
  blame, conflicts, import links and project search, but keep language detection from `tab.name`, editing,
  auto-save, formatting and images. Their cursor session lives in localStorage (`lib/externalTabs.ts`),
  not the Rust project session. Project switch still closes them with `closeEverything`.
- Double-clicking or right-clicking tab-strip whitespace opens the blank-tab menu (New blank file / Open
  file…); an empty project pane renders the same 36px strip, while the no-project Welcome page does not.
  Tabs keep their own double-click promotion. A file/diff tab double-click also switches to Explorer and
  requests a centred tree reveal (`TreeReveal.center`); external tabs only promote. Open File is the first
  Welcome action and a palette command (`file.open`, no default stroke so Mod+O stays Open Folder).
- Hydrate project/root/chain/tabs as one gate behind the themed startup frame. Restore metadata first;
  load content/state on activation. Missing eol is safe only while there is no state to save. Restore
  file/cursor state only within the same project; virtual/chat tabs never enter file-layout persistence.

## Tab and pane contracts

- Kinds: file/diff/image/welcome/settings/untitled/chat. `external` is a flag on file/image, not a kind.
  Diff/image have no EditorState. Welcome/settings
  are rootless, unpersisted, absent from closedTabs and state caches. Chat history: [agent-storage.md](./agent-storage.md).
- A kind change updates editor/openState.ts, tabs.activate, lib/editorSession.ts's persisted filter and
  TabBar icon/title; chat also updates lib/agentSession.ts and AgentChat wiring in EditorHost.
- Each pane has one clean, unpinned temporary file/image tab. Edit/double-click/pin/drag/split or explicit
  preserve promotes it permanently; undo never demotes. Replacement never enters closedTabs and releases
  caches only when no pane shows it. Restored/virtual tabs are permanent; only title styling differs.
- Chat fills an empty editor; otherwise opens a secondary row split without moving existing tabs. Ordinary
  opens target primary. Measure tab widths once and on resize, outside tab state; wheel writes scrollLeft
  once/frame. TabBar hooks must precede its empty return, including first-open/last-close transitions.
- History restore can replace a blank Agent tab reference atomically through tabs.replaceChatTab, preserving
  its pane, order, pinned state and split geometry without closing/recreating a pane or adding closedTabs.
  The agent store owns blank eligibility and root/session restoration; see [agent-storage.md](./agent-storage.md).
- Closing or dragging away a pane's final tab collapses the split, including when the surviving pane contains
  an Agent. The survivor becomes primary with its selection/preview state; closing all tabs leaves one empty
  primary. Shared files retain the surviving buffer; cancelled unsaved closes leave layout intact. Empty panes
  have no Unsplit button. `src/store/tabs.test.ts` covers single/bulk closes, shared tabs, moves and cancellation.
- Each tab selects its own chat-running flag. Running agents hide close buttons even on hover/focus and block
  middle-click, context-menu close entries, bulk closes whose target set contains that chat, and close shortcuts;
  idle/failed/cancelled restore them. The tab store keeps the same guard for non-UI callers, while force cleanup
  remains available to project teardown.
- Chat tabs/drag ghosts use live provider icon + conversation title + optional execution status, with generic
  loading icon fallback. Single-colour provider marks are mask-tinted with currentColor so dark themes keep
  them visible; brand-coloured marks stay as images. tabTitle uses tab.name or the localized New chat fallback;
  tooltips/headers use the same conversation title. src/store/agent.ts's titleFromPrompt takes the trimmed
  first prompt's first line, keeping up to 48 Unicode code points and appending an ellipsis only when truncated.
  Follow-ups keep that title; history/session restoration reuses it. /new clears the title so the next
  prompt names the conversation again. Reply links reuse openFile/openAt with the owning root and normalized
  relative path.

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
- The line-number gutter mirrors the right-edge DiffRuler: store/diffMarks caches parsed full-patch marks
  per root+rel (mtime/dirty/diffEpoch signature; in-flight dedupe) and editor/diffGutter renders one
  success/warning/danger bar per changed line. Marked rows are click targets that select the line and open
  its one-line blame card (fetching blame on demand when needed), with a pointer cursor and a wider hover bar.
  Project file states get the gutter before lineNumbers; external, untracked-buffer and preview states do not.
  Marks are disk-based: typing maps their positions, the next save reloads the real patch. EditorHost reapplies
  the current marks after every state swap.
- ⌘/Ctrl-click in a code file first resolves an import path (importLinks, opens the target file). Otherwise
  importJump resolves the identifier under the pointer, walks a member chain to its root, and moves the
  caret to that binding's import line, centring it and using the sticky jump highlight. The import scan is
  bounded to the first 2000 lines / 256KB and cached per immutable Text; non-imported symbols fall through.
- Reconfigure theme/font/blame/wrap via Compartments; rebuilding state discards undo. DOM extensions
  (conflicts/blame/folds) need editor/locale.ts effects and destroy-time watchLocale unsubscribe. Large-file
  outline traversal must tolerate viewport-only Lezer trees.
- editor/blame schedules current-line detail prefetch after blame arrives or the cursor changes lines,
  debounced 150ms by store/commitHover. Reuse the typing suppression period before scheduling; skip absent,
  disabled and uncommitted blame. Same-line/viewport/locale refreshes do not restart the debounce.
  State replacement, extension removal and view destruction cancel that view's pending prefetch without
  cancelling another pane's newer target. Hover request/presentation contracts: [git.md](./git.md).

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
