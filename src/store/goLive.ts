import { create } from 'zustand'
import { api, errorText, type LiveInfo } from '../lib/ipc'
import { useTabs, type Tab } from './tabs'
import { useUi } from './ui'

export function canGoLive(tab: Tab | undefined): tab is Tab {
  return Boolean(tab && tab.kind === 'file' && /\.html?$/i.test(tab.external ? tab.name : tab.rel))
}

type GoLiveStore = {
  servers: LiveInfo[]
  busy: boolean
  refresh: () => Promise<void>
  start: (tab: Tab) => Promise<LiveInfo | null>
  stop: (id: string) => Promise<void>
  stopAll: () => Promise<void>
  open: (id: string) => Promise<void>
}
let listRevision = 0
const report = (error: unknown) => useUi.getState().toast(errorText(error), 'error')

/** No native calls or subscriptions until the user starts a preview or opens its list. */
export const useGoLive = create<GoLiveStore>((set, get) => ({
  servers: [],
  busy: false,
  refresh: async () => {
    const revision = ++listRevision
    try {
      const servers = await api.liveList()
      if (revision === listRevision) set({ servers })
    } catch (error) {
      if (revision === listRevision) report(error)
    }
  },
  start: async (tab) => {
    if (get().busy || !canGoLive(tab)) return null
    listRevision += 1
    set({ busy: true })
    try {
      if (tab.dirty && !(await useTabs.getState().save(tab.id))) return null
      const current = useTabs.getState().tabs.find((current) => current.id === tab.id)
      if (!canGoLive(current)) return null
      const server = await api.liveStart(current.root, current.rel)
      await get().refresh()
      return server
    } catch (error) {
      report(error)
      return null
    } finally {
      set({ busy: false })
    }
  },
  stop: async (id) => {
    if (get().busy) return
    listRevision += 1
    set({ busy: true })
    try {
      await api.liveStop(id)
      set({ servers: get().servers.filter((server) => server.id !== id) })
    } catch (error) {
      report(error)
      await get().refresh()
    } finally {
      set({ busy: false })
    }
  },
  stopAll: async () => {
    if (get().busy) return
    listRevision += 1
    set({ busy: true })
    try {
      await api.liveStopAll()
      set({ servers: [] })
    } catch (error) {
      report(error)
    } finally {
      set({ busy: false })
    }
  },
  open: async (id) => {
    try {
      await api.liveOpen(id)
    } catch (error) {
      report(error)
      await get().refresh()
    }
  },
}))
