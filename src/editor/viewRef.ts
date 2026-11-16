import type { EditorView } from '@codemirror/view'

/**
 * One view per editor panel (main plus split at most). getEditorView() without an argument returns the focused
 * panel's view; pass groupId to target a specific one.
 */
const views = new Map<string, EditorView>()
let focused: string | null = null

export function setEditorView(groupId: string, view: EditorView | null) {
  if (view) {
    views.set(groupId, view)
  } else {
    views.delete(groupId)
    if (focused === groupId) focused = null
  }
}

export function setFocusedGroup(groupId: string | null) {
  focused = groupId
}

/** Which panel this view belongs to (mirror sync needs to know which pane the change came from) */
export function getGroupOfView(view: EditorView): string | null {
  for (const [groupId, candidate] of views) {
    if (candidate === view) return groupId
  }
  return null
}

export function getEditorView(groupId?: string): EditorView | null {
  const id = groupId ?? focused
  if (!id) {
    // Focus not recorded yet (first panel still mounting): fall back to the only view
    if (views.size === 1) return views.values().next().value ?? null
    return null
  }
  return views.get(id) ?? null
}