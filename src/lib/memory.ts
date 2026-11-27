import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { trimEditorStates } from '../editor/stateCache'
import { clearImportCache } from '../editor/importLinks'
import { clearCompletionCache } from '../editor/smartComplete'
import { dropBlameCache, useBlame } from '../store/blame'
import { clearCommitDetails } from '../store/commitHover'
import { useFileIndex } from '../store/fileIndex'
import { useFolderChain } from '../store/folderChain'
import { useSearch } from '../store/search'
import { useTabs } from '../store/tabs'
import { useWorkspace } from '../store/workspace'
import { useTaskStore } from '../store/tasks'
import { budget, onMemoryProfileChange } from './memoryBudget'

/**
 * Memory reclamation. WKWebView does not hand pages back to the system just because nothing
 * references them; the JS heap counts as process usage until collected. So besides capping sizes,
 * drop rebuildable data when the window is hidden / long unfocused.
 */

/**
 * Reclaim memory. idle drops caches only, leaving editor state (undo history must not die from an
 * app switch); hidden drops documents too, keeping the active tab and any dirty ones.
 */
export function reclaimMemory(level: 'idle' | 'hidden' = 'idle') {
  useTaskStore.getState().trim()
  const { activeId } = useTabs.getState()
  if (level === 'hidden') {
    trimEditorStates(activeId)
    // Only when the window is really gone: a short blur must not empty an open search panel or make the
    // explorer re-probe every folder chain the moment the user comes back.
    useSearch.getState().dropResults()
    for (const root of useWorkspace.getState().roots) useFileIndex.getState().forget(root.id)
    useFolderChain.getState().reset()
  }
  dropBlameCache()
  useBlame.getState().dropOtherTabs(activeId)
  clearImportCache()
  clearCompletionCache()
  clearCommitDetails()
  useWorkspace.getState().pruneCaches()
}

let blurTimer: ReturnType<typeof setTimeout> | null = null

function cancelIdleReclaim() {
  if (blurTimer) {
    clearTimeout(blurTimer)
    blurTimer = null
  }
}

function scheduleIdleReclaim() {
  cancelIdleReclaim()
  // Lightweight mode reclaims sooner: an app switch is not worth 30s of idle caches there
  blurTimer = setTimeout(() => {
    blurTimer = null
    reclaimMemory('idle')
  }, budget.idleReclaimDelay())
}

/**
 * Window hidden / minimized: reclaim caches immediately. The terminal view is not unmounted
 * (unmounting loses the scroll buffer, leaving it blank on return); repaint is handled by
 * TerminalView's focus / visibilitychange hooks.
 */
export function markWindowHidden() {
  cancelIdleReclaim()
  reclaimMemory('hidden')
}

export function markWindowVisible() {
  cancelIdleReclaim()
}

let installed = false

/** Switching lightweight mode on must free memory now, not at the next restart */
onMemoryProfileChange(() => reclaimMemory('hidden'))

export function installMemoryLifecycle() {
  if (installed) return
  installed = true

  try {
    void getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        if (focused) markWindowVisible()
        else scheduleIdleReclaim()
      })
      .catch(() => {})
  } catch {
    /* Ignore outside Tauri (running vite in a browser) */
  }

  // Closing the main window only hides it (macOS habit); the backend broadcasts these two events
  void listen('app:hidden', markWindowHidden).catch(() => {})
  void listen('app:shown', markWindowVisible).catch(() => {})

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') markWindowHidden()
    else markWindowVisible()
  })
}
