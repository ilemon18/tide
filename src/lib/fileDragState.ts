import type { PointerEvent as ReactPointerEvent } from 'react'
import { create } from 'zustand'
import { useTabs } from '../store/tabs'
import { groupUnderPointer, highlightPane, insertionIndex, normalizeDropIndex } from './groupDrop'

/**
 * Pointer drag from explorer / source control into an editor pane. Not HTML5 drag & drop: the
 * Tauri window accepts native file drops, and the drop target is often CodeMirror's DOM (a native
 * drop would be treated as "insert text"). Same pointer approach as tab dragging:
 * `elementFromPoint` hits `data-group` to get the **exact** target pane, then we explicitly open
 * there on release.
 */

export type FileDragStart = {
  root: string
  rel: string
  /** Text shown in the ghost; defaults to rel */
  name?: string
  /** A folder can only be moved inside the tree, never opened in an editor pane */
  isDir?: boolean
  /** Symlinks can move inside the tree, but opening their target is unsupported */
  isSymlink?: boolean
}

type Ghost = { x: number; y: number; name: string } | null

/** Ghost that follows the pointer (rendered on body by FileDragGhost so sidebar overflow cannot clip it) */
export const useFileDragGhost = create<{ ghost: Ghost }>(() => ({ ghost: null }))

/** After a real drag, the click that follows must not open the file again (the user just released) */
let draggedAt = 0

export function wasFileDragJustFinished(): boolean {
  return Date.now() - draggedAt < 250
}

const THRESHOLD = 4

/** A folder row in the tree accepts a move; the row carries its own (root, rel) */
export type DirDropTarget = { root: string; rel: string; el: HTMLElement }

/** Resolve the folder row under the pointer (rows mark themselves with data-drop-dir) */
function dirTargetAt(x: number, y: number): DirDropTarget | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('[data-drop-dir="true"]')
  if (!el) return null
  const root = el.dataset.dropRoot
  const rel = el.dataset.dropRel
  if (root === undefined || rel === undefined) return null
  return { root, rel: rel === '.' ? '' : rel, el }
}

/**
 * Whether dropping `from` on `toDir` would do nothing or is impossible: same folder, the item itself, or one
 * of its own descendants (a folder cannot move into itself).
 */
function isBadDropTarget(from: string, toDir: string): boolean {
  if (toDir === from) return true
  // Already in that folder: the move would be a no-op
  if (from.slice(0, Math.max(0, from.lastIndexOf('/'))) === toDir) return true
  // Target sits inside the dragged folder
  return toDir.startsWith(`${from}/`)
}

/**
 * Lock page-wide selection during a drag. WebKit quirk: it does not fully honor `user-select: none`
 * while dragging and pulls a selection into the editor (`.cm-gutters` text gets painted blue).
 * So besides forcing `user-select` plus the `-webkit-` prefix on html / body, we watch
 * `selectionchange` and clear any selection that appears — you cannot be selecting text mid-drag.
 */
export function lockTextSelection(): () => void {
  const html = document.documentElement
  const body = document.body
  const hadDrag = html.dataset.pointerDrag
  html.dataset.pointerDrag = 'true'
  const hadHtml = html.style.userSelect
  const hadBody = body.style.userSelect

  for (const el of [html, body]) {
    el.style.userSelect = 'none'
    el.style.setProperty('-webkit-user-select', 'none')
  }

  const clear = () => {
    const selection = window.getSelection()
    if (selection && selection.rangeCount > 0) selection.removeAllRanges()
  }
  clear()
  document.addEventListener('selectionchange', clear)

  return () => {
    document.removeEventListener('selectionchange', clear)
    // Release may have just painted a selection: clear again so the editor does not inherit it on focus
    clear()
    if (hadDrag === undefined) delete html.dataset.pointerDrag
    else html.dataset.pointerDrag = hadDrag
    html.style.userSelect = hadHtml
    html.style.removeProperty('-webkit-user-select')
    body.style.userSelect = hadBody
    body.style.removeProperty('-webkit-user-select')
  }
}

export function beginFilePointerDrag(
  event: ReactPointerEvent<HTMLElement>,
  payload: FileDragStart,
  /** Extra drop target: releasing over a folder row in the tree moves the file there */
  options?: { onDropDir?: (target: { root: string; rel: string }) => void },
) {
  // Left button only; context menu / middle click untouched
  if (event.button !== 0) return
  const { root, rel } = payload
  const name = payload.name ?? rel.split('/').pop() ?? rel
  const startX = event.clientX
  const startY = event.clientY
  const canOpenInPane = !payload.isDir && !payload.isSymlink
  let started = false
  let grabX = 10
  let grabY = 16
  let unlockSelection: (() => void) | null = null
  /** Folder row currently highlighted as a move target */
  let hoverRow: HTMLElement | null = null

  const setHoverRow = (el: HTMLElement | null) => {
    if (hoverRow === el) return
    if (hoverRow) delete hoverRow.dataset.dropActive
    hoverRow = el
    if (hoverRow) hoverRow.dataset.dropActive = 'true'
  }

  const stop = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onCancel)
    window.removeEventListener('blur', onCancel)
    window.removeEventListener('keydown', onKey, true)
    useFileDragGhost.setState({ ghost: null })
    highlightPane(null)
    setHoverRow(null)
    if (started) {
      unlockSelection?.()
      unlockSelection = null
      draggedAt = Date.now()
    }
  }

  const onMove = (ev: PointerEvent) => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) < THRESHOLD && Math.abs(ev.clientY - startY) < THRESHOLD) {
        return
      }
      started = true
      unlockSelection = lockTextSelection()
      // Ghost sits below-right of the cursor; near an edge it flips to the other side
      grabX = ev.clientX > window.innerWidth - 240 ? -230 : 12
      grabY = ev.clientY > window.innerHeight - 60 ? -34 : 8
    }
    useFileDragGhost.setState({
      ghost: { x: ev.clientX + grabX, y: ev.clientY + grabY, name },
    })
    // A folder row in the tree wins over the editor pane: that is a move, not an open
    const dir = options?.onDropDir ? dirTargetAt(ev.clientX, ev.clientY) : null
    // Never offer the current folder, the item itself, or one of its own subfolders
    const valid = Boolean(dir) && dir!.root === root && !isBadDropTarget(rel, dir!.rel)
    setHoverRow(valid ? dir!.el : null)
    highlightPane(valid || !canOpenInPane ? null : groupUnderPointer(ev.clientX, ev.clientY))
  }

  const onUp = (ev: PointerEvent) => {
    const dir = started && options?.onDropDir ? dirTargetAt(ev.clientX, ev.clientY) : null
    const dirDrop =
      dir && dir.root === root && !isBadDropTarget(rel, dir.rel) ? dir : null
    const group = started && !dirDrop && canOpenInPane ? groupUnderPointer(ev.clientX, ev.clientY) : null
    const index = group ? normalizeDropIndex(insertionIndex(group, ev.clientX, ev.clientY)) : undefined
    stop()
    // Never dragged (just a click) or released outside a target: do nothing, so a
    // slip in the sidebar cannot open or move a file by accident.
    if (!started) return
    if (dirDrop) {
      options?.onDropDir?.({ root: dirDrop.root, rel: dirDrop.rel })
      return
    }
    if (!group) return
    const tabs = useTabs.getState()
    void tabs
      .openFileInGroup(root, rel, group, index)
      .then(() => useTabs.getState().setActiveGroup(group))
  }

  const onCancel = () => stop()

  const onKey = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    ev.stopPropagation()
    stop()
  }

  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onCancel)
  window.addEventListener('blur', onCancel)
  window.addEventListener('keydown', onKey, true)
}
