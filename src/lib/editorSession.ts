import { api, type SavedTab } from './ipc'
import { IS_PRIMARY_WINDOW, useWorkspace } from '../store/workspace'
import { useTabs } from '../store/tabs'
import {
  loadExternalTabs,
  saveExternalTabs,
  type ExternalTabEntry,
} from './externalTabs'

/**
 * Persist "last opened files": restore the editing session on restart (files + active tab +
 * cursor). Kept separate from the workspace saveSession (layout fields): this runs on every cursor
 * move, so it must be debounced and must not overwrite roots / recent.
 */

/** Debounce window: switch a few tabs, browse a few files, then write once */
const SAVE_DELAY = 1200
/** Max files remembered (truncated again on restore) */
const MAX_SAVE = 20
/** External tabs are window-scoped, but their own list is independent of the project root */
const MAX_EXTERNAL_TABS = 20

let installTimer: ReturnType<typeof setTimeout> | null = null
let lastScheduled = ''
let lastWritten = ''
let installed = false
/** Do not write before startup restore finishes: an empty tab set would wipe the saved session */
let armed = false

type EditorSessionPayload = {
  root: string | null
  tabs: SavedTab[]
  active: string | null
  external: ExternalTabEntry[]
}

function collect(): EditorSessionPayload {
  const state = useTabs.getState()
  // Diff / welcome tabs are not restored: their content is temporary anyway.
  // External files are not project-relative: they go to their own localStorage list below.
  const docTabs = state.tabs.filter(
    (tab) => (tab.kind === 'file' || tab.kind === 'image') && tab.root && !tab.external,
  )
  const root = docTabs[0]?.root ?? null
  const tabs = docTabs
    .filter((tab) => tab.root === root)
    .slice(0, MAX_SAVE)
    .map((tab) => {
      const cursor = state.cursors[tab.id]
      return { rel: tab.rel, line: cursor?.line ?? 1, col: cursor?.col ?? 1 }
    })
  const active = state.tabs.find((tab) => tab.id === state.activeId && tab.root === root)
  const external = state.tabs
    .filter((tab) => tab.external && (tab.kind === 'file' || tab.kind === 'image'))
    .slice(0, MAX_EXTERNAL_TABS)
    .map((tab) => {
      const cursor = state.cursors[tab.id]
      return {
        path: tab.root,
        line: cursor?.line ?? 1,
        col: cursor?.col ?? 1,
        active: tab.id === state.activeId,
      }
    })
  return { root, tabs, active: active?.rel ?? null, external }
}

/** Write now (window hidden / unmounting): cursor positions go along */
export function flushEditorSession() {
  if (!IS_PRIMARY_WINDOW || !armed) return
  if (installTimer) {
    clearTimeout(installTimer)
    installTimer = null
  }
  const payload = collect()
  const key = JSON.stringify(payload)
  if (key === lastWritten) return
  lastWritten = key
  saveExternalTabs(payload.external)
  void api.saveOpenTabs(payload.root, payload.tabs, payload.active).catch(() => {})
}

function schedule() {
  if (!armed) return
  const payload = collect()
  // Cheap comparison: cursor moves do not trigger a write, they wait for the window to hide
  const key = `${payload.root}|${payload.tabs.map((tab) => tab.rel).join(',')}|${payload.active}|${payload.external
    .map((tab) => tab.path)
    .join(',')}`
  if (key === lastScheduled) return
  lastScheduled = key
  if (installTimer) clearTimeout(installTimer)
  installTimer = setTimeout(() => {
    installTimer = null
    flushEditorSession()
  }, SAVE_DELAY)
}

/** Subscribe to tab changes (only the primary window saves) */
export function installEditorSession() {
  if (installed || !IS_PRIMARY_WINDOW) return
  installed = true
  useTabs.subscribe(() => schedule())
}

/** Startup (including restore) is done: write from now on */
export function armEditorSession() {
  armed = true
}

/** Restore on startup: only when the current project equals the recorded one, to avoid mismatches */
export async function restoreEditorSession() {
  if (!IS_PRIMARY_WINDOW) return
  let session
  try {
    session = await api.loadSession()
  } catch {
    return
  }
  const root = session.openRoot
  if (!root) return
  const current = useWorkspace.getState().roots[0]
  if (!current || current.id !== root) return

  // Reopen the folders first, in one commit: otherwise the explorer first draws the root level, then the
  // restored file's chain pops open a moment later
  const expanded = session.expanded?.[root] ?? []
  if (expanded.length > 0) {
    await useWorkspace.getState().expandChain(root, expanded, { silent: true })
  }

  if (!session.tabs || session.tabs.length === 0) return
  await useTabs.getState().restoreOpenTabs(root, session.tabs, session.activeTab ?? null)
}

/**
 * Restore external tabs after the project session. Missing / moved files are skipped silently:
 * they were outside the project, so there is no tree row that could explain the failure.
 */
export async function restoreExternalTabs() {
  if (!IS_PRIMARY_WINDOW) return
  const entries = loadExternalTabs()
  if (entries.length === 0) return
  const previousActive = useTabs.getState().activeId
  let activeId: string | null = null
  for (const entry of entries) {
    await useTabs.getState().openExternalFile(entry.path, { quiet: true })
    const tab = useTabs.getState().tabs.find((item) => item.external && item.root === entry.path)
    if (!tab) continue
    useTabs.setState((state) => ({
      cursors: { ...state.cursors, [tab.id]: { line: entry.line, col: entry.col } },
    }))
    if (entry.active) activeId = tab.id
  }
  // Opening each tab activates it, so restore the saved active tab only after the whole list.
  // If no external tab was active, put the startup focus back where it was (project/untitled).
  const restoreId = activeId ?? previousActive
  if (restoreId && useTabs.getState().tabs.some((tab) => tab.id === restoreId)) {
    useTabs.getState().activate(restoreId)
  }
}
