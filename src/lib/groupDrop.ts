import type { TabGroupId } from '../store/tabs'

/**
 * Drop target detection for editor panes (groups). Tab dragging and explorer file dragging both need
 * to answer "which pane is the pointer over, and where in the tab strip". Panes carry `data-group`,
 * tab strips carry `data-tab-strip`; this does pure DOM hit-testing and never touches the store, so
 * dragging does not re-render React every frame.
 */

export function isGroupId(value: string | undefined | null): value is TabGroupId {
  return value === 'primary' || value === 'secondary'
}

/** The pane under the pointer */
export function groupUnderPointer(x: number, y: number): TabGroupId | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null
  const id = el?.closest<HTMLElement>('[data-group]')?.dataset.group
  return isGroupId(id) ? id : null
}

/** Insertion index when the drop lands on the target pane's tab strip; on the editor area (or an empty pane) it goes last */
export function insertionIndex(target: TabGroupId, x: number, y: number): number {
  const strip = document.querySelector<HTMLElement>(`[data-group="${target}"] [data-tab-strip]`)
  if (!strip) return Number.MAX_SAFE_INTEGER
  const rect = strip.getBoundingClientRect()
  if (y < rect.top || y > rect.bottom) return Number.MAX_SAFE_INTEGER
  const els = Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]'))
  for (let i = 0; i < els.length; i += 1) {
    const r = els[i].getBoundingClientRect()
    if (x < r.left + r.width / 2) return i
  }
  return els.length
}

/** Highlight the target pane: set DOM attributes directly, avoiding dozens of React renders per second while dragging */
export function highlightPane(target: TabGroupId | null) {
  document.querySelectorAll<HTMLElement>('[data-group]').forEach((el) => {
    const id = el.dataset.group
    if (target && id === target) el.dataset.dropTarget = 'true'
    else delete el.dataset.dropTarget
  })
}

/** Sentinel used for append; insertInGroup clamps it to order.length */
export function normalizeDropIndex(index: number): number | undefined {
  return index >= Number.MAX_SAFE_INTEGER ? undefined : index
}