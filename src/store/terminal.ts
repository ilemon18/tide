import { listen } from '@tauri-apps/api/event'
import { create } from 'zustand'
import { api, errorText } from '../lib/ipc'
import { useUi } from './ui'
import { activeRoot } from './workspace'

export type TerminalTab = {
  id: string
  /** Creation ordinal: the title is built from the current language at render time, not stored */
  ordinal: number
  ptyId: string | null
  exited: boolean
  /** +1 on every restart, forces TerminalView to rebuild the xterm instance */
  generation: number
  /** Context at open time: workspace root + relative dir, used as the shell cwd */
  root: string | null
  rel: string
}

type TerminalStore = {
  tabs: TerminalTab[]
  activeId: string | null
  visible: boolean
  maximized: boolean
  setMaximized: (maximized: boolean) => void

  open: (root?: string | null, rel?: string) => string
  /** Close a terminal tab: the UI goes away, shell and its process group end with it */
  close: (id: string) => void
  /** End all terminal sessions and collapse the panel */
  closeAll: () => void
  activate: (id: string) => void
  setVisible: (visible: boolean) => void
  toggle: () => void
  setPtyId: (tabId: string, ptyId: string) => void
  markExited: (ptyId: string) => void
  /** Reopen a PTY in the same tab after the shell exits */
  restart: (id: string) => void
  /** Switch project: repoint existing terminals to the new root (kill old shell, reopen in place) */
  retarget: (root: string | null) => void
}

/** Whether focus is inside an xterm instance (⌘W closes the terminal or the editor tab based on focus) */
export function terminalFocused(): boolean {
  const el = document.activeElement
  // Focus usually lands on the hidden textarea xterm inserts for us
  return !!el?.closest('.xterm, .xterm-helper-textarea')
}

/** PTY output dispatch: one global listen, each terminal instance registers its own handler */
const handlers = new Map<string, (data: string) => void>()
let listenersReady = false
let terminalCounter = 0

/**
 * Output buffered while no view owns the PTY yet (opening a batch of terminals, around restarts). In normal use
 * xterm stays mounted and this path is unused; the cap keeps a background dev server from eating memory.
 */
const MAX_BACKLOG = 128 * 1024
type Backlog = { chunks: string[]; size: number }
const backlogs = new Map<string, Backlog>()

function pushBacklog(ptyId: string, data: string) {
  let entry = backlogs.get(ptyId)
  if (!entry) {
    entry = { chunks: [], size: 0 }
    backlogs.set(ptyId, entry)
  }
  entry.chunks.push(data)
  entry.size += data.length
  while (entry.size > MAX_BACKLOG && entry.chunks.length > 1) {
    const head = entry.chunks.shift()
    if (!head) break
    entry.size -= head.length
  }
  if (entry.size <= MAX_BACKLOG || entry.chunks.length === 0) return
  const head = entry.chunks[0]
  let keep = head.length - (entry.size - MAX_BACKLOG)
  // Keep the retained tail on a complete UTF-16 surrogate pair.
  if (keep > 0 && keep < head.length) {
    const code = head.charCodeAt(keep)
    if (code >= 0xdc00 && code <= 0xdfff) keep -= 1
  }
  entry.chunks[0] = head.slice(Math.max(0, keep))
  entry.size = entry.chunks[0].length
}

/** Register an output handler and take back what accumulated while unmounted (caller writes backlog first) */
export function registerPtyHandler(ptyId: string, handler: (data: string) => void) {
  const backlog = backlogs.get(ptyId)
  backlogs.delete(ptyId)
  handlers.set(ptyId, handler)
  return {
    unregister: () => {
      // Delete only self: a new instance may already own this pty after a tab switch
      if (handlers.get(ptyId) === handler) handlers.delete(ptyId)
    },
    backlog: backlog ? backlog.chunks.join('') : '',
  }
}

export async function setupPtyEvents() {
  if (listenersReady) return
  listenersReady = true
  await listen<{ id: string; data: string }>('pty:data', (event) => {
    const { id, data } = event.payload
    // Write directly when a view owns it; only an unmounted view (restart / panel unmounted) buffers,
    // since the xterm instance stays alive across tab switches and must not keep a second copy
    const handler = handlers.get(id)
    if (handler) handler(data)
    else pushBacklog(id, data)
  })
  await listen<{ id: string }>('pty:exit', (event) => {
    handlers.delete(event.payload.id)
    // Keep the last bit of output: a revived view can still see the pre-exit message,
    // freed only when the tab closes
    useTerminal.getState().markExited(event.payload.id)
  })
}

export const useTerminal = create<TerminalStore>((set, get) => ({
  tabs: [],
  activeId: null,
  visible: false,
  maximized: false,
  setMaximized: (maximized) => set({ maximized }),

  open: (root, rel = '') => {
    // No root means "open in the current project"; only an explicit null means no project
    const targetRoot = root === undefined ? (activeRoot()?.id ?? null) : root
    terminalCounter += 1
    const id = `term-${Date.now()}-${terminalCounter}`
    const tab: TerminalTab = {
      id,
      ordinal: terminalCounter,
      ptyId: null,
      exited: false,
      generation: 0,
      root: targetRoot,
      rel,
    }
    set({ tabs: [...get().tabs, tab], activeId: id, visible: true })
    return id
  },

  close: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    // Hide the UI first, then reap the PTY async, so the exit event does not race React unmount
    const tabs = get().tabs.filter((t) => t.id !== id)
    const activeId = get().activeId === id ? (tabs[tabs.length - 1]?.id ?? null) : get().activeId
    // Closing the last terminal collapses the panel instead of leaving an empty shell
    if (tabs.length === 0) set({ tabs, activeId: null, visible: false, maximized: false })
    else set({ tabs, activeId })

    if (tab?.ptyId) {
      handlers.delete(tab.ptyId)
      backlogs.delete(tab.ptyId)
      const ptyId = tab.ptyId
      setTimeout(() => {
        api.ptyClose(ptyId).catch((e) => console.error(errorText(e)))
      }, 0)
    }
  },

  closeAll: () => {
    const { tabs } = get()
    for (const tab of tabs) {
      if (!tab.ptyId) continue
      handlers.delete(tab.ptyId)
      backlogs.delete(tab.ptyId)
      const ptyId = tab.ptyId
      setTimeout(() => {
        api.ptyClose(ptyId).catch((e) => console.error(errorText(e)))
      }, 0)
    }
    set({ tabs: [], activeId: null, visible: false, maximized: false })
  },

  activate: (id) => set({ activeId: id }),

  setVisible: (visible) => set({ visible, ...(visible ? {} : { maximized: false }) }),

  toggle: () => {
    const state = get()
    if (!state.visible) {
      if (state.tabs.length === 0) state.open()
      set({ visible: true })
    } else {
      // Collapsing only hides it: the shell keeps running and the xterm instance stays mounted,
      // so reopening shows the same screen (use the tab's × to end the process)
      set({ visible: false, maximized: false })
    }
  },

  setPtyId: (tabId, ptyId) => {
    set({ tabs: get().tabs.map((t) => (t.id === tabId ? { ...t, ptyId } : t)) })
  },

  markExited: (ptyId) => {
    const { tabs } = get()
    const target = tabs.find((t) => t.ptyId === ptyId)
    // Idempotent: PTY exit may fire several times, ignore if already marked
    if (!target || target.exited) return
    set({
      tabs: tabs.map((t) => (t.id === target.id ? { ...t, exited: true } : t)),
    })
  },

  restart: (id) => {
    const tab = get().tabs.find((t) => t.id === id)
    if (!tab) return
    if (tab.ptyId) {
      const ptyId = tab.ptyId
      handlers.delete(ptyId)
      backlogs.delete(ptyId)
      setTimeout(() => {
        api.ptyClose(ptyId).catch((e) => console.error(errorText(e)))
      }, 0)
    }
    set({
      tabs: get().tabs.map((t) =>
        t.id === id ? { ...t, ptyId: null, exited: false, generation: t.generation + 1 } : t,
      ),
    })
  },

  retarget: (root) => {
    const { tabs } = get()
    let changed = false
    const next = tabs.map((tab, i) => {
      if (tab.root === root && tab.rel === '') return tab
      changed = true
      if (tab.ptyId) {
        // The old shell's cwd is meaningless now, end it
        handlers.delete(tab.ptyId)
        backlogs.delete(tab.ptyId)
        const ptyId = tab.ptyId
        setTimeout(() => {
          api.ptyClose(ptyId).catch((e) => console.error(errorText(e)))
        }, 0)
      }
      return {
        ...tab,
        ordinal: i + 1,
        ptyId: null,
        exited: false,
        // A new generation makes TerminalView rebuild and reopen the shell with the new root
        generation: tab.generation + 1,
        root,
        rel: '',
      }
    })
    if (changed) set({ tabs: next })
  },
}))
