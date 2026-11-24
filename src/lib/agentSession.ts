import type { AgentTabRef, AgentTabs } from './ipc'
import { agentBridge } from './agentBridge'
import { api } from './ipc'
import { chatTabId, useAgent } from '../store/agent'
import { useSettings } from '../store/settings'
import { useTabs } from '../store/tabs'
import { IS_PRIMARY_WINDOW, useWorkspace } from '../store/workspace'

/**
 * Chat tabs are not part of the file session (`save_open_tabs` runs on every cursor move).
 * They live in their own tiny file, so both writes stay independent.
 */

const SAVE_DELAY = 400
let installed = false
let armed = false
let timer: ReturnType<typeof setTimeout> | null = null
let lastKey = ''

function collect(): AgentTabs {
  const state = useTabs.getState()
  const chats = state.tabs.filter((tab) => tab.kind === 'chat').slice(0, 8)
  const active = state.tabs.find((tab) => tab.id === state.activeId && tab.kind === 'chat')
  return {
    tabs: chats.map((tab) => ({ id: tab.id.slice('chat:'.length), root: tab.root })),
    active: active ? active.id.slice('chat:'.length) : null,
  }
}

function schedule() {
  if (!armed || !IS_PRIMARY_WINDOW) return
  // A disabled feature must not overwrite the open-chat list with an empty set
  if (!useSettings.getState().agentEnabled) return
  const payload = collect()
  const key = JSON.stringify(payload)
  if (key === lastKey) return
  lastKey = key
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    if (!useSettings.getState().agentEnabled) return
    void api.agentTabsSave(payload.tabs, payload.active).catch(() => {})
  }, SAVE_DELAY)
}

export function installAgentTabSync() {
  if (installed || !IS_PRIMARY_WINDOW) return
  installed = true
  useTabs.subscribe(() => schedule())
}

/** Write now (window hide / close): otherwise a just-open chat tab disappears on restart */
export function flushAgentTabs() {
  if (!armed || !IS_PRIMARY_WINDOW) return
  if (!useSettings.getState().agentEnabled) return
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  const payload = collect()
  lastKey = JSON.stringify(payload)
  void api.agentTabsSave(payload.tabs, payload.active).catch(() => {})
}

/**
 * Reopen the chat tabs of the last session. Only the primary window restores, and only chats
 * whose project root is open: a chat transcript is not useful without its workspace.
 */
export async function restoreAgentChats() {
  if (!IS_PRIMARY_WINDOW) return
  try {
    if (useSettings.getState().agentEnabled) {
      const saved = await api.agentTabsLoad().catch(() => null)
      if (saved && saved.tabs.length > 0) {
        const roots = new Set(useWorkspace.getState().roots.map((root) => root.id))
        const tabs: AgentTabRef[] = saved.tabs.filter((tab) => roots.has(tab.root)).slice(0, 8)
        if (tabs.length > 0) {
          // Opening a chat activates it; put the file the user was looking at back in front.
          const previousActive = useTabs.getState().activeId
          const restored: AgentTabRef[] = []
          for (const ref of tabs) {
            await useAgent.getState().loadChat(ref.id)
            const chat = useAgent.getState().chats[ref.id]
            // A transcript removed outside Tide must not come back as an empty, broken tab
            if (!chat) continue
            useTabs.getState().openChat(ref.id, ref.root, chat.title)
            restored.push(ref)
          }
          const active = restored.find((tab) => tab.id === saved.active)
          if (active) useTabs.getState().activate(chatTabId(active.id))
          else if (previousActive) useTabs.getState().activate(previousActive)
        }
      }
    }
  } finally {
    // From now on, tab changes are persisted (an empty set would otherwise wipe the file
    // before the restore above has finished)
    armed = true
    installAgentTabSync()
  }
}

/** Closing a chat tab stops its process and lets its transcript settle before it leaves memory */
export function installAgentBridge() {
  agentBridge.isChatRunning = (chatId) => useAgent.getState().chats[chatId]?.status === 'running'
  agentBridge.onTabClosed = (chatId) => {
    void useAgent.getState().stop(chatId)
    setTimeout(() => {
      if (!useTabs.getState().tabs.some((tab) => tab.id === chatTabId(chatId))) {
        useAgent.getState().forgetChat(chatId)
      }
    }, 2000)
  }
}
