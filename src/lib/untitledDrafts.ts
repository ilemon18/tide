/**
 * Hot exit for untitled buffers.
 *
 * An untitled buffer (⌘N) exists only in memory, so quitting used to lose it silently. The text is
 * mirrored into localStorage, which costs nothing on the Rust side and survives a crash too.
 *
 * Only the main window keeps drafts: several windows would otherwise overwrite each other's list.
 * The cap is small on purpose — a draft is a scratch buffer, not a document store.
 */

export type UntitledDraft = { seq: number; text: string }

/** Above this, the draft is not stored: localStorage is synchronous and shared with the theme boot script */
const MAX_DRAFT_CHARS = 200_000
const MAX_DRAFTS = 10
const KEY = 'tide.untitledDrafts'
const SAVE_DELAY = 800

let timer: ReturnType<typeof setTimeout> | null = null

function enabled(): boolean {
  return typeof window !== 'undefined' && Boolean(window.localStorage)
}

export function loadUntitledDrafts(): UntitledDraft[] {
  if (!enabled()) return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is UntitledDraft =>
          Boolean(item) &&
          typeof (item as UntitledDraft).text === 'string' &&
          typeof (item as UntitledDraft).seq === 'number',
      )
      .slice(0, MAX_DRAFTS)
  } catch {
    return []
  }
}

function write(drafts: UntitledDraft[]) {
  if (!enabled()) return
  try {
    const kept = drafts
      .filter((draft) => draft.text.length <= MAX_DRAFT_CHARS)
      .slice(-MAX_DRAFTS)
    if (kept.length === 0) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* Quota exceeded or storage disabled: a draft is a convenience, never fail the editor */
  }
}

/** Debounced write: typing in a scratch buffer must not touch localStorage per keystroke */
export function saveUntitledDrafts(drafts: UntitledDraft[]) {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    write(drafts)
  }, SAVE_DELAY)
}

/** Write now (before quitting / when a draft is saved to disk) */
export function flushUntitledDrafts(drafts: UntitledDraft[]) {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  write(drafts)
}
