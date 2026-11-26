import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import {
  editorStateKey,
  useTabs,
  type RevealRequest,
  type Tab,
  type TabGroupId,
} from '../store/tabs'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { errorText } from '../lib/ipc'
import { useBlame } from '../store/blame'
import { useCommitHover } from '../store/commitHover'
import {
  applyBlameToView,
  getEditorState,
  reconfigureTheme,
  setBlameEnabled,
} from '../editor/stateCache'
import { ensureEditorState } from '../editor/openState'
import { stickyRange } from '../editor/highlight'
import { setEditorView, setFocusedGroup } from '../editor/viewRef'
import { applyDiffMarks } from '../editor/diffGutter'
import { useFileDiffMarks, diffMarksFor } from '../store/diffMarks'
import type { DiffMark } from '../lib/diffMarks'
import { linkMirror, unlinkMirror, unlinkView } from '../editor/mirror'
import { signals } from '../editor/signals'
import {
  cancelScrollCorrection,
  rememberScroll,
  restoreScroll,
  takeScrollRatio,
} from '../editor/scrollMemory'
import { onLayoutDragging } from '../lib/layoutBus'
import { Icon } from './Icon'
import { ImageView } from './ImageView'
import { DiffView } from './DiffView'
import { Welcome } from './Welcome'
import { SettingsView } from './SettingsView'
import { AgentChat } from './AgentChat'
import { DiffRuler } from './DiffRuler'
import { MarkdownPreview } from './MarkdownPreview'
import { Splitter } from './Splitter'
import { useT } from '../i18n'
import { tabTitle } from '../lib/tabTitle'
import { isMarkdownPath } from '../lib/markdown'
import { captureEditorContext } from '../editor/agentContext'
import { editorSelections } from '../editor/selectionRegistry'
import { activeRoot } from '../store/workspace'

/**
 * Swap the state and its scroll position together: a new file starts at the top, switching back to a
 * tab restores the old spot. The write must go through requestMeasure's write, or CodeMirror's own
 * measure overwrites it. id is a composite "pane + tab" key.
 */
function swapState(
  view: EditorView,
  id: string,
  state: EditorState,
  prevId: string | null,
  fallback: number,
  keepCurrent = false,
  ratio?: number,
) {
  if (prevId && prevId !== id) rememberScroll(prevId, view.scrollDOM.scrollTop)
  view.setState(state)
  reconfigureTheme(view)
  restoreScroll(view, id, fallback, keepCurrent, ratio)
}

/** Stable empty array: applying it clears marks without dispatching on every render. */
const NO_DIFF_MARKS: DiffMark[] = []

/** These tabs show no editor: images / diffs mount other content, SVG preview gives the area to the image. */
function isEditorHidden(tab: Tab | null): boolean {
  if (!tab) return false
  // untitled buffers do have an editor, they just have no file on disk yet
  return (tab.kind !== 'file' && tab.kind !== 'untitled') || Boolean(tab.preview)
}

function applyReveal(view: EditorView, request: RevealRequest) {
  // This jump owns the position: the restore of the file just opened ("start on line 1") is still in flight
  // and would otherwise put the reader back at the top of the file a frame later
  cancelScrollCorrection()
  const doc = view.state.doc
  const lineNo = Math.min(Math.max(1, request.line), doc.lines)
  const line = doc.line(lineNo)
  const pos = Math.min(line.from + Math.max(0, request.col - 1), line.to)

  // A background refresh (reload triggered by autosave) must never move the user's cursor:
  // only restore the position when the state was just rebuilt and the cursor sits at the top
  if (request.focus === false) {
    if (view.state.selection.main.head === 0) view.dispatch({ selection: { anchor: pos } })
    return
  }

  // Caret only (restore / jump to line): do not select the whole line, or the next keystroke replaces it
  if (request.caret) {
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    })
    view.focus()
    return
  }

  // Search hit: select the matched text (whole line without a length) and center it in the viewport
  const end = request.length ? Math.min(line.to, pos + Math.max(1, request.length)) : line.to
  view.dispatch({
    selection: { anchor: pos, head: end },
    effects: EditorView.scrollIntoView(pos, { y: 'center' }),
  })
  // The highlight stays until the user clicks elsewhere / blurs, instead of fading after 1.4s
  stickyRange(view, pos, end)
  view.focus()
}

/** Apply the latest disk-based git marks after a state swap (the new state starts with an empty gutter). */
function applyTabDiffMarks(view: EditorView, tab: Tab) {
  if (tab.kind !== 'file' || tab.external) return
  applyDiffMarks(view, diffMarksFor(tab.root, tab.rel))
}

/**
 * One pane's CodeMirror view (there is only one in the whole app when unsplit). Switching tabs only
 * calls setState, never rebuilds the DOM; LRU evictions are rebuilt on demand (unmodified files re-read from disk).
 */
export function EditorHost({ groupId }: { groupId: TabGroupId }) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  /** id of the tab currently mounted in the view, used to save the previous file's scroll position */
  const shownIdRef = useRef<string | null>(null)

  const group = useTabs((s) => s.groups.find((g) => g.id === groupId))
  const activeId = group?.activeId ?? null
  const tabs = useTabs((s) => s.tabs)
  const setMarkdownPreviewRatio = useTabs((s) => s.setMarkdownPreviewRatio)
  const reveal = useTabs((s) => s.reveal)
  const stateEpoch = useTabs((s) => s.stateEpoch)
  const palette = useSettings((s) => s.palette)
  const fontSize = useSettings((s) => s.fontSize)
  const fontFamily = useSettings((s) => s.fontFamily)
  const inlineBlame = useSettings((s) => s.inlineBlame)
  const blameData = useBlame((s) => (activeId ? s.byTab[activeId] : null))
  const activeTab = tabs.find((t) => t.id === activeId) ?? null
  const hidden = isEditorHidden(activeTab)
  /** Plain files inside a Git repo get the right-edge ruler and the matching line-number gutter. */
  const isGitRepo = useWorkspace(
    (s) => s.roots.find((root) => root.id === activeTab?.root)?.isGitRepo ?? false,
  )
  const showRuler = Boolean(activeTab?.kind === 'file' && !activeTab.preview && isGitRepo)
  const diffEpoch = useTabs((s) =>
    activeTab ? (s.diffEpoch[activeTab.root] ?? 0) + (s.diffEpoch[activeTab.id] ?? 0) : 0,
  )
  const diffEntry = useFileDiffMarks(
    activeTab?.root ?? '',
    activeTab?.rel ?? '',
    showRuler && !activeTab?.external,
    activeTab?.dirty ?? false,
    activeTab?.mtime ?? 0,
    diffEpoch,
  )
  const groups = useTabs((s) => s.groups)
  const markdownPreviewRatio =
    activeTab?.kind === 'file' && isMarkdownPath(activeTab.rel)
      ? group?.markdownPreview?.[activeTab.id]
      : undefined
  const markdownPreviewOpen = markdownPreviewRatio !== undefined
  /** Mirror state for a split of the same file (the two panes cannot share one EditorState) */
  const stateKey = activeId ? editorStateKey(activeId, groupId, groups) : null
  /** Scroll positions are keyed by "pane + tab", so each pane scrolls on its own */
  const scrollKey = (id: string) => `${groupId}:${id}`
  /** Whether the same file is also open in the other pane (decides if mirror sync is attached) */
  const shared = Boolean(
    activeId &&
      groups.length > 1 &&
      groups.every((g) => g.order.includes(activeId)),
  )

  /**
   * SVG preview renders the editor's current text (incl. unsaved edits). null = no state available;
   * then error out rather than falling back to disk and showing stale content.
   */
  const svgText = useMemo(() => {
    if (!activeTab || activeTab.kind !== 'file' || !activeTab.preview) return undefined
    const state = getEditorState(editorStateKey(activeTab.id, groupId, useTabs.getState().groups))
    return state ? state.doc.toString() : null
    // The doc is read-only during preview; only an external reload (stateEpoch) can change it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab?.id, activeTab?.kind, activeTab?.preview, stateEpoch, groupId])

  const [restoring, setRestoring] = useState(false)
  /** Delay the "restoring" hint: it usually finishes instantly, so showing it at once just flashes; only
   * show it when it is really slow (large file / first language-pack load). */
  const [slowRestore, setSlowRestore] = useState(false)

  useEffect(() => {
    if (!restoring) {
      setSlowRestore(false)
      return
    }
    const timer = setTimeout(() => setSlowRestore(true), 240)
    return () => clearTimeout(timer)
  }, [restoring])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const view = new EditorView({ parent: host })
    viewRef.current = view
    setEditorView(groupId, view)
    const unregisterContext = editorSelections.register(groupId, () => {
      const state = useTabs.getState()
      const id = state.groups.find(group => group.id === groupId)?.activeId
      const tab = state.tabs.find(tab => tab.id === id)
      if (!tab || shownIdRef.current !== tab.id || isEditorHidden(tab)) return null
      const root = tab.root || activeRoot()?.id || ''
      return { root, attachments: captureEditorContext(view.state, tab, root) }
    }, () => {
      const state = useTabs.getState()
      const id = state.groups.find(group => group.id === groupId)?.activeId
      const tab = state.tabs.find(tab => tab.id === id)
      return Boolean(tab && shownIdRef.current === tab.id && !isEditorHidden(tab) &&
        view.state.selection.ranges.some(range => !range.empty))
    })
    const unsubscribeContext = useTabs.subscribe(() => editorSelections.notify(groupId))
    if (useTabs.getState().activeGroupId === groupId) setFocusedGroup(groupId)

    // Keep the recorded position fresh while the reader scrolls. Every path back to a tab (switching,
    // coming back from a diff / image tab, a re-measure after being hidden) can then return to the real
    // offset instead of relying on one snapshot taken at the moment of leaving.
    let frame = 0
    const onScroll = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const id = shownIdRef.current
        if (id) rememberScroll(`${groupId}:${id}`, view.scrollDOM.scrollTop)
      })
    }
    view.scrollDOM.addEventListener('scroll', onScroll, { passive: true })

    return () => {
      unsubscribeContext()
      unregisterContext()
      view.scrollDOM.removeEventListener('scroll', onScroll)
      if (frame) cancelAnimationFrame(frame)
      unlinkView(view)
      setEditorView(groupId, null)
      view.destroy()
      viewRef.current = null
    }
  }, [groupId])

  useEffect(() => {
    const view = viewRef.current
    // The previous file's commit card must not stay on screen after switching / closing all tabs
    useCommitHover.getState().hide()

    if (!view) return
    const forgetShown = () => {
      if (shownIdRef.current) unlinkMirror(shownIdRef.current, groupId)
      shownIdRef.current = null
      editorSelections.notify(groupId)
    }

    if (!activeId) {
      // After all tabs close the view still holds the previous document; forget it so
      // reopening the same file starts at the top
      forgetShown()
      setRestoring(false)
      return
    }
    const tab = tabs.find((t) => t.id === activeId)
    if (!tab) {
      forgetShown()
      return
    }

    const shown = shownIdRef.current

    // SVG preview: the document did not change, so keep shownIdRef and reuse the scroll position
    // when switching back to source
    if (tab.kind === 'file' && tab.preview) {
      rememberScroll(scrollKey(activeId), view.scrollDOM.scrollTop)
      forgetShown()
      setRestoring(false)
      view.contentDOM.blur()
      return
    }

    // Image preview / diff / welcome / settings / chat mount no EditorState: remember the last text file's
    // position first, then hide the editor, or focus stays in CodeMirror and typing edits an invisible file.
    // Untitled buffers do have an EditorState; treating them as virtual tabs would leave the previous file mounted.
    if (tab.kind !== 'file' && tab.kind !== 'untitled') {
      if (shown && shown !== activeId && tabs.some((t) => t.id === shown)) {
        rememberScroll(scrollKey(shown), view.scrollDOM.scrollTop)
      }
      forgetShown()
      setRestoring(false)
      view.contentDOM.blur()
      return
    }

    let cancelled = false
    const key = stateKey ?? activeId
    const cached = getEditorState(key)

    // Remember the previous file's scroll amount before switching; skip closed tabs (cleared in close)
    const switching = shown !== null && shown !== activeId
    const prevAlive = switching && tabs.some((t) => t.id === shown)
    // Only a background reload of the same tab keeps the current scroll position; everything else
    // starts at the top (newly opened files, returning from image preview to an unseen file)
    const keepCurrent = shown === activeId
    const fallback = keepCurrent ? view.scrollDOM.scrollTop : 0
    // After the switch this view no longer shows the old tab
    if (shown && shown !== activeId) unlinkMirror(shown, groupId)

    if (cached) {
      const changed = view.state !== cached
      if (changed) {
        swapState(
          view,
          scrollKey(activeId),
          cached,
          prevAlive && shown ? scrollKey(shown) : null,
          fallback,
          keepCurrent,
          // Handed over by the empty diff that just became this file tab
          takeScrollRatio(activeId),
        )
      }
      applyTabDiffMarks(view, tab)
      shownIdRef.current = activeId
      editorSelections.notify(groupId)
      linkMirror(activeId, groupId, view)
      signals.onOutlineReady(activeId)
      const head = cached.selection.main.head
      const line = cached.doc.lineAt(head)
      useTabs.getState().markCursor(activeId, line.number, head - line.from + 1)
      const data = useBlame.getState().byTab[activeId] ?? null
      if (data) applyBlameToView(view, data)
      // Grab focus only when the state really changed (tab switch / reload);
      // a background refresh from stateEpoch should not steal focus back from the terminal
      if (changed) view.focus()
      else if (!keepCurrent) {
        // Nothing was swapped because the view still holds this document: coming back from a diff / image /
        // welcome tab, the offset has to be written back by hand — measuring and focusing the hidden editor
        // in between can leave the reader at the top of the file.
        restoreScroll(view, scrollKey(activeId), 0, false, takeScrollRatio(activeId))
      }
      return
    }

    setRestoring(true)
    void (async () => {
      let state: EditorState | null = null
      try {
        state = await ensureEditorState(tab, groupId)
      } catch (e) {
        // A mirror / language-pack failure must not leave the pane blank forever: report and fall back to disk
        useUi.getState().toast(errorText(e), 'error')
      } finally {
        if (cancelled) {
          setRestoring(false)
        }
      }
      if (cancelled) return
      if (!state) {
        setRestoring(false)
        return
      }
      if (view.state !== state) {
        swapState(
          view,
          scrollKey(activeId),
          state,
          prevAlive && shown ? scrollKey(shown) : null,
          fallback,
          keepCurrent,
          takeScrollRatio(activeId),
        )
      }
      applyTabDiffMarks(view, tab)
      // A freshly mounted side pane may not be measured yet (width 0 makes CodeMirror compute no viewport),
      // so measure once after setState and once more on the next frame as a fallback
      view.requestMeasure()
      requestAnimationFrame(() => {
        if (cancelled || !view.dom.isConnected) return
        view.requestMeasure()
      })
      shownIdRef.current = activeId
      editorSelections.notify(groupId)
      linkMirror(activeId, groupId, view)
      signals.onOutlineReady(activeId)
      setRestoring(false)
      view.focus()
      // A rebuilt state has no blame, apply it again
      const latest = useBlame.getState().byTab[activeId] ?? null
      if (latest) applyBlameToView(view, latest)
      // Reveal happens only in the focused pane; the other pane syncs the doc but does not jump
      const pending = useTabs.getState().reveal
      if (pending && pending.tabId === activeId && useTabs.getState().activeGroupId === groupId) {
        applyReveal(view, pending)
      }
    })()

    return () => {
      cancelled = true
    }
    // Deps: tabs.length (close then reopen the same file), stateEpoch (disk content reloaded),
    // activeTab.preview (source / preview toggle), stateKey + shared (attach / detach mirror across panes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, tabs.length, stateEpoch, activeTab?.preview, stateKey, shared])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !reveal || reveal.tabId !== activeId) return
    // Image tabs have no EditorState and the editor is hidden during SVG preview:
    // never aim a reveal request at an invisible document in either case
    if (activeTab?.kind !== 'file' || activeTab.preview) return
    // When two panes share one file, jump only in the focused pane; the other does not follow
    if (useTabs.getState().activeGroupId !== groupId) return
    applyReveal(view, reveal)
  }, [reveal, activeId, activeTab?.kind, activeTab?.preview, groupId])

  useEffect(() => {
    const view = viewRef.current
    if (!view || !activeId) return
    applyBlameToView(view, blameData ?? null)
  }, [blameData, activeId])

  // Marks arrive asynchronously after the state swap; dispatch only the gutter effect, never a full swap.
  useEffect(() => {
    const view = viewRef.current
    if (!view || !activeTab || activeTab.kind !== 'file' || activeTab.external) return
    applyDiffMarks(view, diffEntry?.marks ?? NO_DIFF_MARKS)
  }, [diffEntry, activeId, stateEpoch])

  useEffect(() => {
    const view = viewRef.current
    if (view) reconfigureTheme(view)
  }, [palette, fontSize, fontFamily])

  useEffect(() => {
    const view = viewRef.current
    if (view) setBlameEnabled(view, inlineBlame)
  }, [inlineBlame])

  // The CodeMirror host changes width when the in-pane Markdown preview opens, closes, or is resized.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.requestMeasure()
    const frame = requestAnimationFrame(() => {
      if (viewRef.current === view && view.dom.isConnected) view.requestMeasure()
    })
    return () => cancelAnimationFrame(frame)
  }, [markdownPreviewOpen])

  // The editor is hidden during preview (cannot be measured), so return to text re-measures; coming back
  // from preview also hands focus to the editor, otherwise typing lands on a page with no focus.
  useEffect(() => {
    const view = viewRef.current
    if (!view || hidden || !activeId) return
    view.requestMeasure()
    view.focus()
  }, [hidden])

  // Force a re-measure after a drag ends (splitter / terminal panel):
  // CodeMirror may reuse the previous line height on fast resizes, overlapping text
  useEffect(() => {
    return onLayoutDragging((active) => {
      if (!active) viewRef.current?.requestMeasure()
    })
  }, [])

  const focusGroup = () => {
    if (useTabs.getState().activeGroupId !== groupId) {
      useTabs.getState().setActiveGroup(groupId)
    }
  }

  const ratio = markdownPreviewRatio ?? 0.5
  const editorStyle = markdownPreviewOpen
    ? { flexGrow: ratio, flexBasis: 0 }
    : { flexGrow: 1, flexBasis: 0 }
  const previewStyle = markdownPreviewOpen
    ? { flexGrow: 1 - ratio, flexBasis: 0 }
    : undefined

  const onMarkdownSplitterDrag = (delta: number) => {
    const width = contentRef.current?.clientWidth ?? 0
    if (!width || !activeId) return
    const current = useTabs
      .getState()
      .groups.find((g) => g.id === groupId)?.markdownPreview?.[activeId]
    if (current === undefined) return
    setMarkdownPreviewRatio(groupId, activeId, current + delta / width)
  }

  return (
    <div ref={contentRef} className="absolute inset-0 flex min-h-0 min-w-0 overflow-hidden">
      <div className="relative min-h-0 min-w-0 overflow-hidden" style={editorStyle}>
        <div
          ref={hostRef}
          onPointerDownCapture={focusGroup}
          onFocusCapture={focusGroup}
          className={`absolute inset-y-0 left-0 right-0 overflow-hidden ${hidden ? 'invisible' : ''}`}
        />
        {showRuler && activeTab ? (
          <DiffRuler
            root={activeTab.root}
            rel={activeTab.rel}
            dirty={activeTab.dirty}
            mtime={activeTab.mtime}
            tabId={activeTab.id}
            groupId={groupId}
          />
        ) : null}
        {activeTab?.kind === 'welcome' ? <Welcome /> : null}
        {activeTab?.kind === 'settings' ? <SettingsView /> : null}
        {activeTab?.kind === 'chat' ? (
          <AgentChat key={activeTab.id} chatId={activeTab.id.slice('chat:'.length)} />
        ) : null}
        {activeTab?.kind === 'image' ? <ImageView tab={activeTab} /> : null}
        {activeTab?.kind === 'file' && activeTab.preview ? (
          <ImageView tab={activeTab} svgText={svgText} />
        ) : null}
        {activeTab?.kind === 'diff' ? <DiffView tab={activeTab} /> : null}
        {restoring && slowRestore ? (
          <div className="pointer-events-none absolute left-1/2 top-2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-2.5 py-1 text-2xs text-muted shadow-popup">
            <Icon name="refresh" size={11} />
            {activeTab && activeTab.kind !== 'welcome' && activeTab.kind !== 'settings'
              ? t('editor.restoringFile', { name: tabTitle(activeTab) })
              : t('editor.restoringState')}
          </div>
        ) : null}
      </div>

      {markdownPreviewOpen && activeTab ? (
        <>
          <Splitter
            direction="v"
            tone="editor"
            onDrag={onMarkdownSplitterDrag}
            onCommit={() => viewRef.current?.requestMeasure()}
          />
          <div
            className="min-h-0 min-w-0 overflow-hidden"
            style={previewStyle}
            onPointerDownCapture={focusGroup}
          >
            <MarkdownPreview
              key={activeTab.id}
              root={activeTab.root}
              rel={activeTab.rel}
              tabId={activeTab.id}
              stateKey={stateKey}
              stateEpoch={stateEpoch}
            />
          </div>
        </>
      ) : null}
    </div>
  )
}
