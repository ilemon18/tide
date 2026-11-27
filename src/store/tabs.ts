import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { create } from 'zustand'
import { api, errorText, type GitStatus, type SavedTab } from '../lib/ipc'
import { basename, dirname, relFromAbsolute } from '../lib/paths'
import {
  cacheEditorState,
  clearEditorStates,
  createFileState,
  dropEditorState,
  getEditorState,
  markCleanDoc,
  reconfigureTheme,
  rekeyEditorState,
  setEditorRel,
  setWordWrap,
} from '../editor/stateCache'
import { getEditorView } from '../editor/viewRef'
import { createMirrorState, forwardDocChange } from '../editor/mirror'
import { mirrorKey, tabIdOfStateKey } from '../editor/stateKeys'
import {
  dropScrollRatio,
  forgetScrollForTab,
  handOffScrollRatio,
  rekeyScroll,
} from '../editor/scrollMemory'
import { tierFor, type DocTier } from '../editor/largeFile'
import { signals } from '../editor/signals'
import { useSettings } from './settings'
import { isImagePath, isSvgPath } from '../lib/media'
import { isConflictedFile } from '../lib/conflictFiles'
import { detectTextMeta, tidyText, type Eol } from '../lib/textMeta'
import { isMarkdownPath } from '../lib/markdown'
import { formatWithSelectedTool } from '../lib/formatting'
import { resolveTool, sourceLabel } from '../lib/formatters'
import { conflictField } from '../editor/conflicts'
import { useUi } from './ui'
import { useWorkspace, activeRoot } from './workspace'
import { useGit } from './git'
import { useBlame } from './blame'
import { t, tp } from '../i18n'
import { tabTitle } from '../lib/tabTitle'
import { budget } from '../lib/memoryBudget'
import { useFileIndex } from './fileIndex'
import { agentBridge } from '../lib/agentBridge'
import {
  flushUntitledDrafts,
  loadUntitledDrafts,
  saveUntitledDrafts,
  type UntitledDraft,
} from '../lib/untitledDrafts'

/** Above this size, no format-on-save: the formatter reads the whole file and big files stall the save */
const FORMAT_MAX_CHARS = 500_000

export type TabGroupId = 'primary' | 'secondary'
export type SplitOrientation = 'row' | 'column'

/** One editor panel: its tabs (in display order) + the active one */
export type TabGroup = {
  id: TabGroupId
  activeId: string | null
  /** Tab ids in tab-bar order. A split file appears in both groups */
  order: string[]
  /** Per-tab Markdown preview width ratio. Key presence means this pane has the preview open. */
  markdownPreview?: Record<string, number>
}

/** Metadata a restored tab only learns when its content is read (see `applyRestoredMeta`) */
export type RestoredMeta = {
  size: number
  mtime: number
  eol: Eol
  indentSize?: number
  useTabs: boolean
  tier: DocTier
}

export type Tab = {
  id: string
  root: string
  /**
   * image / welcome / settings / chat are virtual tabs: no EditorState. Chat keeps a root, but no rel.
   * Chat tabs are restored by lib/agentSession, not the file session.
   * untitled is a new buffer that has no file on disk yet (⌘N): it does get an EditorState, and ⌘S asks for a path.
   */
  kind: 'file' | 'diff' | 'image' | 'welcome' | 'settings' | 'untitled' | 'chat'
  rel: string
  name: string
  dirty: boolean
  readOnly: boolean
  tier: DocTier
  /** Pinned tabs sort first, show icon only, and are skipped by bulk close */
  pinned: boolean
  /** Preview tab: a later ordinary file open in the same pane replaces it until it is promoted */
  temporary: boolean
  /** Per-file word wrap override (⌥Z); undefined follows the global setting */
  wordWrap?: boolean
  /** Ordinal of an untitled buffer: Untitled-1, Untitled-2 … used for the title and the save dialog default */
  seq?: number
  /** SVG preview of a text tab: kind stays file, editor and saving still work */
  preview?: boolean
  staged?: boolean
  size?: number
  mtime: number
  /** File's original line ending: restored on save, so CRLF files are not rewritten as LF */
  eol?: Eol
  /** Indent width detected from the content (overrides the global setting) */
  indentSize?: number
  /** Source uses tab indentation */
  useTabs?: boolean
  /**
   * A file opened outside every workspace root. `root` is then the normalized absolute file path
   * and `rel` is empty; the backend grants exactly this file, not its parent directory. External
   * tabs do not reveal in the tree, load blame, or participate in project search/git.
   */
  external?: boolean
}

/** Closed tab: ⌘⇧T restores them one by one */
export type ClosedTab = { tab: Tab; groupId: TabGroupId; cursor?: CursorInfo }

/** Max closed tabs remembered; files restored at startup come from lib/memoryBudget */
const CLOSED_LIMIT = 20
/** Files above this size are skipped on restore (no memory blowup just to restore state) */
const RESTORE_MAX_BYTES = 2 * 1024 * 1024
/** Restored tabs are stat'ed in parallel: sequential round-trips made them appear one after another */
const RESTORE_CONCURRENCY = 6
const SPLIT_RATIO_MIN = 0.2
const SPLIT_RATIO_MAX = 0.8
const SPLIT_RATIO_DEFAULT = 0.5
const MARKDOWN_PREVIEW_RATIO_MIN = 0.2
const MARKDOWN_PREVIEW_RATIO_MAX = 0.8
const MARKDOWN_PREVIEW_RATIO_DEFAULT = 0.5
/** First chat split leaves most of the editor available for code beside the conversation */
const CHAT_SPLIT_RATIO = 0.6

function pushClosed(
  list: ClosedTab[],
  tab: Tab,
  groupId: TabGroupId,
  cursor?: CursorInfo,
): ClosedTab[] {
  // No need to restore diffs or the welcome page: the first changes, the second is always there
  if (tab.kind !== 'file' && tab.kind !== 'image') return list
  const next = [...list, { tab: { ...tab, dirty: false, pinned: false }, groupId, cursor }]
  return next.slice(-CLOSED_LIMIT)
}

export type CursorInfo = { line: number; col: number }

/** refreshFromDisk options: legacy calls pass a boolean meaning force */
export type RefreshFromDiskOptions = {
  force?: boolean
  /** Refresh only tabs matching these rels; omitted means all under that root */
  paths?: string[]
}

export type RevealRequest = {
  tabId: string
  line: number
  col: number
  /** Length of the matched text: select it, otherwise select the whole line */
  length?: number
  /** Place the caret only, no line selection (restore / go-to-line, so the next keystroke does not wipe it) */
  caret?: boolean
  nonce: number
  /** false = background refresh restores the caret only: no focus grab, no scroll, no flash */
  focus?: boolean
}

export function fileTabId(root: string, rel: string) {
  return `file:${root}::${rel}`
}

export function diffTabId(root: string, rel: string, staged: boolean) {
  return `diff:${root}::${staged ? 's' : 'w'}:${rel}`
}

/** The welcome page is a normal tab: only one per window */
export const WELCOME_TAB_ID = 'welcome:home'

/** Settings is a normal tab too: only one per window */
export const SETTINGS_TAB_ID = 'settings:prefs'

/** After open / switch, make the explorer expand and select the file (reveal only, no view switch) */
function revealInTree(tab: Tab) {
  if (tab.kind === 'diff' || tab.kind === 'welcome' || tab.external || !tab.root) return
  useWorkspace.getState().requestTreeReveal({ root: tab.root, rel: tab.rel, isDir: false })
}

/** Formatter/language hint: external tabs keep the file name although `rel` is empty. */
function tabFileRel(tab: Tab) {
  return tab.external ? tab.name : tab.rel
}

/** Swap a view to a new state while keeping its caret and scroll position */
function swapViewState(view: EditorView, state: EditorState) {
  // A background reload (branch switch / external change) must not throw the reader back to the top
  const top = view.scrollDOM.scrollTop
  // A new state puts the caret at the start: map the old line/col back,
  // else a reload after auto-save makes the caret jump back while typing
  const head = view.state.selection.main.head
  const current = view.state.doc.lineAt(head)
  const col = head - current.from
  const nextLine = state.doc.line(Math.min(current.number, state.doc.lines))
  const anchor = Math.min(nextLine.to, nextLine.from + col)

  view.setState(state)
  reconfigureTheme(view)
  // Set the caret via dispatch: that runs updateListener, so the cached state picks up the caret
  view.dispatch({ selection: { anchor } })
  view.requestMeasure({
    read: () => top,
    write: (value, v) => {
      v.scrollDOM.scrollTop = value
    },
  })
}

/** Swap the state now if the tab is mounted, without waiting for a React effect (and no focus grab). Both views swap after a split. */
function applyActiveState(id: string, state: EditorState) {
  const snapshot = useTabs.getState()
  if (!snapshot.tabs.some((t) => t.id === id)) return
  for (const groupId of groupsWith(snapshot.groups, id)) {
    const group = snapshot.groups.find((g) => g.id === groupId)
    if (!group || group.activeId !== id) continue
    if (editorStateKey(id, groupId, snapshot.groups) !== id) {
      // The other pane holds the mirror state: drop it, EditorHost rebuilds from the new primary state
      dropEditorState(mirrorKey(id))
      continue
    }
    const view = getEditorView(groupId)
    if (view) swapViewState(view, state)
  }
}

/**
 * With one file in both panes the secondary uses a mirror state (an EditorState mounts one view; mirror.ts
 * forwards edits). A file only in the secondary still uses the primary key.
 */
export function editorStateKey(tabId: string, groupId: TabGroupId, groups: TabGroup[]): string {
  const inPrimary = groups.find((g) => g.id === 'primary')?.order.includes(tabId) ?? false
  return groupId === 'secondary' && inPrimary ? mirrorKey(tabId) : tabId
}

/**
 * Write tidied text back to the buffer. A mounted view gets a transaction (undo history and caret mapping
 * work); an unmounted one (background save) just replaces the cached EditorState.
 */
function replaceDocText(id: string, next: string) {
  const state = getEditorState(id)
  if (!state || state.doc.toString() === next) return
  const changes = { from: 0, to: state.doc.length, insert: next }
  const view = getEditorView()
  if (view && view.state === state) {
    view.dispatch({ changes })
    return
  }
  // Background or mirrored tab: replace the cached state, then remount each pane on the new one
  const nextState = state.update({ changes }).state
  cacheEditorState(id, nextState)
  applyActiveState(id, nextState)
}

type TabsStore = {
  tabs: Tab[]
  /** Active tab of the current panel (same as activeGroup.activeId, kept for existing call sites) */
  activeId: string | null
  /** At least one; two after a split */
  groups: TabGroup[]
  activeGroupId: TabGroupId
  /** null = not split */
  splitOrientation: SplitOrientation | null
  /** Primary pane share of a split; drag clamps it to 20%-80% */
  splitRatio: number
  cursors: Record<string, CursorInfo>
  reveal: RevealRequest | null
  opening: boolean
  /** Recently closed tabs (max 20), used by ⌘⇧T */
  closedTabs: ClosedTab[]
  /** Bumped when content is reloaded from disk; EditorHost uses it to remount the new EditorState */
  stateEpoch: number
  /** Bumped per root or tab: diff views refetch without closing unrelated tabs */
  diffEpoch: Record<string, number>
  /** Manually formatting the current file (status bar spinner) */
  formatting: boolean

  /** Open a file outside every workspace; the backend grants exactly this path. */
  openExternalFile: (
    path: string,
    options?: { groupId?: TabGroupId; index?: number; quiet?: boolean },
  ) => Promise<void>
  openFile: (
    root: string,
    rel: string,
    options?: {
      groupId?: TabGroupId
      index?: number
      /** Automated opens (empty diff → file view) must not toast when the file cannot be opened */
      quiet?: boolean
      /** Keep the other diff of the same file: a staged / unstaged pair stays readable */
      keepDiffs?: boolean
      /** Ordinary opens are preview tabs; explicit preserves (drag, save as, reopen) pass false */
      temporary?: boolean
    },
  ) => Promise<void>
  /** Open (or switch to) a file in the given panel at an optional index; used by drag to panel / tab */
  openFileInGroup: (root: string, rel: string, groupId: TabGroupId, index?: number) => Promise<void>
  /** Open (or switch to) the welcome tab */
  openWelcome: () => void
  /** Open (or switch to) the settings tab */
  openSettings: () => void
  /** Agent chat tabs: one per conversation; an already open id is activated */
  openChat: (chatId: string, root: string, title: string) => void
  /** Open a chat in the active layout: fill an empty editor, otherwise keep files in primary and split */
  openChatInRight: (chatId: string, root: string, title: string) => void
  /** Replace an empty chat's reference without closing its pane or changing tab attributes. */
  replaceChatTab: (previousChatId: string, chatId: string, root: string, title: string) => boolean
  /** Rename a tab without touching its content (agent title follows the first prompt) */
  setTabName: (id: string, name: string) => void
  /**
   * New unsaved buffer (⌘N). No file on disk: ⌘S opens a save dialog. Optional text restores a draft
   * left behind by a previous run (see lib/untitledDrafts).
   */
  openUntitled: (options?: { text?: string; seq?: number; groupId?: TabGroupId }) => string
  /** ⌘S on an untitled buffer: pick any path, write it, then reopen as a project or external file */
  saveAs: (id: string) => Promise<boolean>
  /** Reopen untitled buffers saved for hot exit by a previous run (main window only) */
  restoreUntitledDrafts: () => void
  /**
   * Fill in what a lazily restored tab does not know until its content is read: line ending, indent, size.
   * Called from `editor/openState` right after the file is read for a tab that had no eol yet.
   */
  applyRestoredMeta: (id: string, meta: RestoredMeta) => void
  /** ⌥Z / command palette: flip this file's word wrap (full-tier files only) */
  toggleWordWrap: (id?: string) => void
  openAt: (root: string, rel: string, line: number, col: number, length?: number) => Promise<void>
  openDiff: (root: string, rel: string, staged: boolean) => Promise<void>
  /**
   * The viewed diff turned empty (file added / committed / unstaged): replace that diff tab with the
   * file tab, handing over the reader's relative scroll position. If the file cannot be opened as a
   * text file (deleted, folder, too large) only the now useless diff tab is closed.
   */
  switchDiffToFile: (diffTabId: string, scrollRatio: number) => Promise<void>
  reload: (root: string, rel: string, options?: { silent?: boolean }) => Promise<void>
  activate: (id: string, groupId?: TabGroupId) => void
  activateOffset: (delta: number) => void
  setActiveGroup: (id: TabGroupId) => void
  setSplitRatio: (ratio: number) => void
  /** Split: move=false puts the current file in both panes (synced), move=true moves the tab over */
  split: (orientation: SplitOrientation, move: boolean) => Promise<void>
  /** Toggle the in-pane Markdown source + rendered preview split */
  toggleMarkdownPreview: (groupId: TabGroupId, tabId: string) => void
  /** Persist this pane/tab Markdown preview width; clamped to 20%-80% */
  setMarkdownPreviewRatio: (groupId: TabGroupId, tabId: string, ratio: number) => void
  /** Unsplit: merge the secondary pane's tabs back into the primary */
  unsplit: () => void
  moveTab: (groupId: TabGroupId, from: number, to: number) => void
  /** Drag to another group: remove from its pane and insert at the target index */
  moveTabToGroup: (id: string, target: TabGroupId, index?: number) => void
  close: (id: string, force?: boolean) => Promise<void>
  /** Close from one pane only (the other pane, still showing the file, is unaffected) */
  closeIn: (id: string, groupId: TabGroupId) => Promise<void>
  closeActive: () => Promise<void>
  /** Close all tabs of the current panel */
  closeAll: (options?: { force?: boolean }) => Promise<void>
  /**
   * Close tabs in all panes and clear the reopen stack.
   * Used on project switch / close: closeAll only covers the current panel, so a split would keep the old
   * project's tabs in the other pane.
   */
  closeEverything: (options?: { force?: boolean }) => Promise<void>
  /** Close a batch by id (e.g. tabs of a removed project) */
  closeTabs: (ids: string[], options?: { force?: boolean }) => Promise<void>
  /** Close all other tabs in the panel (pinned kept) */
  closeOthers: (id: string, options?: { force?: boolean }) => Promise<void>
  /** Close all tabs to the right (pinned kept) */
  closeRight: (id: string, options?: { force?: boolean }) => Promise<void>
  /** Close all tabs to the left (pinned kept) */
  closeLeft: (id: string, options?: { force?: boolean }) => Promise<void>
  /** Close all unmodified tabs in the panel (pinned kept) */
  closeUnmodified: (options?: { force?: boolean }) => Promise<void>
  /** Reopen the most recently closed tab (⌘⇧T) */
  reopenClosed: () => Promise<void>
  /** A preview tab becomes permanent after a deliberate action / the first document change */
  promoteTab: (id: string) => void
  /** Go to a line in the current file (⌃G / `:42` in quick open; `col` is used by the structure view) */
  jumpToLine: (line: number, col?: number) => void
  /** Restore last session's files at startup (skips deleted / oversized files) */
  restoreOpenTabs: (root: string, tabs: SavedTab[], activeRel: string | null) => Promise<void>
  pinTab: (id: string, pinned: boolean) => void
  /** Toggle source vs image preview (SVG only for now); display only, editor state and file untouched */
  togglePreview: (id: string) => void
  /** Reload on demand after branch switch / external change: untouched mtime means no reload, keeping caret and undo history */
  /** force: drop unsaved edits too and reread from disk (after aborting merge / cherry-pick) */
  refreshFromDisk: (root: string, options?: RefreshFromDiskOptions | boolean) => Promise<void>
  /** Handle "file really gone" only: close diff tabs when the file vanished from disk. Content / commit / unstage changes refetch via diffEpoch. */
  syncDiffTabs: (root: string, status: GitStatus | undefined, paths?: string[]) => Promise<void>
  markDirty: (id: string) => void
  /** The buffer went back to the text on disk (undo): drop the dot and the queued auto-save */
  markClean: (id: string) => void
  markCursor: (id: string, line: number, col: number) => void
  /** quiet = auto-save: skip git blame (a commit query every 800ms burns CPU and fills the cache) */
  save: (id: string, opts?: { quiet?: boolean }) => Promise<boolean>
  saveAll: () => Promise<void>
  saveActive: () => Promise<void>
  /** Format the current file manually (⇧⌥F / status bar badge): edits the buffer (undoable), marks dirty for auto-save. */
  formatActive: (tabId?: string) => Promise<boolean>
  reset: () => void
  onRenamed: (root: string, from: string, to: string) => void
  onDeleted: (root: string, rel: string) => void
}

const autoSaveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const suspendedSaves = new Set<string>()
const saveVersions = new Map<string, number>()
const pendingWrites = new Map<string, Set<Promise<unknown>>>()

function fileSaveKey(root: string, rel: string) {
  return JSON.stringify([root, rel])
}

export async function suspendFileSaves(
  root: string,
  paths: string[],
): Promise<(reschedule?: boolean | readonly string[]) => void> {
  const keys = paths.map((rel) => fileSaveKey(root, rel))
  for (const key of keys) {
    suspendedSaves.add(key)
    saveVersions.set(key, (saveVersions.get(key) ?? 0) + 1)
  }
  for (const tab of useTabs.getState().tabs) {
    if (tab.root === root && paths.includes(tab.rel)) cancelAutoSave(tab.id)
  }
  await Promise.allSettled(keys.flatMap((key) => [...(pendingWrites.get(key) ?? [])]))
  return (reschedule: boolean | readonly string[] = true) => {
    for (const key of keys) suspendedSaves.delete(key)
    if (!reschedule) return
    const retryPaths = reschedule === true ? paths : reschedule
    for (const tab of useTabs.getState().tabs) {
      if (tab.root === root && retryPaths.includes(tab.rel) && tab.dirty) scheduleAutoSave(tab.id)
    }
  }
}
/** Last manual format time: a double-click fires twice, the second must not toast "already formatted" */
let lastManualFormat = 0
/** In-flight mirror-state prewarm before a split, so repeated clicks do not create it twice */
const mirrorPreheat = new Map<string, Promise<void>>()
/** Ordinal of the last untitled buffer (Untitled-1, Untitled-2 …): only ever grows within a run */
let untitledCounter = 0

/**
 * Initial text of an untitled buffer that is not in the state cache yet (draft restored from disk, or a
 * ⌘N). Taken by the first EditorState build, so the text lands in the doc without a second state.
 */
const untitledSeed = new Map<string, string>()

/** Consume the seed text of an untitled tab (empty when there is none) */
export function takeUntitledSeed(id: string): string {
  const text = untitledSeed.get(id) ?? ''
  untitledSeed.delete(id)
  return text
}

/**
 * Word wrap lives in a Compartment, so flipping it only reconfigures the state. A file shown in both panes
 * has two states (main + mirror), each with its own compartment, so every pane showing it is dispatched to.
 */
function applyWordWrap(id: string, enabled: boolean) {
  const snapshot = useTabs.getState()
  for (const group of snapshot.groups) {
    if (group.activeId !== id) continue
    const view = getEditorView(group.id)
    if (view) setWordWrap(view, enabled)
  }
}

/** Untitled buffers as they are in memory right now (hot exit drafts) */
function collectUntitledDrafts(): UntitledDraft[] {
  return useTabs
    .getState()
    .tabs.filter((tab) => tab.kind === 'untitled')
    // A freshly restored tab may not have its EditorState yet: the seed still holds the text, and writing
    // an empty draft over a good one would lose it
    .map((tab) => ({
      seq: tab.seq ?? 1,
      text: getEditorState(tab.id)?.doc.toString() ?? untitledSeed.get(tab.id) ?? '',
    }))
}

/**
 * Splitting (copying) one file mounts a mirror state in the secondary. Creating it waits on the language
 * pack, so building it after mount wastes a frame; build it before touching the store so the first render
 * hits the cache.
 */
async function prewarmMirrorState(tab: Tab): Promise<void> {
  if (getEditorState(mirrorKey(tab.id))) return
  const inflight = mirrorPreheat.get(tab.id)
  if (inflight) return inflight

  const task = (async () => {
    try {
      let canonical = getEditorState(tab.id)
      if (!canonical) {
        const payload = await api.readFile(tab.root, tab.rel)
        if (payload.binary) return
        const settings = useSettings.getState()
        const tier = tierFor(payload.size)
        canonical = await createFileState({
          id: tab.id,
          root: tab.root,
          rel: tabFileRel(tab),
          content: payload.content,
          tier,
          readOnly: tier === 'preview' || tab.readOnly,
          conflicted:
            !tab.external && (await isConflictedFile(tab.root, tab.rel, payload.content)),
          importLinks: !tab.external,
          tabSize: tab.indentSize ?? settings.tabSize,
          useTabs: tab.useTabs,
          wordWrap: tab.wordWrap ?? settings.wordWrap,
          inlineBlame: settings.inlineBlame,
        })
      }
      await createMirrorState({ tab, canonical })
    } catch (e) {
      // A failed prewarm must not block the split: the secondary falls back to its own async path
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      mirrorPreheat.delete(tab.id)
    }
  })()
  mirrorPreheat.set(tab.id, task)
  return task
}

function patchGroup(groups: TabGroup[], id: TabGroupId, activeId: string | null): TabGroup[] {
  return groups.map((g) => (g.id === id ? { ...g, activeId } : g))
}

function deriveActiveId(groups: TabGroup[], activeGroupId: TabGroupId): string | null {
  return groups.find((g) => g.id === activeGroupId)?.activeId ?? null
}

/** Tabs of a group, in group order */
export function groupTabs(tabs: Tab[], group: TabGroup | undefined): Tab[] {
  if (!group || group.order.length === 0) return []
  const byId = new Map(tabs.map((t) => [t.id, t]))
  const list: Tab[] = []
  for (const id of group.order) {
    const tab = byId.get(id)
    if (tab) list.push(tab)
  }
  return list
}

/** Which panes show this tab */
function groupsWith(groups: TabGroup[], id: string): TabGroupId[] {
  return groups.filter((g) => g.order.includes(id)).map((g) => g.id)
}

/** After closing, fix group order and the active id (keep it unless removed, else fall back to the last) */
function withoutMarkdownPreview(group: TabGroup, id: string): TabGroup {
  if (!group.markdownPreview || !Object.hasOwn(group.markdownPreview, id)) return group
  const markdownPreview = { ...group.markdownPreview }
  delete markdownPreview[id]
  return { ...group, markdownPreview: Object.keys(markdownPreview).length > 0 ? markdownPreview : undefined }
}

/** After closing, fix group order and the active id (keep it unless removed, else fall back to the last) */
function settleGroups(groups: TabGroup[], removed: Set<string>): TabGroup[] {
  return groups.map((g) => {
    const order = g.order.filter((id) => !removed.has(id))
    const activeId = g.activeId && !removed.has(g.activeId) ? g.activeId : (order[order.length - 1] ?? null)
    let next: TabGroup = { ...g, order, activeId }
    for (const id of removed) next = withoutMarkdownPreview(next, id)
    return next
  })
}

/** Merge panes: secondary-only tabs join the primary, shared ones once; primary preview state wins. */
function mergeGroups(groups: TabGroup[]): TabGroup[] {
  const primary = groups.find((g) => g.id === 'primary')
  const secondary = groups.find((g) => g.id === 'secondary')
  const merged = [...(primary?.order ?? [])]
  for (const id of secondary?.order ?? []) {
    if (!merged.includes(id)) merged.push(id)
    dropEditorState(mirrorKey(id))
  }
  const activeId = primary?.activeId ?? secondary?.activeId ?? null
  const markdownPreview = {
    ...(secondary?.markdownPreview ?? {}),
    ...(primary?.markdownPreview ?? {}),
  }
  return [
    {
      id: 'primary',
      activeId,
      order: merged,
      markdownPreview: Object.keys(markdownPreview).length > 0 ? markdownPreview : undefined,
    },
  ]
}

/** Closing or dragging away the last tab collapses either pane, including Agent splits. */
function settleLayout(
  groups: TabGroup[],
  activeGroupId: TabGroupId,
  split: SplitOrientation | null,
): { groups: TabGroup[]; activeGroupId: TabGroupId; split: SplitOrientation | null } {
  if (!split || groups.length < 2) return { groups, activeGroupId, split }
  if (!groups.some((g) => g.order.length === 0)) return { groups, activeGroupId, split }
  return { groups: mergeGroups(groups), activeGroupId: 'primary', split: null }
}

/** Remove a tab from one group (registry untouched) */
function removeFromGroup(groups: TabGroup[], groupId: TabGroupId, id: string): TabGroup[] {
  return groups.map((g) => (g.id === groupId ? { ...g, order: g.order.filter((x) => x !== id) } : g))
}

/** Append a tab to a group and activate it (already there: just activate) */
function openInGroup(groups: TabGroup[], groupId: TabGroupId, id: string): TabGroup[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g
    const order = g.order.includes(id) ? g.order : [...g.order, id]
    return { ...g, order, activeId: id }
  })
}

/** Insert a tab into a group at an index and activate it (out of range goes to the end) */
function insertInGroup(groups: TabGroup[], groupId: TabGroupId, id: string, index: number): TabGroup[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g
    const order = g.order.filter((x) => x !== id)
    const at = Math.max(0, Math.min(index, order.length))
    order.splice(at, 0, id)
    return { ...g, order, activeId: id }
  })
}

/** Which pane to act on for this tab: the focused one first, else the first showing it */
function groupOfTab(
  groups: TabGroup[],
  activeGroupId: TabGroupId,
  id: string,
): TabGroup | undefined {
  const active = groups.find((g) => g.id === activeGroupId)
  if (active?.order.includes(id)) return active
  return groups.find((g) => g.order.includes(id))
}

function cancelAutoSave(id: string) {
  const timer = autoSaveTimers.get(id)
  if (timer) {
    clearTimeout(timer)
    autoSaveTimers.delete(id)
  }
}

/**
 * The target pane must exist: after unsplit, a ⌘⇧T restore / drop index may still point at the collapsed
 * secondary, and without a fallback the tab lands in a hidden group.
 */
function resolveGroupId(groupId: TabGroupId | undefined): TabGroupId {
  const { groups, tabs, activeGroupId } = useTabs.getState()
  if (groupId && groups.some((g) => g.id === groupId)) return groupId
  // With a focused chat on the right, ordinary opens go to the code pane so the conversation stays
  // visible for comparison. Drops and other explicit group targets above keep their chosen pane.
  const active = groups.find((g) => g.id === activeGroupId)
  const activeTab = tabs.find((tab) => tab.id === active?.activeId)
  if (groups.length > 1 && activeGroupId === 'secondary' && activeTab?.kind === 'chat') {
    return 'primary'
  }
  return activeGroupId
}

type OpenRequest = {
  groupId: TabGroupId
  tabId: string
  sequence: number
  token: number
  epoch: number
}

/** Last ordinary-open request per pane: a slow read must not overwrite a newer tab. */
const openRequestSequence = new Map<TabGroupId, number>()
/** The newest request for a file id owns any cache created for that id while requests overlap. */
const latestOpenTokenByTab = new Map<string, number>()
/** Requests still reading a tab id: an older request must not release a newer request's cache. */
const pendingOpenTokensByTab = new Map<string, Set<number>>()
const pendingOpenRequests = new Set<number>()
let openRequestToken = 0
/** Bumped by reset so a request from the old workspace can never become current after sequences restart. */
let openRequestEpoch = 0

function beginOpenRequest(groupId: TabGroupId, tabId: string): OpenRequest {
  const sequence = (openRequestSequence.get(groupId) ?? 0) + 1
  const token = ++openRequestToken
  openRequestSequence.set(groupId, sequence)
  latestOpenTokenByTab.set(tabId, token)
  const pendingForTab = pendingOpenTokensByTab.get(tabId) ?? new Set<number>()
  pendingForTab.add(token)
  pendingOpenTokensByTab.set(tabId, pendingForTab)
  pendingOpenRequests.add(token)
  return { groupId, tabId, sequence, token, epoch: openRequestEpoch }
}

function isCurrentOpenRequest(request: OpenRequest): boolean {
  return (
    request.epoch === openRequestEpoch &&
    openRequestSequence.get(request.groupId) === request.sequence
  )
}

function finishOpenRequest(request: OpenRequest) {
  pendingOpenRequests.delete(request.token)
  const pendingForTab = pendingOpenTokensByTab.get(request.tabId)
  pendingForTab?.delete(request.token)
  if (pendingForTab?.size === 0) pendingOpenTokensByTab.delete(request.tabId)
  // A reset invalidates every in-flight sequence but leaves these per-tab sets intact. Once the final
  // same-file request finishes, release any cache that never reached the tab registry and retire the map entry.
  if (!pendingForTab || pendingForTab.size === 0) {
    discardPreparedTab(request.tabId)
    latestOpenTokenByTab.delete(request.tabId)
  }
  if (pendingOpenRequests.size === 0 && useTabs.getState().opening) {
    useTabs.setState({ opening: false })
  }
}

/**
 * Release everything that belongs to a tab which never made it into the store. A newer request for the same
 * file owns the cache while it is pending (or after it completed), so a stale request must leave it alone.
 */
function discardPreparedTab(id: string, requestToken?: number) {
  if (requestToken !== undefined && latestOpenTokenByTab.get(id) !== requestToken) return
  const pendingForTab = pendingOpenTokensByTab.get(id)
  if (pendingForTab && [...pendingForTab].some((token) => token !== requestToken)) return
  if (useTabs.getState().tabs.some((tab) => tab.id === id)) return
  cancelAutoSave(id)
  dropEditorState(id)
  forgetScrollForTab(id)
  dropScrollRatio(id)
  useBlame.getState().invalidate(id)
}

/** At most one replaceable preview belongs to a pane; two candidates mean an old race, so keep both. */
function temporaryTabInGroup(tabs: Tab[], groups: TabGroup[], groupId: TabGroupId): Tab | undefined {
  const group = groups.find((g) => g.id === groupId)
  if (!group) return undefined
  const candidates = groupTabs(tabs, group).filter(
    (tab) =>
      tab.temporary &&
      !tab.dirty &&
      !tab.pinned &&
      (tab.kind === 'file' || tab.kind === 'image'),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

/** Replace a preview in place, leaving both its pane position and active id on the new tab. */
function replaceInGroup(
  groups: TabGroup[],
  groupId: TabGroupId,
  oldId: string,
  newId: string,
): TabGroup[] {
  return groups.map((group) => {
    if (group.id !== groupId) return group
    return withoutMarkdownPreview(
      {
        ...group,
        order: group.order.map((id) => (id === oldId ? newId : id)),
        activeId: newId,
      },
      oldId,
    )
  })
}

/**
 * Commit a successfully read tab. Preview replacement removes only the pane's ownership while the old tab is
 * still visible elsewhere; a fully replaced preview is discarded without entering the reopen stack.
 */
function commitOpenedTab(
  tab: Tab,
  groupId: TabGroupId,
  index: number | undefined,
  temporary: boolean,
  requestToken: number,
): boolean {
  const state = useTabs.getState()
  if (!state.groups.some((group) => group.id === groupId)) {
    discardPreparedTab(tab.id, requestToken)
    return false
  }

  const target = state.groups.find((group) => group.id === groupId)!
  const existing = state.tabs.find((current) => current.id === tab.id)
  const alreadyOwned = target.order.includes(tab.id)
  // Opening an already-owned tab activates it; it must not consume another preview in the same pane.
  const replaced =
    temporary && !alreadyOwned
      ? temporaryTabInGroup(state.tabs, state.groups, groupId)
      : undefined
  const groups = replaced
    ? replaceInGroup(state.groups, groupId, replaced.id, tab.id)
    : index === undefined
      ? openInGroup(state.groups, groupId, tab.id)
      : insertInGroup(state.groups, groupId, tab.id, index)
  const replacedStillShown =
    replaced !== undefined && groups.some((group) => group.order.includes(replaced.id))
  // Keep one registry entry per file id. Two panes can finish reading the same file concurrently; the later
  // commit must join the pane instead of appending a duplicate registry entry. Do not downgrade a permanent
  // tab just because a later ordinary open requested a preview.
  let tabs = existing
    ? state.tabs.map((current) =>
        current.id === tab.id
          ? { ...current, temporary: temporary ? current.temporary : false }
          : current,
      )
    : [...state.tabs, tab]
  if (replaced && !replacedStillShown) {
    tabs = tabs.filter((current) => current.id !== replaced.id)
  }
  const cursors = existing
    ? { ...state.cursors }
    : { ...state.cursors, [tab.id]: { line: 1, col: 1 } }
  if (replaced && !replacedStillShown) delete cursors[replaced.id]

  useTabs.setState({
    tabs,
    groups,
    activeId: tab.id,
    activeGroupId: groupId,
    cursors,
  })

  if (replaced && !replacedStillShown) discardPreparedTab(replaced.id)
  return true
}

export const useTabs = create<TabsStore>((set, get) => ({
  tabs: [],
  activeId: null,
  groups: [{ id: 'primary', activeId: null, order: [] }],
  activeGroupId: 'primary',
  splitOrientation: null,
  splitRatio: SPLIT_RATIO_DEFAULT,
  cursors: {},
  reveal: null,
  opening: false,
  closedTabs: [],
  stateEpoch: 0,
  diffEpoch: {},
  formatting: false,

  openExternalFile: async (path, options) => {
    let info
    try {
      info = await api.grantFile(path)
    } catch (e) {
      if (!options?.quiet) useUi.getState().toast(errorText(e), 'error')
      return
    }
    const id = fileTabId(info.path, '')
    const groupId = resolveGroupId(options?.groupId)
    const request = beginOpenRequest(groupId, id)
    set({ opening: true })
    try {
      const existing = get().tabs.find((t) => t.id === id)
      if (existing) {
        // External files are explicit opens, never preview replacements.
        if (existing.temporary) get().promoteTab(id)
        const groups =
          options?.index === undefined
            ? openInGroup(get().groups, groupId, id)
            : insertInGroup(get().groups, groupId, id, options.index)
        set({ activeId: id, activeGroupId: groupId, groups })
        return
      }

      forgetScrollForTab(id)
      const name = basename(info.path)
      if (isImagePath(name)) {
        const tab: Tab = {
          id,
          root: info.path,
          kind: 'image',
          rel: '',
          name,
          dirty: false,
          readOnly: true,
          tier: 'preview',
          pinned: false,
          temporary: false,
          external: true,
          size: info.size,
          mtime: info.mtime,
        }
        commitOpenedTab(tab, groupId, options?.index, false, request.token)
        return
      }

      const payload = await api.readFile(info.path, '')
      if (!isCurrentOpenRequest(request)) return
      if (payload.binary) {
        if (!options?.quiet) useUi.getState().toast(t('toast.binaryFile'), 'error')
        return
      }
      const tier = tierFor(payload.size)
      const settings = useSettings.getState()
      const readOnly = tier === 'preview'
      const meta = detectTextMeta(payload.content)
      // `rel` is only the language hint here: the tab's real rel stays empty so the backend keeps
      // resolving `root` as the exact file, never parent/child paths.
      await createFileState({
        id,
        root: info.path,
        rel: name,
        content: payload.content,
        tier,
        readOnly,
        conflicted: false,
        importLinks: false,
        tabSize: meta.indentSize ?? settings.tabSize,
        useTabs: meta.useTabs,
        wordWrap: settings.wordWrap,
        inlineBlame: false,
      })
      if (!isCurrentOpenRequest(request)) {
        discardPreparedTab(id, request.token)
        return
      }
      const tab: Tab = {
        id,
        root: info.path,
        kind: 'file',
        rel: '',
        name,
        dirty: false,
        readOnly,
        tier,
        pinned: false,
        temporary: false,
        external: true,
        size: payload.size,
        mtime: payload.mtime,
        eol: meta.eol,
        indentSize: meta.indentSize,
        useTabs: meta.useTabs,
      }
      if (!commitOpenedTab(tab, groupId, options?.index, false, request.token)) return
      // Deliberately no setActiveRoot / revealInTree / blame: the file is outside every project.
    } catch (e) {
      if (!get().tabs.some((tab) => tab.id === id)) discardPreparedTab(id, request.token)
      if (!options?.quiet && isCurrentOpenRequest(request)) {
        useUi.getState().toast(errorText(e), 'error')
      }
    } finally {
      finishOpenRequest(request)
    }
  },

  openFile: async (root, rel, options) => {
    const id = fileTabId(root, rel)
    const groupId = resolveGroupId(options?.groupId)
    const request = beginOpenRequest(groupId, id)
    set({ opening: true })
    try {
      const existing = get().tabs.find((t) => t.id === id)
      if (existing) {
        // A drop / save-as / reopen is an explicit preserve: promote an already-open preview rather than
        // silently keeping it temporary just because the fast path did not need to read the file again.
        if (options?.temporary === false && existing.temporary) get().promoteTab(id)
        // Already open in another pane: it must exist in the target pane too (VSCode-like synced panes)
        const groups =
          options?.index === undefined
            ? openInGroup(get().groups, groupId, id)
            : insertInGroup(get().groups, groupId, id, options.index)
        set({ activeId: id, activeGroupId: groupId, groups })
        useWorkspace.getState().setActiveRoot(root)
        revealInTree(existing)
        // A conflicted file lands on its first conflict again when switched back, to keep working on it
        const blocks = getEditorState(id)?.field(conflictField, false)
        if (blocks && blocks.length > 0) {
          set({
            reveal: { tabId: id, line: blocks[0].startLine, col: 1, nonce: Date.now() },
          })
        }
        // 打开文件就关掉同一文件的差异标签页：差异只是预览，编辑时不再并排留着
        if (!options?.keepDiffs) await closeDiffsFor(root, rel)
        return
      }

      const temporary = options?.temporary ?? true
      // A new tab starts at line 1: any remembered scroll position for this id is void
      forgetScrollForTab(id)

      // Images go to preview: never read as text (binary detection would reject them), no EditorState either
      if (isImagePath(rel)) {
        const stat = await api.statFile(root, rel)
        if (!isCurrentOpenRequest(request)) return
        const tab: Tab = {
          id,
          root,
          kind: 'image',
          rel,
          name: basename(rel),
          dirty: false,
          readOnly: true,
          tier: 'preview',
          pinned: false,
          temporary,
          size: stat.size,
          mtime: stat.mtime,
        }
        if (!commitOpenedTab(tab, groupId, options?.index, temporary, request.token)) return
        useWorkspace.getState().setActiveRoot(root)
        revealInTree(tab)
        if (!options?.keepDiffs) await closeDiffsFor(root, rel)
        return
      }

      const payload = await api.readFile(root, rel)
      if (!isCurrentOpenRequest(request)) return
      if (payload.binary) {
        if (!options?.quiet) useUi.getState().toast(t('toast.binaryFile'), 'error')
        return
      }
      const tier = tierFor(payload.size)
      const settings = useSettings.getState()
      const readOnly = tier === 'preview'
      const meta = detectTextMeta(payload.content)
      const conflicted = await isConflictedFile(root, rel, payload.content)
      const state = await createFileState({
        id,
        root,
        rel,
        content: payload.content,
        tier,
        readOnly,
        conflicted,
        tabSize: meta.indentSize ?? settings.tabSize,
        useTabs: meta.useTabs,
        wordWrap: settings.wordWrap,
        inlineBlame: settings.inlineBlame,
      })
      if (!isCurrentOpenRequest(request)) {
        discardPreparedTab(id, request.token)
        return
      }
      const tab: Tab = {
        id,
        root,
        kind: 'file',
        rel,
        name: basename(rel),
        dirty: false,
        readOnly,
        tier,
        pinned: false,
        temporary,
        size: payload.size,
        mtime: payload.mtime,
        eol: meta.eol,
        indentSize: meta.indentSize,
        useTabs: meta.useTabs,
      }
      if (!commitOpenedTab(tab, groupId, options?.index, temporary, request.token)) return
      useWorkspace.getState().setActiveRoot(root)
      revealInTree(tab)
      useBlame.getState().scheduleFetch(tab)
      // 打开文件就关掉同一文件的差异标签页：差异只是预览，编辑时不再并排留着
      if (!options?.keepDiffs) await closeDiffsFor(root, rel)
      // Unmerged file: land on the first conflict after opening, the gutter marks the rest
      if (conflicted && isCurrentOpenRequest(request) && get().activeId === id) {
        const blocks = state.field(conflictField, false)
        if (blocks && blocks.length > 0) {
          set({
            reveal: { tabId: id, line: blocks[0].startLine, col: 1, nonce: Date.now() },
          })
        }
      }
    } catch (e) {
      if (!get().tabs.some((tab) => tab.id === id)) discardPreparedTab(id, request.token)
      if (!options?.quiet && isCurrentOpenRequest(request)) {
        useUi.getState().toast(errorText(e), 'error')
      }
    } finally {
      finishOpenRequest(request)
    }
  },

  openFileInGroup: async (root, rel, groupId, index) => {
    await get().openFile(root, rel, { groupId, index, temporary: false })
    // Opening may be async (read + build EditorState) and the active pane can change meanwhile;
    // a drop means "open in the pane it landed in", so pin the target pane once more here.
    const state = get()
    const id = fileTabId(root, rel)
    if (!state.tabs.some((t) => t.id === id)) return
    const group = state.groups.find((g) => g.id === groupId)
    if (!group) return
    if (!group.order.includes(id)) {
      set({
        groups: openInGroup(state.groups, groupId, id),
        activeGroupId: groupId,
        activeId: id,
      })
      return
    }
    if (state.activeGroupId !== groupId || group.activeId !== id) {
      set({ groups: patchGroup(state.groups, groupId, id), activeGroupId: groupId, activeId: id })
    }
  },

  openWelcome: () => {
    const id = WELCOME_TAB_ID
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      get().activate(id)
      return
    }
    const groupId = get().activeGroupId
    const tab: Tab = {
      id,
      root: '',
      kind: 'welcome',
      rel: '',
      // Titles stay out of state: welcome / settings / diff names are resolved from the current language at render
      name: '',
      dirty: false,
      readOnly: true,
      tier: 'full',
      pinned: false,
      temporary: false,
      mtime: 0,
    }
    set({
      tabs: [...get().tabs, tab],
      activeId: id,
      groups: openInGroup(get().groups, groupId, id),
    })
  },

  openSettings: () => {
    const id = SETTINGS_TAB_ID
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      get().activate(id)
      return
    }
    const groupId = get().activeGroupId
    const tab: Tab = {
      id,
      root: '',
      kind: 'settings',
      rel: '',
      name: '',
      dirty: false,
      readOnly: true,
      tier: 'full',
      pinned: false,
      temporary: false,
      mtime: 0,
    }
    set({
      tabs: [...get().tabs, tab],
      activeId: id,
      groups: openInGroup(get().groups, groupId, id),
    })
  },

  openChat: (chatId, root, title) => {
    const id = `chat:${chatId}`
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      get().activate(id)
      if (existing.name !== title) get().setTabName(id, title)
      return
    }
    const groupId = get().activeGroupId
    const tab: Tab = {
      id,
      root,
      kind: 'chat',
      rel: '',
      name: title,
      dirty: false,
      readOnly: true,
      tier: 'full',
      pinned: false,
      temporary: false,
      mtime: 0,
    }
    set({
      tabs: [...get().tabs, tab],
      activeId: id,
      groups: openInGroup(get().groups, groupId, id),
    })
    if (root) useWorkspace.getState().setActiveRoot(root)
  },

  openChatInRight: (chatId, root, title) => {
    const id = `chat:${chatId}`
    const state = get()
    const existing = state.tabs.find((tab) => tab.id === id)
    const tab: Tab = existing ?? {
      id,
      root,
      kind: 'chat',
      rel: '',
      name: title,
      dirty: false,
      readOnly: true,
      tier: 'full',
      pinned: false,
      temporary: false,
      mtime: 0,
    }
    const tabs = existing
      ? state.tabs.map((current) =>
          current.id === id && current.name !== title ? { ...current, name: title } : current,
        )
      : [...state.tabs, tab]
    if (state.tabs.length === 0) {
      const primary: TabGroup =
        state.groups.find((group) => group.id === 'primary') ??
        ({ id: 'primary', activeId: null, order: [] } satisfies TabGroup)
      set({
        tabs,
        groups: [{ ...primary, activeId: id, order: [id] }],
        activeId: id,
        activeGroupId: 'primary',
        splitOrientation: null,
      })
      if (root) useWorkspace.getState().setActiveRoot(root)
      return
    }
    const isNewSplit = state.groups.length < 2
    const primary = state.groups.find((group) => group.id === 'primary') ?? state.groups[0]
    const groups = isNewSplit
      ? [primary, { id: 'secondary', activeId: id, order: [id] } satisfies TabGroup]
      : openInGroup(state.groups, 'secondary', id)
    set({
      tabs,
      groups,
      activeId: id,
      activeGroupId: 'secondary',
      splitOrientation: 'row',
      // A first chat split favors code; an existing split keeps the user's current draggable width.
      ...(isNewSplit ? { splitRatio: CHAT_SPLIT_RATIO } : {}),
    })
    if (root) useWorkspace.getState().setActiveRoot(root)
  },

  replaceChatTab: (previousChatId, chatId, root, title) => {
    const previousId = `chat:${previousChatId}`
    const id = `chat:${chatId}`
    const state = get()
    const previous = state.tabs.find(tab => tab.id === previousId && tab.kind === 'chat' && tab.root === root)
    if (!previous || state.tabs.some(tab => tab.id === id) || agentBridge.isChatRunning(previousChatId)) return false
    const group = state.groups.find(group => group.id === state.activeGroupId && group.order.includes(previousId)) ??
      state.groups.find(group => group.order.includes(previousId))
    if (!group) return false
    set({
      tabs: state.tabs.map(tab => tab.id === previousId ? { ...tab, id, name: title } : tab),
      groups: state.groups.map(current => ({ ...current,
        order: current.order.map(tabId => tabId === previousId ? id : tabId),
        activeId: current.id === group.id || current.activeId === previousId ? id : current.activeId,
      })),
      activeId: id,
      activeGroupId: group.id,
    })
    useWorkspace.getState().setActiveRoot(root)
    return true
  },

  setTabName: (id, name) => {
    set({ tabs: get().tabs.map((tab) => (tab.id === id ? { ...tab, name } : tab)) })
  },

  openUntitled: (options) => {
    const groupId = resolveGroupId(options?.groupId)
    untitledCounter += 1
    const seq = options?.seq ?? untitledCounter
    const id = `untitled:${seq}`
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      get().activate(id)
      return id
    }
    const text = options?.text ?? ''
    const tab: Tab = {
      id,
      root: '',
      kind: 'untitled',
      rel: '',
      // The title is resolved at render time (tabTitle), so switching language renames it
      name: '',
      dirty: false,
      readOnly: false,
      tier: 'full',
      pinned: false,
      temporary: false,
      seq,
      size: text.length,
      mtime: 0,
    }
    // The EditorState is built by EditorHost on mount (editor/openState): creating one here too would race
    // with it and could mount the empty draft. The seed text waits for that first build instead.
    if (text) untitledSeed.set(id, text)
    set({
      tabs: [...get().tabs, tab],
      activeId: id,
      groups: openInGroup(get().groups, groupId, id),
      cursors: { ...get().cursors, [id]: { line: 1, col: 1 } },
    })
    if (text) get().markDirty(id)
    return id
  },

  saveAs: async (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind !== 'untitled') return false
    const text = getEditorState(id)?.doc.toString() ?? ''
    const suggested = t('tab.untitledFileName', { count: tab.seq ?? 1 })
    const current = activeRoot()
    let picked: string | null = null
    try {
      picked = await saveDialog({
        // No project: let the native dialog start at its own last location.
        ...(current ? { defaultPath: `${current.id}/${suggested}` } : {}),
        title: t('dialog.saveAs.title'),
      })
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    }
    if (!picked) return false

    const inside = useWorkspace
      .getState()
      .roots.map((root) => ({ root: root.id, rel: relFromAbsolute(root.id, picked!) }))
      .find((candidate) => Boolean(candidate.rel))
    if (inside?.rel) {
      try {
        const dir = dirname(inside.rel)
        // Nested target folder: create_dir_all, and an existing folder is not an error
        if (dir) await api.createEntry(inside.root, dir, 'dir').catch(() => {})
        await api.writeFile(inside.root, inside.rel, text)
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
        return false
      }
      // The buffer becomes a normal file: close it and open the file from disk (language pack, EOL, blame)
      await get().close(id, true)
      await useWorkspace.getState().refreshDir(inside.root, dirname(inside.rel)).catch(() => {})
      useFileIndex.getState().invalidate(inside.root)
      await get().openFile(inside.root, inside.rel, { temporary: false })
      useUi.getState().toast(t('toast.savedAs', { name: inside.rel }), 'success')
      return true
    }

    // Outside every project: grant exactly this file, write through the same root/rel contract,
    // then keep it open as an external tab that saves in place from now on.
    let externalPath: string
    try {
      const granted = await api.grantFile(picked)
      await api.writeFile(granted.path, '', text)
      externalPath = granted.path
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    }
    await get().close(id, true)
    await get().openExternalFile(externalPath)
    useUi.getState().toast(t('toast.savedAs', { name: basename(externalPath) }), 'success')
    return true
  },

  restoreUntitledDrafts: () => {
    for (const draft of loadUntitledDrafts()) {
      if (!draft.text.trim()) continue
      untitledCounter = Math.max(untitledCounter, draft.seq)
      get().openUntitled({ text: draft.text, seq: draft.seq })
    }
  },

  applyRestoredMeta: (id, meta) => {
    const tab = get().tabs.find((t) => t.id === id)
    // Only a tab that was never read needs it, and only while it is still clean: an edited tab's meta must not
    // be replaced by what the disk happens to hold
    if (!tab || tab.kind !== 'file' || tab.eol !== undefined || tab.dirty) return
    set({
      tabs: get().tabs.map((t) =>
        t.id === id
          ? {
              ...t,
              size: meta.size,
              mtime: meta.mtime,
              eol: meta.eol,
              indentSize: meta.indentSize,
              useTabs: meta.useTabs,
              tier: meta.tier,
              readOnly: t.readOnly || meta.tier === 'preview',
            }
          : t,
      ),
    })
  },

  toggleWordWrap: (id) => {
    const state = get()
    const tabId = id ?? state.activeId
    if (!tabId) return
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!tab) return
    if (tab.kind !== 'file' && tab.kind !== 'untitled') return
    // Large files never wrap (see wrapCompartment): flipping it would write a setting that does nothing
    if (tab.tier !== 'full') {
      useUi.getState().toast(t('toast.wordWrapUnavailable'), 'info')
      return
    }
    const next = !(tab.wordWrap ?? useSettings.getState().wordWrap)
    set({ tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, wordWrap: next } : t)) })
    applyWordWrap(tabId, next)
  },

  openAt: async (root, rel, line, col, length) => {
    await get().openFile(root, rel)
    const id = fileTabId(root, rel)
    set({ reveal: { tabId: id, line, col, length, nonce: Date.now() } })
  },

  openDiff: async (root, rel, staged) => {
    const id = diffTabId(root, rel, staged)
    const existing = get().tabs.find((t) => t.id === id)
    if (existing) {
      const groupId = resolveGroupId(undefined)
      set({ activeId: id, activeGroupId: groupId, groups: openInGroup(get().groups, groupId, id) })
      return
    }
    const groupId = resolveGroupId(undefined)
    // DiffView fetches the patch itself (full-context diff) on demand; here we only create the tab
    const tab: Tab = {
      id,
      root,
      kind: 'diff',
      rel,
      name: basename(rel),
      dirty: false,
      readOnly: true,
      tier: 'preview',
      pinned: false,
      temporary: false,
      staged,
      mtime: 0,
    }
    set({
      tabs: [...get().tabs, tab],
      activeId: id,
      activeGroupId: groupId,
      groups: openInGroup(get().groups, groupId, id),
    })
  },

  switchDiffToFile: async (diffTabId, scrollRatio) => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === diffTabId)
    if (!tab || tab.kind !== 'diff') return
    const fileId = fileTabId(tab.root, tab.rel)
    // Hand the position over before opening: the editor's mount effect (which applies it) may run
    // before this await resolves. A failed open drops it again below.
    handOffScrollRatio(fileId, scrollRatio)
    // Take the diff's slot in the same pane: the file view replaces it instead of hopping to another tab
    const owner = state.groups.find((g) => g.order.includes(diffTabId))
    const index = owner ? owner.order.indexOf(diffTabId) : undefined
    // keepDiffs: another diff of the same file (staged vs unstaged) is still worth reading
    await get().openFile(tab.root, tab.rel, {
      quiet: true,
      keepDiffs: true,
      groupId: owner?.id,
      index,
      temporary: false,
    })
    if (!get().tabs.some((t) => t.id === fileId)) dropScrollRatio(fileId)
    // No file view to replace it with (deleted / folder / too large): the tab has nothing left to show
    await get().close(diffTabId)
  },

  /** Reload file content after search-replace; silent is for batch refresh: no jump, no focus grab */
  reload: async (root, rel, options) => {
    const id = fileTabId(root, rel)
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || tab.kind !== 'file') return
    try {
      const payload = await api.readFile(root, rel)
      if (payload.binary) return
      dropEditorState(id)
      const settings = useSettings.getState()
      const tier = tierFor(payload.size)
      const meta = detectTextMeta(payload.content)
      const state = await createFileState({
        id,
        root,
        rel,
        content: payload.content,
        tier,
        readOnly: tier === 'preview',
        conflicted: await isConflictedFile(root, rel, payload.content),
        tabSize: meta.indentSize ?? settings.tabSize,
        useTabs: meta.useTabs,
        wordWrap: tab.wordWrap ?? settings.wordWrap,
        inlineBlame: settings.inlineBlame,
      })
      applyActiveState(id, state)
      set({
        tabs: get().tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                dirty: false,
                mtime: payload.mtime,
                size: payload.size,
                tier,
                eol: meta.eol,
                indentSize: meta.indentSize,
                useTabs: meta.useTabs,
              }
            : t,
        ),
        stateEpoch: get().stateEpoch + 1,
      })
      if (!options?.silent) {
        set({ reveal: { tabId: id, line: 1, col: 1, nonce: Date.now() } })
      }
      useBlame.getState().invalidate(id)
      useBlame.getState().scheduleFetch({ ...tab, mtime: payload.mtime })
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    }
  },

  activate: (id, groupId) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    const { groups, activeGroupId } = get()
    // Activate in the pane that was clicked; without one, prefer the focused pane (a file can be in both)
    const target =
      groupId && groups.some((g) => g.id === groupId && g.order.includes(id))
        ? groupId
        : groups.some((g) => g.id === activeGroupId && g.order.includes(id))
          ? activeGroupId
          : groups.find((g) => g.order.includes(id))?.id
    if (!target) return
    set({ activeId: id, activeGroupId: target, groups: patchGroup(groups, target, id) })
    // A chat belongs to the project it was started in: follow its root, but never reveal a tree row
    if (tab.kind === 'chat') {
      if (tab.root) useWorkspace.getState().setActiveRoot(tab.root)
      return
    }
    // Welcome / settings / untitled have no file to reveal: do not touch the project or tree.
    if (
      tab.kind === 'welcome' ||
      tab.kind === 'settings' ||
      tab.kind === 'untitled'
    )
      return
    // External files belong to no project either (their root is a file path, not a workspace).
    // Restored tabs start at line 1, so re-apply the remembered caret on activation.
    if (tab.external) {
      const cursor = get().cursors[id]
      if (cursor) {
        set({
          reveal: {
            tabId: id,
            line: cursor.line,
            col: cursor.col,
            nonce: Date.now(),
            caret: true,
          },
        })
      }
      return
    }
    useWorkspace.getState().setActiveRoot(tab.root)
    revealInTree(tab)
    // A cache hit is a no-op; a tab whose blame was invalidated by a background reload refetches when activated
    if (tab.kind === 'file') useBlame.getState().scheduleFetch(tab)
  },

  activateOffset: (delta) => {
    const { groups, activeGroupId, tabs } = get()
    const group = groups.find((g) => g.id === activeGroupId)
    const list = groupTabs(tabs, group)
    if (list.length === 0) return
    const index = list.findIndex((t) => t.id === group?.activeId)
    const next = list[(index + delta + list.length) % list.length]
    if (next) get().activate(next.id, activeGroupId)
  },

  setActiveGroup: (id) => {
    const state = get()
    if (!state.groups.some((g) => g.id === id)) return
    if (state.activeGroupId === id) return
    set({ activeGroupId: id, activeId: deriveActiveId(state.groups, id) })
  },

  setSplitRatio: (ratio) => {
    set({ splitRatio: Math.min(SPLIT_RATIO_MAX, Math.max(SPLIT_RATIO_MIN, ratio)) })
  },

  toggleMarkdownPreview: (groupId, tabId) => {
    const state = get()
    const group = state.groups.find((g) => g.id === groupId)
    const tab = state.tabs.find((t) => t.id === tabId)
    if (!group?.order.includes(tabId) || tab?.kind !== 'file' || !isMarkdownPath(tab.rel)) return
    const markdownPreview = { ...(group.markdownPreview ?? {}) }
    if (Object.hasOwn(markdownPreview, tabId)) delete markdownPreview[tabId]
    else markdownPreview[tabId] = MARKDOWN_PREVIEW_RATIO_DEFAULT
    set({
      groups: state.groups.map((g) =>
        g.id === groupId
          ? {
              ...g,
              markdownPreview:
                Object.keys(markdownPreview).length > 0 ? markdownPreview : undefined,
            }
          : g,
      ),
    })
  },

  setMarkdownPreviewRatio: (groupId, tabId, ratio) => {
    const state = get()
    const group = state.groups.find((g) => g.id === groupId)
    if (!group?.markdownPreview || !Object.hasOwn(group.markdownPreview, tabId)) return
    const next = Math.min(
      MARKDOWN_PREVIEW_RATIO_MAX,
      Math.max(MARKDOWN_PREVIEW_RATIO_MIN, ratio),
    )
    if (group.markdownPreview[tabId] === next) return
    set({
      groups: state.groups.map((g) =>
        g.id === groupId
          ? { ...g, markdownPreview: { ...(g.markdownPreview ?? {}), [tabId]: next } }
          : g,
      ),
    })
  },

  split: async (orientation, move) => {
    const state = get()
    const primary = state.groups[0]
    // There is a focused-pane concept: split / move acts on the pane the user is looking at
    const activeId =
      state.groups.find((g) => g.id === state.activeGroupId)?.activeId ?? primary.activeId
    if (activeId) get().promoteTab(activeId)

    if (state.groups.length > 1) {
      // Already split: just change orientation; "split and move" moves the current tab to the other pane (max two)
      set({ splitOrientation: orientation })
      if (move && activeId) get().moveTabToGroup(activeId, 'secondary')
      return
    }

    // ⌘\ default: the current file fills both panes with live sync. The mirror state waits on the language pack,
    // so build it before switching layout or the secondary's first frame is blank (and stays blank on error).
    if (!move && activeId) {
      const tab = state.tabs.find((t) => t.id === activeId)
      if (tab?.kind === 'file') await prewarmMirrorState(tab)
    }

    // Prewarm is async: another file may have opened / the tab may have closed, so re-snapshot
    const latest = get()
    if (latest.groups.length > 1) return
    const latestPrimary = latest.groups[0]
    const targetId =
      latest.groups.find((g) => g.id === latest.activeGroupId)?.activeId ?? latestPrimary.activeId

    const secondary: TabGroup = { id: 'secondary', activeId: null, order: [] }
    let nextPrimary = latestPrimary

    if (move) {
      if (!targetId) return
      const order = latestPrimary.order.filter((id) => id !== targetId)
      nextPrimary = withoutMarkdownPreview(
        { ...latestPrimary, order, activeId: order[order.length - 1] ?? null },
        targetId,
      )
      secondary.order = [targetId]
      secondary.activeId = targetId
    } else if (targetId) {
      secondary.order = [targetId]
      secondary.activeId = targetId
      nextPrimary = { ...latestPrimary, activeId: targetId }
    }

    set({
      groups: [nextPrimary, secondary],
      activeGroupId: 'secondary',
      splitOrientation: orientation,
      activeId: secondary.activeId,
    })
  },

  unsplit: () => {
    const { groups } = get()
    if (groups.length < 2) return
    const merged = mergeGroups(groups)
    set({
      groups: merged,
      activeGroupId: 'primary',
      splitOrientation: null,
      activeId: merged[0].activeId,
    })
  },

  moveTab: (groupId, from, to) => {
    const groups = get().groups
    const group = groups.find((g) => g.id === groupId)
    if (!group) return
    const order = [...group.order]
    if (from === to || from < 0 || to < 0 || from >= order.length || to >= order.length) return
    const [moved] = order.splice(from, 1)
    order.splice(to, 0, moved)
    set({ groups: groups.map((g) => (g.id === groupId ? { ...g, order } : g)) })
  },

  moveTabToGroup: (id, target, index) => {
    const state = get()
    if (state.groups.length < 2) return
    if (!state.tabs.some((t) => t.id === id)) return
    const source = state.groups.find((g) => g.id !== target)
    const dest = state.groups.find((g) => g.id === target)
    if (!source || !dest) return
    if (dest.order.includes(id) && !source.order.includes(id)) return
    get().promoteTab(id)

    const sourceOrder = source.order.filter((x) => x !== id)
    const destOrder = dest.order.filter((x) => x !== id)
    const at = Math.max(0, Math.min(index ?? destOrder.length, destOrder.length))
    destOrder.splice(at, 0, id)

    const movedPreviewRatio = source.markdownPreview?.[id]
    const groups = state.groups.map((g) => {
      if (g.id === target) {
        const markdownPreview =
          movedPreviewRatio !== undefined && !Object.hasOwn(g.markdownPreview ?? {}, id)
            ? { ...(g.markdownPreview ?? {}), [id]: movedPreviewRatio }
            : g.markdownPreview
        return { ...g, order: destOrder, activeId: id, markdownPreview }
      }
      if (g.id === source.id) {
        const activeId =
          g.activeId && g.activeId !== id ? g.activeId : (sourceOrder[sourceOrder.length - 1] ?? null)
        return withoutMarkdownPreview({ ...g, order: sourceOrder, activeId }, id)
      }
      return g
    })
    // After the move the mirror state is dead if only one pane shows it
    if (groups.filter((g) => g.order.includes(id)).length <= 1) dropEditorState(mirrorKey(id))
    // Dragging the last tab out of a pane empties it: collapse that pane too
    const layout = settleLayout(groups, target, get().splitOrientation)
    set({
      groups: layout.groups,
      activeGroupId: layout.activeGroupId,
      splitOrientation: layout.split,
      activeId: deriveActiveId(layout.groups, layout.activeGroupId),
    })
  },

  close: async (id, force = false) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    if (!force && tab.kind === 'chat' && agentBridge.isChatRunning(tab.id.slice('chat:'.length))) return
    if (tab.dirty && !force) {
      const ok = await useUi.getState().confirm({
        title: t('dialog.unsaved.title'),
        message: t('dialog.unsaved.message', { name: tabTitle(tab) }),
        confirmText: t('dialog.unsaved.confirm'),
        danger: true,
      })
      if (!ok) return
    }
    if (tab.kind === 'chat') agentBridge.onTabClosed(tab.id.slice('chat:'.length))
    cancelAutoSave(id)
    dropEditorState(id)
    forgetScrollForTab(id)
    useBlame.getState().invalidate(id)
    const tabs = get().tabs.filter((t) => t.id !== id)
    // When split, an emptied pane is collapsed right away
    const layout = settleLayout(
      settleGroups(get().groups, new Set([id])),
      get().activeGroupId,
      get().splitOrientation,
    )
    const cursors = { ...get().cursors }
    delete cursors[id]
    const groupId =
      groupOfTab(get().groups, get().activeGroupId, id)?.id ?? get().activeGroupId
    set({
      tabs,
      groups: layout.groups,
      activeGroupId: layout.activeGroupId,
      splitOrientation: layout.split,
      activeId: deriveActiveId(layout.groups, layout.activeGroupId),
      cursors,
      // Remember it for ⌘⇧T one-by-one restore (including caret position)
      closedTabs: pushClosed(get().closedTabs, tab, groupId, get().cursors[id]),
    })
    // The buffer is gone (closed, or saved to disk by saveAs): its hot-exit draft must not come back
    if (tab.kind === 'untitled') flushUntitledDrafts(collectUntitledDrafts())
  },

  closeIn: async (id, groupId) => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.kind === 'chat' && agentBridge.isChatRunning(tab.id.slice('chat:'.length))) return
    const owners = groupsWith(state.groups, id)
    // Still open in the other pane: remove only from this one, unsaved content and the other pane untouched
    if (owners.length > 1 && owners.includes(groupId)) {
      const groups = state.groups.map((g) => {
        if (g.id !== groupId) return g
        const order = g.order.filter((x) => x !== id)
        return withoutMarkdownPreview(
          { ...g, order, activeId: order[order.length - 1] ?? null },
          id,
        )
      })
      // Only one pane shows it now, so the mirror state is unneeded (the other pane uses the primary state)
      if (groups.filter((g) => g.order.includes(id)).length <= 1) {
        dropEditorState(mirrorKey(id))
      }
      const layout = settleLayout(groups, state.activeGroupId, state.splitOrientation)
      set({
        groups: layout.groups,
        activeGroupId: layout.activeGroupId,
        splitOrientation: layout.split,
        activeId: deriveActiveId(layout.groups, layout.activeGroupId),
      })
      return
    }
    await get().close(id)
  },

  closeActive: async () => {
    const state = get()
    const group = state.groups.find((g) => g.id === state.activeGroupId)
    const id = group?.activeId ?? null
    if (id) await get().closeIn(id, state.activeGroupId)
  },

  closeAll: async (options) => {
    const state = get()
    const ids = groupTabs(state.tabs, state.groups.find((g) => g.id === state.activeGroupId)).map(
      (t) => t.id,
    )
    if (ids.length === 0) return
    await closeMany(ids, options?.force, state.activeGroupId)
  },

  closeTabs: async (ids, options) => {
    await closeMany(ids, options?.force)
  },

  closeEverything: async (options) => {
    const ids = get().tabs.map((t) => t.id)
    // Close without a groupId: remove from every pane, so a split is cleaned too
    if (ids.length > 0) await closeMany(ids, options?.force)
    // Tabs in the reopen stack belong to the previous project: ⌘⇧T must not bring them back
    set({ closedTabs: [] })
  },

  closeOthers: async (id, options) => {
    const state = get()
    const group = groupOfTab(state.groups, state.activeGroupId, id)
    if (!group) return
    const ids = groupTabs(state.tabs, group)
      .filter((t) => t.id !== id && !t.pinned)
      .map((t) => t.id)
    if (ids.length === 0) return
    const closed = await closeMany(ids, options?.force, group.id)
    // After closing the others, bring the clicked one to front (cancel leaves the active tab alone)
    if (closed) get().activate(id, group.id)
  },

  closeRight: async (id, options) => {
    const state = get()
    const group = groupOfTab(state.groups, state.activeGroupId, id)
    if (!group) return
    const list = groupTabs(state.tabs, group)
    const index = list.findIndex((t) => t.id === id)
    if (index < 0) return
    const ids = list
      .slice(index + 1)
      .filter((t) => !t.pinned)
      .map((t) => t.id)
    if (ids.length === 0) return
    await closeMany(ids, options?.force, group.id)
  },

  closeLeft: async (id, options) => {
    const state = get()
    const group = groupOfTab(state.groups, state.activeGroupId, id)
    if (!group) return
    const list = groupTabs(state.tabs, group)
    const index = list.findIndex((t) => t.id === id)
    if (index <= 0) return
    const ids = list
      .slice(0, index)
      .filter((t) => !t.pinned)
      .map((t) => t.id)
    if (ids.length === 0) return
    await closeMany(ids, options?.force, group.id)
  },

  closeUnmodified: async (options) => {
    const state = get()
    const group = state.groups.find((g) => g.id === state.activeGroupId)
    const ids = groupTabs(state.tabs, group)
      .filter((t) => !t.dirty && !t.pinned)
      .map((t) => t.id)
    if (ids.length === 0) return
    await closeMany(ids, options?.force, state.activeGroupId)
  },

  reopenClosed: async () => {
    const closed = get().closedTabs
    const last = closed[closed.length - 1]
    if (!last) return
    set({ closedTabs: closed.slice(0, -1) })
    const { tab } = last
    if (tab.external) {
      try {
        // Re-grant after a restart / window recreation; a moved or deleted file stays closed.
        const info = await api.grantFile(tab.root)
        await get().openExternalFile(info.path, { groupId: last.groupId })
        const reopened = get().tabs.find((t) => t.id === fileTabId(info.path, ''))
        if (reopened && last.cursor) {
          set({
            reveal: {
              tabId: reopened.id,
              line: last.cursor.line,
              col: last.cursor.col,
              nonce: Date.now(),
              caret: true,
            },
          })
        }
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
      }
      return
    }
    try {
      await api.statFile(tab.root, tab.rel)
    } catch {
      useUi.getState().toast(t('toast.fileGone', { name: tab.rel }), 'error')
      return
    }
    await get().openFile(tab.root, tab.rel, { groupId: last.groupId, temporary: false })
    const reopened = get().tabs.find((t) => t.root === tab.root && t.rel === tab.rel)
    if (reopened && last.cursor) {
      // Restore the caret from before close (EditorHost clamps it if the file got shorter)
      set({
        reveal: {
          tabId: reopened.id,
          line: last.cursor.line,
          col: last.cursor.col,
          nonce: Date.now(),
          caret: true,
        },
      })
    }
  },

  promoteTab: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab?.temporary) return
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, temporary: false } : t)),
    })
  },

  jumpToLine: (line, col = 1) => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === state.activeId)
    if (!tab || tab.kind !== 'file') return
    const editor = getEditorState(tab.id)
    const target = Math.max(1, editor ? Math.min(line, editor.doc.lines) : line)
    set({
      reveal: {
        tabId: tab.id,
        line: target,
        col: Math.max(1, col),
        nonce: Date.now(),
        caret: true,
      },
    })
  },

  restoreOpenTabs: async (root, saved, activeRel) => {
    // Saved order, duplicates dropped, bounded by the restore budget (lightweight mode restores fewer)
    const limit = budget.restoredTabs()
    const seen = new Set<string>()
    const list: SavedTab[] = []
    for (const item of saved) {
      if (!item.rel || seen.has(item.rel) || list.length >= limit) continue
      seen.add(item.rel)
      list.push(item)
    }
    if (list.length === 0) return

    /**
     * Only the file paths come back — no content is read for any tab.
     *
     * The old path opened them one by one through `openFile`, and each open read the file, built an
     * EditorState, activated its tab and revealed it in the tree: the tabs appeared one after another, the
     * explorer expanded once per file, and a restart with a dozen tabs read a dozen files nobody looked at.
     *
     * Now a restored tab is just an entry: a `stat` decides whether it still exists and how big it is, and the
     * content is read the moment the tab is actually activated (EditorHost → `ensureEditorState`). The active
     * file is prewarmed by the caller, so it is on screen at first paint.
     */
    const slots: (Tab | null)[] = new Array(list.length).fill(null)
    let cursor = 0
    const worker = async () => {
      while (cursor < list.length) {
        const index = cursor
        cursor += 1
        const item = list[index]
        const id = fileTabId(root, item.rel)
        try {
          // Silent restore: deleted / oversized files are skipped without a toast
          const stat = await api.statFile(root, item.rel)
          if (stat.size > RESTORE_MAX_BYTES) continue
          if (get().tabs.some((tab) => tab.id === id)) continue

          if (isImagePath(item.rel)) {
            slots[index] = {
              id,
              root,
              kind: 'image',
              rel: item.rel,
              name: basename(item.rel),
              dirty: false,
              readOnly: true,
              tier: 'preview',
              pinned: false,
              temporary: false,
              size: stat.size,
              mtime: stat.mtime,
            }
            continue
          }

          const tier = tierFor(stat.size)
          slots[index] = {
            id,
            root,
            kind: 'file',
            rel: item.rel,
            name: basename(item.rel),
            dirty: false,
            readOnly: tier === 'preview',
            tier,
            pinned: false,
            temporary: false,
            size: stat.size,
            mtime: stat.mtime,
            // eol / indent are unknown until the file is read: buildFromDisk fills them in on first open, and
            // a tab that was never opened cannot be saved (no EditorState), so no write can use a wrong eol
          }
        } catch {
          /* One file failing does not affect the others */
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(RESTORE_CONCURRENCY, list.length) }, () => worker()),
    )

    const restored = slots.filter((tab): tab is Tab => tab !== null)
    if (restored.length === 0) return

    const targetRel =
      activeRel && restored.some((tab) => tab.rel === activeRel)
        ? activeRel
        : restored[restored.length - 1].rel
    const targetId = fileTabId(root, targetRel)

    // One commit: the whole set of tabs is in the group before React paints, so they never appear one by one
    set((state) => {
      const groupId = state.activeGroupId
      const groups = state.groups.map((group) => {
        if (group.id !== groupId) return group
        const order = [...group.order]
        for (const tab of restored) if (!order.includes(tab.id)) order.push(tab.id)
        return { ...group, order, activeId: targetId }
      })
      const cursors = { ...state.cursors }
      // Keep the saved caret, not 1:1: a lazily restored tab that is never opened must still be written back to
      // the session at its old position, and the editor seeds its selection from this when it is opened
      for (const tab of restored) {
        const saved = list.find((item) => item.rel === tab.rel)
        cursors[tab.id] = { line: saved?.line ?? 1, col: saved?.col ?? 1 }
      }
      return { tabs: [...state.tabs, ...restored], groups, activeId: targetId, cursors }
    })

    // One reveal for the file being restored, not one per tab: that repeated scroll / expand is what made the
    // explorer look like it was animating
    useWorkspace.getState().setActiveRoot(root)
    const target = restored.find((tab) => tab.id === targetId)
    if (target) revealInTree(target)
    if (target?.kind === 'file') useBlame.getState().scheduleFetch(target)

    const savedTarget = list.find((item) => item.rel === targetRel)
    if (savedTarget && (savedTarget.line > 1 || savedTarget.col > 1)) {
      set({
        reveal: {
          tabId: targetId,
          line: savedTarget.line,
          col: savedTarget.col,
          nonce: Date.now(),
          caret: true,
        },
      })
    }
  },

  pinTab: (id, pinned) => {
    const state = get()
    const tab = state.tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.pinned === pinned) {
      if (pinned && tab.temporary) get().promoteTab(id)
      return
    }
    const tabs = state.tabs.map((t) =>
      t.id === id ? { ...t, pinned, temporary: false } : t,
    )
    const byId = new Map(tabs.map((t) => [t.id, t]))
    // Pinned tabs come first in the group, keeping their relative order
    const groups = state.groups.map((g) => {
      if (!g.order.includes(id)) return g
      const order = [...g.order]
      order.sort((a, b) => Number(byId.get(b)?.pinned) - Number(byId.get(a)?.pinned))
      return { ...g, order }
    })
    set({ tabs, groups })
  },

  togglePreview: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    // Only an SVG still opened as text has a preview to toggle
    if (!tab || tab.kind !== 'file' || !isSvgPath(tab.rel)) return
    set({
      tabs: get().tabs.map((t) => (t.id === id ? { ...t, preview: !t.preview } : t)),
    })
  },

  syncDiffTabs: async (root, status, paths) => {
    // No status yet / git errored: leave tabs alone
    if (!status || status.error) return

    // Suspect only files the status does not mention at all; the rest are assumed alive
    const listed = (rel: string) =>
      [...status.staged, ...status.changes, ...status.untracked, ...status.conflicts].some(
        (file) => file.path === rel,
      )
    const suspects = get().tabs.filter(
      (tab) =>
        tab.root === root && tab.kind === 'diff' &&
        (!paths || paths.includes(tab.rel)) && !listed(tab.rel),
    )
    if (suspects.length === 0) return

    // Content change / commit / unstage only make the diff empty and must not close a tab the user is
    // reading; close only when the file really vanished from disk (deleted / renamed)
    for (const tab of suspects) {
      try {
        await api.statFile(tab.root, tab.rel)
      } catch {
        void get().close(tab.id)
      }
    }
  },

  refreshFromDisk: async (root, options) => {
    const { force = false, paths } =
      typeof options === 'boolean' ? { force: options, paths: undefined } : (options ?? {})
    const matchesPath = (tab: Tab) =>
      (force || !suspendedSaves.has(fileSaveKey(tab.root, tab.rel))) &&
      (!paths || paths.some(
        (path) =>
          path === tab.rel ||
          (!force && (tab.rel.startsWith(`${path}/`) || path.startsWith(`${tab.rel}/`))),
      ))
    if (force) {
      for (const tab of get().tabs) {
        if (tab.root === root && matchesPath(tab)) cancelAutoSave(tab.id)
      }
    }

    // Diff tabs survive external changes: bump diffEpoch so DiffView refetches the patch. Only touched files
    // match, else one auto-save would recompute every open diff.
    const hitsDiff = (tab: Tab) => {
      if (tab.kind !== 'diff' || tab.root !== root) return false
      // No paths = full refresh (branch switch / stage / commit); with paths only those match
      return matchesPath(tab)
    }
    const affectedTabs = get().tabs.filter((tab) => tab.root === root && matchesPath(tab))
    if (paths ? affectedTabs.length > 0 : get().tabs.some(hitsDiff)) {
      const diffEpoch = { ...get().diffEpoch }
      if (paths) {
        for (const tab of affectedTabs) diffEpoch[tab.id] = (diffEpoch[tab.id] ?? 0) + 1
      } else {
        diffEpoch[root] = (diffEpoch[root] ?? 0) + 1
      }
      set({ diffEpoch })
    }

    // Close only diff tabs whose file is gone; content changes go through diffEpoch above.
    // The watcher's git refresh (350ms) lands before this (400ms), so the status is basically current.
    await get().syncDiffTabs(
      root,
      useGit.getState().statuses[root],
      affectedTabs.map((tab) => tab.rel),
    )

    // No reloadable text for image previews: sync mtime into the tab so ImageView rereads
    for (const tab of get().tabs.filter((t) => t.root === root && t.kind === 'image' && matchesPath(t))) {
      try {
        const stat = await api.statFile(tab.root, tab.rel)
        const current = get().tabs.find((t) => t.id === tab.id)
        if (!current || current.mtime === stat.mtime) continue
        set({
          tabs: get().tabs.map((t) =>
            t.id === tab.id ? { ...t, mtime: stat.mtime, size: stat.size } : t,
          ),
        })
      } catch {
        /* Deleted files are handled by onDeleted */
      }
    }

    const targets = get().tabs.filter(
      (t) =>
        t.root === root && t.kind === 'file' && matchesPath(t) &&
        (force || !t.dirty) && (!t.readOnly || (force && paths !== undefined)),
    )

    // Compare mtime / size with a cheap stat first: unchanged means no work (git add / own save keeps undo
    // history). Only the current file rereads and rebuilds now; background files drop their cache and reread
    // on activation, so a checkout does not pull every big file into memory.
    const CONCURRENCY = 6
    let cursor = 0
    const worker = async () => {
      while (cursor < targets.length) {
        const tab = targets[cursor]
        cursor += 1
        try {
          const stat = await api.statFile(tab.root, tab.rel)
          const current = get().tabs.find((t) => t.id === tab.id)
          // Skip if closed, modified or reopened meanwhile, so nothing the user is writing gets overwritten
          if (!current || (current.readOnly && !(force && paths !== undefined))) continue
          if (!force && current.dirty) continue
          if (!force && current.mtime === stat.mtime && current.size === stat.size) continue
          if (force) cancelAutoSave(current.id)

          const tier = tierFor(stat.size)
          const meta = {
            mtime: stat.mtime,
            size: stat.size,
            tier,
            readOnly: tier === 'preview',
            // Force refresh means the old editor content is already void
            ...(force ? { dirty: false } : {}),
          }
          useBlame.getState().invalidate(current.id)

          if (!get().groups.some((g) => g.activeId === current.id)) {
            dropEditorState(current.id)
            set({
              tabs: get().tabs.map((t) => (t.id === current.id ? { ...t, ...meta } : t)),
            })
            continue
          }

          const payload = await api.readFile(current.root, current.rel)
          if (payload.binary) {
            if (force && paths) await closeMany([current.id], true)
            continue
          }
          const settings = useSettings.getState()
          // Disk content changed: line ending / indent may have changed too, detect again
          const textMeta = detectTextMeta(payload.content)
          dropEditorState(current.id)
          const state = await createFileState({
            id: current.id,
            root: current.root,
            rel: current.rel,
            content: payload.content,
            tier,
            readOnly: tier === 'preview',
            conflicted: await isConflictedFile(current.root, current.rel, payload.content),
            tabSize: textMeta.indentSize ?? settings.tabSize,
            useTabs: textMeta.useTabs,
            wordWrap: current.wordWrap ?? settings.wordWrap,
            inlineBlame: settings.inlineBlame,
          })
          // The file being viewed swaps to the new content at once
          applyActiveState(current.id, state)
          set({
            tabs: get().tabs.map((t) =>
              t.id === current.id
                ? {
                    ...t,
                    ...meta,
                    eol: textMeta.eol,
                    indentSize: textMeta.indentSize,
                    useTabs: textMeta.useTabs,
                  }
                : t,
            ),
            stateEpoch: get().stateEpoch + 1,
          })
          const updated = get().tabs.find((t) => t.id === current.id)
          if (updated) useBlame.getState().scheduleFetch(updated)
        } catch (error) {
          if (force && paths) {
            // Discard already succeeded on disk: an unreadable replacement must never leave
            // the obsolete editor buffer available to a later manual save or autosave.
            await closeMany([tab.id], true)
            useUi.getState().toast(errorText(error), 'error')
          }
          /* One file failing does not affect the others */
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, targets.length) }, () => worker()),
    )

    // Deliberately no reveal here: applyActiveState already keeps the caret when swapping state, and
    // dispatching from an early snapshot would overwrite what the user typed meanwhile (a caret jump)
  },

  markDirty: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    if (!tab.dirty) {
      set({
        tabs: get().tabs.map((t) =>
          t.id === id ? { ...t, dirty: true, temporary: false } : t,
        ),
      })
    } else if (tab.temporary) {
      get().promoteTab(id)
    }
    // Untitled buffers are not auto-saved (no path): mirror them into localStorage instead, so quitting,
    // crashing or a cache eviction does not lose the text
    if (tab.kind === 'untitled') saveUntitledDrafts(collectUntitledDrafts())
    scheduleAutoSave(id)
  },

  markClean: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab || !tab.dirty) return
    // Nothing differs from disk any more, so a queued auto-save would only rewrite the same bytes (and bump the
    // mtime, which every other window / the watch cache would have to process)
    cancelAutoSave(id)
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, dirty: false } : t)) })
  },

  markCursor: (id, line, col) => {
    const current = get().cursors[id]
    if (current && current.line === line && current.col === col) return
    set({ cursors: { ...get().cursors, [id]: { line, col } } })
  },

  save: async (id, opts) => {
    const tab = get().tabs.find((t) => t.id === id)
    // An untitled buffer has no path yet: ⌘S means "save as"
    if (tab?.kind === 'untitled') return get().saveAs(id)
    if (!tab || tab.kind !== 'file' || tab.readOnly) return false
    const saveKey = fileSaveKey(tab.root, tab.rel)
    const saveVersion = saveVersions.get(saveKey) ?? 0
    const saveCancelled = () =>
      suspendedSaves.has(saveKey) || (saveVersions.get(saveKey) ?? 0) !== saveVersion
    if (saveCancelled()) return false
    const state = getEditorState(id)
    if (!state) return false
    const settings = useSettings.getState()

    // Format on save: only for files with a formatter, not too big, not read-only. The backend picks a tool by
    // extension and pipes text through stdin → stdout; a failure just means unformatted. Manual-only mode
    // never rewrites files here.
    if (settings.formatMode === 'onSave' && !tab.readOnly && state.doc.length <= FORMAT_MAX_CHARS) {
      try {
        const result = await formatWithSelectedTool(tab.root, tabFileRel(tab), state.doc.toString())
        if (saveCancelled()) return false
        if (result.error && !opts?.quiet) useUi.getState().toast(result.error, 'error')
        // If typing continued while the formatter ran, save the live text unformatted rather
        // than replacing it with a result computed from an older document.
        const live = getEditorState(id)
        if (result.changed && result.text !== null && live?.doc === state.doc) {
          replaceDocText(id, result.text)
        }
      } catch {
        /* Formatting is a bonus: any error must not block the save */
      }
    }

    // Tidy before save (optional in settings): edits the buffer itself,
    // else the trimmed whitespace stays in the editor and the next save writes it back
    if (saveCancelled()) return false
    replaceDocText(
      id,
      tidyText((getEditorState(id) ?? state).doc.toString(), {
        trim: settings.trimTrailingWhitespace,
        finalNewline: settings.insertFinalNewline,
      }),
    )
    // Documents are \n internally: CRLF files must be converted back before writing, else the whole file is rewritten
    const text = (getEditorState(id) ?? state).doc.toString()
    const content = tab.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text
    try {
      const write = api.writeFile(tab.root, tab.rel, content)
      const writes = pendingWrites.get(saveKey) ?? new Set<Promise<unknown>>()
      writes.add(write)
      pendingWrites.set(saveKey, writes)
      const saved = await write.finally(() => {
        writes.delete(write)
        if (writes.size === 0) pendingWrites.delete(saveKey)
      })
      // Typing may continue during the write: clean only if the document still equals what was written,
      // otherwise keep dirty so the next auto-save saves the new text (else that input is silently lost)
      const live = getEditorState(id)
      const unchanged = !live || live.doc.toString() === text
      // What is on disk now is the baseline: undoing back to it clears the modification
      if (unchanged && live) markCleanDoc(id, live.doc)
      set({
        tabs: get().tabs.map((t) =>
          t.id === id
            ? {
                ...t,
                dirty: unchanged ? false : true,
                mtime: unchanged ? saved.mtime : t.mtime,
                size: saved.size,
              }
            : t,
        ),
      })
      signals.onSaved(tab.root, tab.rel)
      // Auto-save skips blame: the content is not committed yet and results barely change,
      // but each run costs a new cache entry + a git subprocess
      if (!opts?.quiet && !tab.external) {
        useBlame.getState().invalidate(id)
        const updated = get().tabs.find((t) => t.id === id)
        if (updated) useBlame.getState().scheduleFetch(updated)
      }
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    }
  },

  formatActive: async (tabId) => {
    // Already formatting / just formatted (second half of a double click): ignore
    if (get().formatting || Date.now() - lastManualFormat < 400) return false
    const snapshot = get()
    const targetId = tabId ?? snapshot.activeId
    const tab = snapshot.tabs.find((t) => t.id === targetId)
    if (!tab || tab.kind !== 'file' || tab.readOnly) return false
    const state = getEditorState(tab.id)
    if (!state) return false
    const sourceDoc = state.doc
    const rel = tabFileRel(tab)

    const ui = useUi.getState()
    set({ formatting: true })
    try {
      const result = await formatWithSelectedTool(tab.root, rel, sourceDoc.toString())
      if (result.source === 'none') {
        ui.toast(t('toast.formatDisabled'), 'info')
        return false
      }
      const ext = rel.slice(rel.lastIndexOf('.') + 1)
      if (result.source === 'unsupported') {
        ui.toast(t('toast.formatNoTool', { ext }), 'info')
        return false
      }
      if (result.error) {
        ui.toast(result.error, 'error')
        return false
      }
      if (result.text === null) return false
      // Formatting may take a moment. Never overwrite text typed while waiting for the tool.
      const live = getEditorState(tab.id)
      if (!live || live.doc !== sourceDoc) {
        ui.toast(t('toast.formatChanged'), 'info')
        return false
      }
      if (!result.changed) {
        ui.toast(t('toast.formatUnchanged'), 'info')
        return false
      }
      replaceDocText(tab.id, result.text)
      lastManualFormat = Date.now()
      // Formatting edits the buffer: mark dirty and let auto-save / ⌘S write it
      get().markDirty(tab.id)
      const tool = resolveTool(rel, useSettings.getState().formatTool)
      ui.toast(
        t('toast.formatted', {
          tool: tool?.label ?? t('settings.editor.formatTool'),
          source: sourceLabel(result.source),
        }),
        'success',
      )
      return true
    } catch (e) {
      ui.toast(errorText(e), 'error')
      return false
    } finally {
      set({ formatting: false })
    }
  },

  saveAll: async () => {
    for (const tab of get().tabs) {
      if (tab.dirty) await get().save(tab.id)
    }
  },

  saveActive: async () => {
    const id = get().activeId
    if (id) await get().save(id)
  },

  reset: () => {
    for (const id of [...autoSaveTimers.keys()]) cancelAutoSave(id)
    for (const tab of get().tabs) forgetScrollForTab(tab.id)
    clearEditorStates()
    useBlame.getState().clear()
    // Pending reads belong to the old workspace: invalidate their pane sequences, but keep the per-tab request
    // tracking so the final stale request can release any EditorState it builds after clearEditorStates().
    openRequestEpoch += 1
    openRequestSequence.clear()
    pendingOpenRequests.clear()
    set({
      tabs: [],
      activeId: null,
      groups: [{ id: 'primary', activeId: null, order: [] }],
      activeGroupId: 'primary',
      splitOrientation: null,
      cursors: {},
      reveal: null,
      opening: false,
      stateEpoch: 0,
      diffEpoch: {},
      closedTabs: [],
    })
    // No untitled buffer is left open: drop the drafts so they are not "restored" on the next start
    flushUntitledDrafts([])
  },

  onRenamed: (root, from, to) => {
    const state = get()
    const tabs = state.tabs
    const cursors: Record<string, CursorInfo> = {}
    const idMap = new Map<string, string>()
    const next = tabs.map((tab) => {
      const affected = tab.root === root && (tab.rel === from || tab.rel.startsWith(from + '/'))
      if (!affected) {
        const c = get().cursors[tab.id]
        if (c) cursors[tab.id] = c
        return tab
      }
      const newRel = tab.rel === from ? to : to + tab.rel.slice(from.length)
      const newId =
        tab.kind === 'diff' ? diffTabId(root, newRel, Boolean(tab.staged)) : fileTabId(root, newRel)
      rekeyEditorState(tab.id, newId)
      setEditorRel(newId, newRel)
      rekeyScroll(tab.id, newId)
      idMap.set(tab.id, newId)
      const cursor = get().cursors[tab.id]
      if (cursor) cursors[newId] = cursor
      return { ...tab, id: newId, rel: newRel, name: basename(newRel) }
    })

    const nextById = new Map(next.map((tab) => [tab.id, tab]))
    const groups = state.groups.map((g) => {
      let markdownPreview = g.markdownPreview
      if (markdownPreview) {
        const migrated: Record<string, number> = {}
        for (const [id, ratio] of Object.entries(markdownPreview)) {
          const nextId = idMap.get(id) ?? id
          const tab = nextById.get(nextId)
          if (tab?.kind === 'file' && isMarkdownPath(tab.rel)) migrated[nextId] = ratio
        }
        markdownPreview = Object.keys(migrated).length > 0 ? migrated : undefined
      }
      return {
        ...g,
        order: g.order.map((id) => idMap.get(id) ?? id),
        activeId: g.activeId ? (idMap.get(g.activeId) ?? g.activeId) : null,
        markdownPreview,
      }
    })
    set({
      tabs: next,
      groups,
      activeId: deriveActiveId(groups, state.activeGroupId),
      cursors,
    })
  },

  onDeleted: (root, rel) => {
    for (const tab of get().tabs) {
      if (tab.root === root && (tab.rel === rel || tab.rel.startsWith(rel + '/'))) {
        cancelAutoSave(tab.id)
        dropEditorState(tab.id)
        useBlame.getState().invalidate(tab.id)
      }
    }
    set((state) => {
      const removed = new Set(
        state.tabs
          .filter((t) => t.root === root && (t.rel === rel || t.rel.startsWith(rel + '/')))
          .map((t) => t.id),
      )
      const tabs = state.tabs.filter((t) => !removed.has(t.id))
      const layout = settleLayout(
        settleGroups(state.groups, removed),
        state.activeGroupId,
        state.splitOrientation,
      )
      return {
        tabs,
        groups: layout.groups,
        activeGroupId: layout.activeGroupId,
        splitOrientation: layout.split,
        activeId: deriveActiveId(layout.groups, layout.activeGroupId),
      }
    })
  },
}))

/**
 * Opening a file closes that file's diff tabs: the side-by-side diff is a preview, and keeping it next to the
 * file it points at only duplicates the tab bar. Both the worktree and the staged diff go.
 */
async function closeDiffsFor(root: string, rel: string) {
  const ids = useTabs
    .getState()
    .tabs.filter((t) => t.kind === 'diff' && t.root === root && t.rel === rel)
    .map((t) => t.id)
  if (ids.length > 0) await useTabs.getState().closeTabs(ids)
}

/**
 * Close a batch: one confirm for unsaved tabs, clear editor state / scroll memory / blame cache per tab,
 * then fix the active tab. With groupId, remove from that pane only (a file still open in the other pane keeps
 * its state). Returns whether anything really closed.
 */
async function closeMany(ids: string[], force?: boolean, groupId?: TabGroupId): Promise<boolean> {
  const removed = new Set(ids)
  const snapshotBefore = useTabs.getState()
  const targets = snapshotBefore.tabs.filter((t) => removed.has(t.id))
  if (targets.length === 0) return false
  if (!force && targets.some((tab) => tab.kind === 'chat' && agentBridge.isChatRunning(tab.id.slice('chat:'.length)))) return false

  // Closed from one pane while still open in the other is not a real close: no confirm, no state loss
  const owners = (id: string) => groupsWith(snapshotBefore.groups, id)
  const fullyClosing = targets.filter(
    (t) => !groupId || !owners(t.id).includes(groupId) || owners(t.id).length <= 1,
  )

  const dirty = fullyClosing.filter((t) => t.dirty)
  if (dirty.length > 0 && !force) {
    const ok = await useUi.getState().confirm({
      title: t('dialog.unsaved.title'),
      message:
        dirty.length === 1
          ? t('dialog.unsaved.message', { name: tabTitle(dirty[0]) })
          : tp('dialog.unsaved.messageMany', dirty.length),
      confirmText: t('dialog.unsaved.confirm'),
      danger: true,
    })
    if (!ok) return false
  }

  for (const tab of fullyClosing) {
    if (tab.kind === 'chat') agentBridge.onTabClosed(tab.id.slice('chat:'.length))
    cancelAutoSave(tab.id)
    dropEditorState(tab.id)
    forgetScrollForTab(tab.id)
    useBlame.getState().invalidate(tab.id)
  }

  // New tabs may have opened while the dialog was up: re-snapshot so their ids are not dropped
  const snapshot = useTabs.getState()
  const dropTabs = groupId
    ? new Set<string>(fullyClosing.map((t) => t.id))
    : removed
  const tabs = snapshot.tabs.filter((t) => !dropTabs.has(t.id))
  const groups = groupId
    ? snapshot.groups.map((g) => {
        if (g.id !== groupId) return g
        const order = g.order.filter((id) => !removed.has(id))
        const activeId = order.includes(g.activeId ?? '') ? g.activeId : (order[order.length - 1] ?? null)
        let next = { ...g, order, activeId }
        for (const id of removed) next = withoutMarkdownPreview(next, id)
        return next
      })
    : settleGroups(snapshot.groups, removed)
  const cursors = { ...snapshot.cursors }
  const diffEpoch = { ...snapshot.diffEpoch }
  for (const id of dropTabs) {
    delete cursors[id]
    delete diffEpoch[id]
  }
  const layout = settleLayout(groups, snapshot.activeGroupId, snapshot.splitOrientation)
  useTabs.setState({
    tabs,
    groups: layout.groups,
    activeGroupId: layout.activeGroupId,
    splitOrientation: layout.split,
    activeId: deriveActiveId(layout.groups, layout.activeGroupId),
    cursors,
    diffEpoch,
    // Bulked-closed tabs join the reopen stack too (only real closes, not the ones still open in another pane)
    closedTabs: fullyClosing.reduce(
      (list, tab) => pushClosed(list, tab, groupId ?? 'primary', snapshotBefore.cursors[tab.id]),
      snapshotBefore.closedTabs,
    ),
  })
  // Closed untitled buffers take their hot-exit draft with them
  if (fullyClosing.some((tab) => tab.kind === 'untitled')) {
    flushUntitledDrafts(collectUntitledDrafts())
  }
  return true
}

function scheduleAutoSave(id: string) {
  const settings = useSettings.getState()
  if (!settings.autoSave) return
  const tab = useTabs.getState().tabs.find((t) => t.id === id)
  if (!tab || tab.kind !== 'file' || tab.readOnly || suspendedSaves.has(fileSaveKey(tab.root, tab.rel))) return

  cancelAutoSave(id)
  const delay = tab.tier === 'large' ? 1500 : 800
  autoSaveTimers.set(
    id,
    setTimeout(() => {
      autoSaveTimers.delete(id)
      // Auto-save may just have been turned off while the timer was queued: check again on fire
      if (!useSettings.getState().autoSave) return
      const current = useTabs.getState().tabs.find((t) => t.id === id)
      if (current?.dirty) void useTabs.getState().save(id, { quiet: true })
    }, delay),
  )
}

// Editor callbacks wired into the store (one-way dependency, avoids an import cycle)
signals.onDirty = (id) => useTabs.getState().markDirty(id)
signals.onClean = (id) => useTabs.getState().markClean(id)
signals.onCursor = (id, line, col) => useTabs.getState().markCursor(id, line, col)
signals.onDocChanged = (id, update) => forwardDocChange(id, update)
// A save in a non-repo project need not bother git: a status run per auto-save is a wasted subprocess
signals.onSaved = (root) => {
  const node = useWorkspace.getState().roots.find((r) => r.id === root)
  if (node && !node.isGitRepo) return
  useGit.getState().scheduleRefresh(root)
}
signals.onOpenImport = (root, rel) => void useTabs.getState().openFile(root, rel)
signals.isPinned = (id) => {
  const state = useTabs.getState()
  // Mirror-state keys carry a @secondary suffix; pinning follows the tab it represents
  const tabId = tabIdOfStateKey(id)
  // Keep whatever each pane is showing (after a split, don't pin only the left side)
  if (state.groups.some((g) => g.activeId === tabId)) return true
  const tab = state.tabs.find((t) => t.id === tabId)
  return Boolean(tab?.dirty || tab?.pinned)
}
