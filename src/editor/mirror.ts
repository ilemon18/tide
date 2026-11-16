import { Annotation, type Transaction, type EditorState } from '@codemirror/state'
import type { EditorView, ViewUpdate } from '@codemirror/view'
import { cacheEditorState, createFileState, getEditorState } from './stateCache'
import { mirrorKey } from './stateKeys'
import { getGroupOfView } from './viewRef'
import { useSettings } from '../store/settings'
import { conflictField } from './conflicts'
import type { Tab } from '../store/tabs'

/**
 * Sync layer for "the same file open in both panes" after a split. An EditorState can only be attached to one
 * EditorView, so the secondary pane gets a **mirror state**: same content, independent history. Either side
 * dispatching an edit forwards the same ChangeSet to the other; the cursor is not forwarded.
 */

/** Forwarded changes carry this mark to avoid an "A dispatches -> B dispatches back to A" echo */
const mirroring = Annotation.define<boolean>()

/** tabId -> groupId -> views currently showing this tab */
const links = new Map<string, Map<string, EditorView>>()

/** A panel starts showing this tab (called after switching in / creating the state) */
export function linkMirror(tabId: string, groupId: string, view: EditorView) {
  let byGroup = links.get(tabId)
  if (!byGroup) {
    byGroup = new Map()
    links.set(tabId, byGroup)
  }
  byGroup.set(groupId, view)
}

/** A panel no longer shows this tab (switched away / unmounted) */
export function unlinkMirror(tabId: string, groupId: string) {
  const byGroup = links.get(tabId)
  if (!byGroup) return
  byGroup.delete(groupId)
  if (byGroup.size === 0) links.delete(tabId)
}

/** Drop every registration for a view when it is destroyed (no need to know which tab it showed) */
export function unlinkView(view: EditorView) {
  for (const [tabId, byGroup] of links) {
    for (const [groupId, linked] of byGroup) {
      if (linked === view) byGroup.delete(groupId)
    }
    if (byGroup.size === 0) links.delete(tabId)
  }
}

function sameDoc(a: EditorState, b: EditorState): boolean {
  return a.doc.eq(b.doc)
}

/** Sync an edit to the other pane. Without a sibling view, at least advance the main state so save / undo see the latest content. */
export function forwardDocChange(tabId: string, update: ViewUpdate) {
  if (!update.docChanged) return
  if (update.transactions.some((tr: Transaction) => tr.annotation(mirroring))) return

  const from = getGroupOfView(update.view)
  const byGroup = links.get(tabId)
  let mirrored = false

  if (byGroup) {
    for (const [groupId, view] of byGroup) {
      if (groupId === from || view === update.view) continue
      mirrored = true
      const changes = sameDoc(view.state, update.startState)
        ? update.changes
        : { from: 0, to: view.state.doc.length, insert: update.state.doc }
      view.dispatch({ changes, annotations: mirroring.of(true) })
    }
  }

  if (mirrored) return

  // The edit came from the mirror while the main pane shows another file: the main state must advance on its own
  const canonical = getEditorState(tabId)
  if (!canonical) return
  if (!sameDoc(canonical, update.startState)) return
  cacheEditorState(
    tabId,
    canonical.update({ changes: update.changes, annotations: mirroring.of(true) }).state,
  )
}

type MirrorOpts = {
  tab: Tab
  canonical: EditorState
}

/** Build a mirror state from the main state's content. Disk content is not usable: the main state may hold unsaved edits. */
export async function createMirrorState({ tab, canonical }: MirrorOpts): Promise<EditorState> {
  const settings = useSettings.getState()
  return createFileState({
    id: mirrorKey(tab.id),
    tabId: tab.id,
    root: tab.root,
    rel: tab.rel,
    content: canonical.doc.toString(),
    tier: tab.tier,
    readOnly: tab.readOnly,
    // If the main state carries conflict decorations the mirror needs them too, or the panes' buttons disagree
    conflicted: canonical.field(conflictField, false) !== undefined,
    tabSize: tab.indentSize ?? settings.tabSize,
    useTabs: tab.useTabs,
    wordWrap: tab.wordWrap ?? settings.wordWrap,
    inlineBlame: settings.inlineBlame,
  })
}