/**
 * Last scroll position per tab. There is only one global EditorView: tab switches go through setState,
 * so this records the position before leaving and writes it back on return; otherwise every file shares
 * one scroll offset.
 */
import type { EditorView } from '@codemirror/view'

const spots = new Map<string, number>()
const MAX_ENTRIES = 64

export function rememberScroll(id: string, top: number) {
  if (!Number.isFinite(top) || top < 0) return
  // Re-insert so the Map's insertion order equals recency of use
  spots.delete(id)
  spots.set(id, top)
  while (spots.size > MAX_ENTRIES) {
    const oldest = spots.keys().next().value
    if (oldest === undefined) break
    spots.delete(oldest)
  }
}

export function recallScroll(id: string): number | undefined {
  return spots.get(id)
}

export function forgetScroll(id: string) {
  spots.delete(id)
}

/**
 * One-shot relative position (0–1) handed over from a view that is about to disappear — the empty diff
 * switching to the file tab — so the editor lands where the reader was. Keyed by the tab that will read
 * it: a pixel offset does not transfer between diff rows and the editor's own font metrics.
 */
const ratios = new Map<string, number>()

export function handOffScrollRatio(id: string, ratio: number) {
  if (!Number.isFinite(ratio)) return
  ratios.set(id, Math.min(1, Math.max(0, ratio)))
}

/** Consume the handoff once: only the mount that opens the receiving tab applies it */
export function takeScrollRatio(id: string): number | undefined {
  const ratio = ratios.get(id)
  if (ratio !== undefined) ratios.delete(id)
  return ratio
}

export function dropScrollRatio(id: string) {
  ratios.delete(id)
}

/** Closing a tab: clear its position in every panel (keys look like `primary:<tabId>`) */
export function forgetScrollForTab(tabId: string) {
  for (const key of [...spots.keys()]) {
    if (key === tabId || key.endsWith(`:${tabId}`)) spots.delete(key)
  }
}

/** Move positions to the new tab id after a rename (both panes' records follow) */
export function rekeyScroll(from: string, to: string) {
  for (const key of [...spots.keys()]) {
    if (key === from) {
      const top = spots.get(from)!
      spots.delete(from)
      spots.set(to, top)
    } else if (key.endsWith(`:${from}`)) {
      const prefix = key.slice(0, -from.length)
      const top = spots.get(key)!
      spots.delete(key)
      spots.set(prefix + to, top)
    }
  }
}

/** Target id of the last restore: the next-frame fallback correction only applies while the view still shows it */
let lastRestoreId: string | null = null

/**
 * Bumped whenever a reveal (search hit / jump to line) takes over the position. A restore started before it —
 * typically the "a newly opened file starts on line 1" pin of the very tab just opened — must not write its
 * offset afterwards, or it drags the reader back to the top of the file.
 */
let generation = 0

/** A reveal owns the position from here on: drop the pending restore writes */
export function cancelScrollCorrection() {
  generation += 1
  lastRestoreId = null
}

/**
 * Write the remembered position back into the view, or go to the top when nothing is recorded. After setState
 * the content height is still an estimate and the browser clamps scrollTop, so set it synchronously to avoid a
 * flash and again in the measure write phase; the top position also goes through measure with a next-frame
 * fallback correction.
 *
 * keepCurrent = background reload of the same tab: keep the caller's current position instead of jumping back
 * to the offset recorded when leaving. ratio = a position handed over from another view (an empty diff that
 * became this file tab): it wins over both and is applied once the view has its real height.
 */
export function restoreScroll(
  view: EditorView,
  id: string,
  fallback: number,
  keepCurrent = false,
  ratio?: number,
) {
  const remembered = recallScroll(id)
  const top = Math.max(0, keepCurrent || remembered === undefined ? fallback : remembered)
  const mine = generation
  const write = (target: number) => {
    // A reveal happened meanwhile (jump to a search hit): that position wins over this restore
    if (mine !== generation) return
    // A position may leak to another tab after split/merge, so clamp it to the current doc height first,
    // otherwise the view lands in blank space (looking like the editor has no content)
    const max = Math.max(0, view.scrollDOM.scrollHeight - view.scrollDOM.clientHeight)
    // A handed-off ratio: the diff row count and the doc line count differ, so only the progress transfers
    const next =
      ratio === undefined
        ? Math.min(top === 0 ? 0 : Math.max(0, target), max)
        : Math.round(Math.min(1, Math.max(0, ratio)) * max)
    if (Math.abs(view.scrollDOM.scrollTop - next) > 1) view.scrollDOM.scrollTop = next
  }

  lastRestoreId = id
  if (ratio === undefined) write(top)
  view.requestMeasure({
    read: () => top,
    write: (value) => write(value),
  })

  // A handed-off ratio is relative to the content height, which CodeMirror only settles after a measure:
  // write it once more on the next frame so a long file does not land visibly short of the diff position
  if (ratio !== undefined) {
    requestAnimationFrame(() => {
      if (mine !== generation || !view.dom.isConnected) return
      write(top)
    })
    return
  }
  if (top !== 0) return
  // A newly opened file must stay on the first line: recheck after this frame's render and measure finish
  requestAnimationFrame(() => {
    if (mine !== generation || lastRestoreId !== id || !view.dom.isConnected) return
    if (view.scrollDOM.scrollTop !== 0) write(0)
  })
}