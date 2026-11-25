/**
 * Session for files opened outside every workspace.
 *
 * External tabs are not part of the Rust workspace session (which stores relative paths per
 * project root). Like untitled drafts, they live in localStorage: only the primary window writes,
 * the list is small, and restoring one re-grants exactly that file through the backend.
 */

export type ExternalTabEntry = { path: string; line: number; col: number; active?: boolean }

const KEY = 'tide.externalTabs'
const MAX_EXTERNAL_TABS = 20

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function loadExternalTabs(): ExternalTabEntry[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (item): item is ExternalTabEntry =>
          Boolean(item) &&
          typeof (item as ExternalTabEntry).path === 'string' &&
          typeof (item as ExternalTabEntry).line === 'number' &&
          typeof (item as ExternalTabEntry).col === 'number',
      )
      .slice(0, MAX_EXTERNAL_TABS)
  } catch {
    return []
  }
}

/** Write now: the editor session already debounces and only calls this when the list changed. */
export function saveExternalTabs(entries: ExternalTabEntry[]) {
  const store = storage()
  if (!store) return
  try {
    const kept = entries.slice(0, MAX_EXTERNAL_TABS)
    if (kept.length === 0) store.removeItem(KEY)
    else store.setItem(KEY, JSON.stringify(kept))
  } catch {
    /* Storage disabled / quota: external sessions are a convenience, never fail the editor */
  }
}
