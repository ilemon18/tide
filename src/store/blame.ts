import { create } from 'zustand'
import { api, type BlameResult } from '../lib/ipc'
import { useSettings } from './settings'
import { budget, feature } from '../lib/memoryBudget'
import type { Tab } from './tabs'

/**
 * key = root|rel|mtime: any repo change bumps mtime and invalidates it. Every save adds one entry and a
 * single blame can hold thousands of ranges, so a cap is required (lower in lightweight mode).
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

type BlameStore = {
  byTab: Record<string, BlameResult | null>
  loading: Record<string, boolean>
  scheduleFetch: (tab: Tab) => void
  fetchNow: (tab: Tab) => Promise<void>
  invalidate: (tabId: string) => void
  /** Keep blame data for one tab only; other tabs refetch on demand when reactivated */
  dropOtherTabs: (keepTabId: string | null) => void
  clear: () => void
}

export const useBlame = create<BlameStore>((set, get) => ({
  byTab: {},
  loading: {},

  scheduleFetch: (tab) => {
    if (tab.kind !== 'file') return
    // Lightweight mode: no per-file `git blame` run, no range data kept in memory
    if (!feature.inlineBlame()) return
    if (!useSettings.getState().inlineBlame) return

    const key = `${tab.root}|${tab.rel}|${tab.mtime}`
    const cached = cache.get(key)
    if (cached) {
      // A hit refreshes LRU order
      cache.delete(key)
      cache.set(key, cached)
      if (get().byTab[tab.id] !== cached) {
        set({ byTab: { ...get().byTab, [tab.id]: cached } })
      }
      return
    }

    const existing = timers.get(tab.id)
    if (existing) clearTimeout(existing)
    timers.set(
      tab.id,
      setTimeout(() => {
        timers.delete(tab.id)
        void get().fetchNow(tab)
      }, 200),
    )
  },

  fetchNow: async (tab) => {
    if (tab.kind !== 'file' || !feature.inlineBlame() || !useSettings.getState().inlineBlame) return
    const key = `${tab.root}|${tab.rel}|${tab.mtime}`
    set({ loading: { ...get().loading, [tab.id]: true } })
    try {
      const result = await api.gitBlame(tab.root, tab.rel)
      remember(key, result)
      set({ byTab: { ...get().byTab, [tab.id]: result }, loading: { ...get().loading, [tab.id]: false } })
    } catch {
      remember(key, {
        disabled: true,
        reason: null,
        lineCount: 0,
        ranges: [],
        latest: null,
        root: tab.root,
        rel: tab.rel,
      })
      set({ loading: { ...get().loading, [tab.id]: false } })
    }
  },

  invalidate: (tabId) => {
    const timer = timers.get(tabId)
    if (timer) {
      clearTimeout(timer)
      timers.delete(tabId)
    }
    const next = { ...get().byTab }
    delete next[tabId]
    const loading = { ...get().loading }
    delete loading[tabId]
    set({ byTab: next, loading })
  },

  dropOtherTabs: (keepTabId) => {
    const byTab: Record<string, BlameResult | null> = {}
    const loading: Record<string, boolean> = {}
    const kept = keepTabId ? get().byTab[keepTabId] : undefined
    if (keepTabId && kept) byTab[keepTabId] = kept
    if (keepTabId && get().loading[keepTabId]) loading[keepTabId] = true
    set({ byTab, loading })
  },

  clear: () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    cache.clear()
    set({ byTab: {}, loading: {} })
  },
}))

/** Which blame range a line belongs to */
export function blameRangeAt(result: BlameResult | null | undefined, line: number) {
  if (!result || result.disabled) return null
  for (const range of result.ranges) {
    if (line >= range.startLine && line < range.startLine + range.lineCount) return range
  }
  return null
}