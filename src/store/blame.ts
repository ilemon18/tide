import { create } from 'zustand'
import { api, type BlameResult } from '../lib/ipc'
import { useSettings } from './settings'
import { budget, feature } from '../lib/memoryBudget'
import type { Tab } from './tabs'

/**
 * key = root|rel|mtime: any repo change bumps mtime and invalidates it. Every save adds one entry and a
 * single blame can hold thousands of ranges, so a cap is required (lower in lightweight mode).
 * Editor-buffer results are NOT stored here: they only ever describe the current tab.
 */
const cache = new Map<string, BlameResult>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

/** Write and evict LRU: Map insertion order is recency order */
function remember(key: string, result: BlameResult) {
  cache.delete(key)
  cache.set(key, result)
  while (cache.size > budget.blameEntries()) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

/** Release the cache (window hide / long blur); results already attached to a tab stay */
export function dropBlameCache() {
  cache.clear()
}

/** disk: blame of the saved file. buffer: content-aware blame of the unsaved editor text. */
export type BlameSource = 'disk' | 'buffer'

type BlameStore = {
  byTab: Record<string, BlameResult | null>
  loading: Record<string, boolean>
  source: Record<string, BlameSource | undefined>
  /** Bumped by doc changes, invalidation and new requests; stale responses are dropped */
  requestSeq: Record<string, number>
  scheduleFetch: (tab: Tab) => void
  /** Explicit disk fetch; force bypasses the inline-blame setting, lightweight pause and dirty guard. */
  fetchNow: (tab: Tab, force?: boolean, attach?: boolean) => Promise<BlameResult | null>
  /** Content-aware blame for the current editor buffer; never enters the disk LRU. */
  fetchForBuffer: (
    tab: Tab,
    contents: string,
    version: number,
    attach?: boolean,
    force?: boolean,
  ) => Promise<BlameResult | null>
  invalidate: (tabId: string) => void
  /** Keep blame data for one tab only; other tabs refetch on demand when reactivated */
  dropOtherTabs: (keepTabId: string | null) => void
  clear: () => void
}

function disabledResult(tab: Tab, version: number): BlameResult {
  return {
    disabled: true,
    reason: null,
    lineCount: 0,
    ranges: [],
    root: tab.root,
    rel: tab.rel,
    currentUserName: '',
    currentUserEmail: '',
    version,
  }
}

export const useBlame = create<BlameStore>((set, get) => {
  const bump = (tabId: string) => {
    const seq = (get().requestSeq[tabId] ?? 0) + 1
    set({ requestSeq: { ...get().requestSeq, [tabId]: seq } })
    return seq
  }
  const isCurrent = (tabId: string, seq: number) => get().requestSeq[tabId] === seq
  const clearTimer = (tabId: string) => {
    const timer = timers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(tabId)
    }
  }
  const attach = (tabId: string, result: BlameResult, source: BlameSource) => {
    set({
      byTab: { ...get().byTab, [tabId]: result },
      loading: { ...get().loading, [tabId]: false },
      source: { ...get().source, [tabId]: source },
    })
  }
  const begin = (tabId: string, withLoading: boolean) => {
    set({
      ...(withLoading
        ? { byTab: { ...get().byTab, [tabId]: null }, loading: { ...get().loading, [tabId]: true } }
        : {}),
      source: { ...get().source, [tabId]: undefined },
    })
  }

  return {
    byTab: {},
    loading: {},
    source: {},
    requestSeq: {},

    scheduleFetch: (tab) => {
      if (tab.kind !== 'file' || tab.external) return
      if (tab.dirty) return
      // Lightweight mode: no per-file `git blame` run, no range data kept in memory
      if (!feature.inlineBlame()) return
      if (!useSettings.getState().inlineBlame) return

      const seq = bump(tab.id)
      clearTimer(tab.id)
      const key = `${tab.root}|${tab.rel}|${tab.mtime}`
      const cached = cache.get(key)
      if (cached) {
        // A hit refreshes LRU order
        cache.delete(key)
        cache.set(key, cached)
        attach(tab.id, cached, 'disk')
        return
      }
      timers.set(
        tab.id,
        setTimeout(() => {
          timers.delete(tab.id)
          // A later doc change / invalidation bumped the sequence; the open-file delay is obsolete.
          if (!isCurrent(tab.id, seq)) return
          void get().fetchNow(tab)
        }, 200),
      )
    },

    fetchNow: async (tab, force = false, attachResult = true) => {
      if (tab.kind !== 'file' || tab.external) return null
      if (!force && (!feature.inlineBlame() || !useSettings.getState().inlineBlame)) return null
      if (!force && tab.dirty) return null
      clearTimer(tab.id)
      const seq = bump(tab.id)
      const key = `${tab.root}|${tab.rel}|${tab.mtime}`
      const cached = cache.get(key)
      if (cached) {
        remember(key, cached)
        if (attachResult && isCurrent(tab.id, seq)) attach(tab.id, cached, 'disk')
        return cached
      }
      if (attachResult) begin(tab.id, true)
      try {
        const result = await api.gitBlame(tab.root, tab.rel)
        if (isCurrent(tab.id, seq)) {
          remember(key, result)
          if (attachResult) attach(tab.id, result, 'disk')
        }
        return result
      } catch {
        const failed = disabledResult(tab, 0)
        if (isCurrent(tab.id, seq)) {
          remember(key, failed)
          if (attachResult) attach(tab.id, failed, 'disk')
        }
        return failed
      }
    },

    fetchForBuffer: async (tab, contents, version, attachResult = true, force = false) => {
      if (tab.kind !== 'file' || tab.external) return null
      if (!force && (!feature.inlineBlame() || !useSettings.getState().inlineBlame)) return null
      // An on-demand read (gutter click) must not disturb the tab's scheduled/attached blame.
      if (!attachResult) {
        try {
          return await api.gitBlame(tab.root, tab.rel, contents, version)
        } catch {
          return disabledResult(tab, version)
        }
      }
      // A pending disk fetch would attach the saved file over this buffer's result.
      clearTimer(tab.id)
      const seq = bump(tab.id)
      if (attachResult) begin(tab.id, true)
      try {
        const result = await api.gitBlame(tab.root, tab.rel, contents, version)
        if (isCurrent(tab.id, seq) && attachResult) attach(tab.id, result, 'buffer')
        return result
      } catch {
        const failed = disabledResult(tab, version)
        if (isCurrent(tab.id, seq) && attachResult) attach(tab.id, failed, 'buffer')
        return failed
      }
    },

    invalidate: (tabId) => {
      clearTimer(tabId)
      bump(tabId)
      const byTab = { ...get().byTab }
      delete byTab[tabId]
      const loading = { ...get().loading }
      delete loading[tabId]
      const source = { ...get().source }
      delete source[tabId]
      set({ byTab, loading, source })
    },

    dropOtherTabs: (keepTabId) => {
      const byTab: Record<string, BlameResult | null> = {}
      const loading: Record<string, boolean> = {}
      const source: Record<string, BlameSource | undefined> = {}
      const requestSeq: Record<string, number> = {}
      if (keepTabId) {
        const kept = get().byTab[keepTabId]
        if (kept) byTab[keepTabId] = kept
        if (get().loading[keepTabId]) loading[keepTabId] = true
        const keptSource = get().source[keepTabId]
        if (keptSource) source[keepTabId] = keptSource
        requestSeq[keepTabId] = get().requestSeq[keepTabId] ?? 0
      }
      set({ byTab, loading, source, requestSeq })
    },

    clear: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      cache.clear()
      set({ byTab: {}, loading: {}, source: {}, requestSeq: {} })
    },
  }
})

/** Which blame range a line belongs to (binary search by startLine) */
export function blameRangeAt(result: BlameResult | null | undefined, line: number) {
  if (!result || result.disabled || result.ranges.length === 0) return null
  const ranges = result.ranges
  let low = 0
  let high = ranges.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const range = ranges[mid]
    if (line < range.startLine) high = mid - 1
    else if (line >= range.startLine + range.lineCount) low = mid + 1
    else return range
  }
  return null
}
