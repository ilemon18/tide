import { create } from 'zustand'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api, errorText, type DirEntryInfo, type RecentWorkspace } from '../lib/ipc'
import { errorCode } from '../lib/ipc'
import { basename, dirname, isUnder, joinRel } from '../lib/paths'
import { useUi } from './ui'
import { useFileIndex } from './fileIndex'
import { useFolderChain } from './folderChain'
import { feature } from '../lib/memoryBudget'
import { t } from '../i18n'

/** Whether this window is the main one: only main restores / saves the session, so windows don't overwrite each other */
function detectPrimaryWindow(): boolean {
  try {
    const label = getCurrentWindow().label
    // No label (vite in a browser / old build): treat it as the main window
    return !label || label === 'main'
  } catch {
    return true
  }
}

export const IS_PRIMARY_WINDOW = detectPrimaryWindow()

const PAGE_SIZE = 200
/**
 * How many open folders are remembered per root. Each one costs a directory read on the next start, and
 * expanded folders keep their entries cached (pruneTree never drops them), so this stays modest.
 */
const MAX_SAVED_EXPANDED = 40
/** Dir cache cap (per root): beyond it, collapse-uncached dirs are evicted to bound memory */
const MAX_CACHED_DIRS = 30
/** Guard for "expand all": max dirs / depth per run, so a big repo is not read whole */
const MAX_EXPAND_DIRS = 80
const MAX_EXPAND_DEPTH = 8
/** Heavy dirs not expanded automatically even without a .gitignore */
const HEAVY_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.turbo',
  '.cache',
  'Pods',
  '.idea',
])

export type DirState = {
  entries: DirEntryInfo[]
  total: number
  hasMore: boolean
  loading: boolean
}

export type RootNode = {
  id: string
  name: string
  isGitRepo: boolean
  tree: Record<string, DirState>
  expanded: Record<string, boolean>
  collapsed: boolean
}

/** Target the explorer must expand and select after a breadcrumb click */
export type TreeReveal = {
  root: string
  /** Relative path; '' means the project root node */
  rel: string
  isDir: boolean
  nonce: number
}

let nextRevealNonce = 1

type WorkspaceStore = {
  roots: RootNode[]
  activeRootId: string | null
  recent: RecentWorkspace[]
  lastWorkspace: string | null
  loading: boolean
  /** Explorer reveal request (breadcrumb click) */
  treeReveal: TreeReveal | null

  initSession: () => Promise<void>
  openFolder: (path: string) => Promise<RootNode | null>
  openFolders: (paths: string[]) => Promise<void>
  closeWorkspace: () => Promise<void>
  removeRoot: (rootId: string) => Promise<void>
  /** Remove a recent entry (does not affect already open projects) */
  removeRecent: (path: string) => Promise<void>
  setActiveRoot: (rootId: string) => void
  toggleRootCollapsed: (rootId: string) => void
  /** Sync repo state (git init / rm -rf .git in a terminal). Returns whether it changed so the caller can reload branches. */
  setGitRepo: (rootId: string, isGitRepo: boolean) => boolean
  requestTreeReveal: (target: Omit<TreeReveal, 'nonce'>) => void
  clearTreeReveal: (nonce: number) => void

  toggleDir: (root: string, rel: string) => Promise<void>
  expandDir: (root: string, rel: string) => Promise<void>
  /**
   * Expand a whole directory chain at once (opening / revealing a file). Fetch in parallel, commit state once:
   * awaiting level by level pops dirs out one after another like a stuttering animation.
   */
  expandChain: (root: string, rels: string[], options?: { silent?: boolean }) => Promise<void>
  loadMore: (root: string, rel: string) => Promise<void>
  /** quiet: background refresh (watcher), no toast on failure, only drop dead dirs from the cache */
  refreshDir: (root: string, rel: string, options?: { quiet?: boolean }) => Promise<void>
  refreshTree: (root?: string, options?: { quiet?: boolean }) => Promise<void>
  collapseAll: () => void
  /** Expand all dirs (bounded by dir count / depth, skips .gitignore and heavy dirs) */
  expandAll: (rootId: string, showHidden: boolean) => Promise<void>
  /** Write the layout (roots, expanded folders) now: on quit / hide, so the next start paints the same tree */
  flushSession: () => void

  createEntry: (root: string, dir: string, name: string, kind: 'file' | 'dir') => Promise<string | null>
  renameEntry: (root: string, rel: string, nextName: string) => Promise<string | null>
  /** Drag a file / folder into another folder; returns the new rel, or null when nothing moved */
  moveEntry: (root: string, from: string, toDir: string) => Promise<string | null>
  deleteEntry: (root: string, rel: string) => Promise<void>
  pruneCaches: () => void
}

/** Concurrency-limited batch run: opening many dirs must not flood IPC at once */
async function mapLimit<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      await run(item)
    }
  })
  await Promise.all(workers)
}

function splitRecent(list: RecentWorkspace[], path: string, name: string): RecentWorkspace[] {
  const next = [{ path, name, openedAt: Date.now() }, ...list.filter((r) => r.path !== path)]
  return next.slice(0, 16)
}

/**
 * Keep entries only for the root and expanded dirs. Expanded ones must stay: dropping their cache makes
 * children vanish after collapse and re-expand.
 */
function pruneTree(node: RootNode): RootNode {
  const keys = Object.keys(node.tree)
  if (keys.length <= MAX_CACHED_DIRS) return node
  const next: Record<string, DirState> = {}
  for (const rel of keys) {
    if (rel === '' || node.expanded[rel]) next[rel] = node.tree[rel]
  }
  return { ...node, tree: next }
}

export function emptyRoot(id: string, name: string, isGitRepo: boolean): RootNode {
  return { id, name, isGitRepo, tree: {}, expanded: { '': true }, collapsed: false }
}

export const useWorkspace = create<WorkspaceStore>((set, get) => {
  const patchRoot = (rootId: string, patch: (node: RootNode) => RootNode) => {
    set({ roots: get().roots.map((r) => (r.id === rootId ? pruneTree(patch(r)) : r)) })
  }

  const saveSession = () => {
    // With several windows only the main one writes the session, so they don't overwrite each other
    if (!IS_PRIMARY_WINDOW) return
    const { roots, recent, activeRootId } = get()
    // Which folders are open, per root: the explorer comes back in its previous shape. Bounded, since each
    // entry costs a directory read on the next start
    const expanded: Record<string, string[]> = {}
    for (const root of roots) {
      expanded[root.id] = Object.keys(root.expanded)
        .filter((rel) => rel !== '')
        .slice(0, MAX_SAVED_EXPANDED)
    }
    api
      .saveSession({
        recent,
        lastWorkspace: roots[0]?.id ?? null,
        roots: roots.map((r) => r.id),
        activeRoot: activeRootId,
        expanded,
      })
      .catch(() => {})
  }

  return {
    roots: [],
    activeRootId: null,
    recent: [],
    lastWorkspace: null,
    loading: false,
    treeReveal: null,

    initSession: async () => {
      try {
        const session = await api.loadSession()
        set({ recent: session.recent ?? [], lastWorkspace: session.lastWorkspace ?? null })
        // A new window starts empty; only the main window restores the last project
        if (!IS_PRIMARY_WINDOW) return
        const roots = session.roots ?? []
        if (roots.length > 0) {
          // Old sessions may hold several roots: prefer activeRoot, else the last one
          const target =
            session.activeRoot && roots.includes(session.activeRoot)
              ? session.activeRoot
              : roots[roots.length - 1]
          await get().openFolder(target)
        }
      } catch {
        /* No session file on first launch */
      }
    },

    openFolder: async (path) => {
      const existing = get().roots.find((r) => r.id === path)
      if (existing) {
        set({ activeRootId: existing.id })
        // Reopening the same project also moves it to the top of the recent list
        void api
          .rememberRecent(existing.id, existing.name)
          .then((recent) => set({ recent }))
          .catch(() => {})
        return existing
      }
      set({ loading: true })
      try {
        const info = await api.openFolder(path)
        // Single-project mode: a new dir replaces the old root, release its backend grant first
        const oldRootIds: string[] = []
        for (const old of get().roots) {
          if (old.id !== info.root) {
            oldRootIds.push(old.id)
            await api.closeFolder(old.id).catch(() => {})
          }
        }
        const node = emptyRoot(info.root, info.name, info.isGitRepo)
        // The recent list is maintained by the backend (shared across windows, writable from any)
        let recent = splitRecent(get().recent, info.root, info.name)
        try {
          recent = await api.rememberRecent(info.root, info.name)
        } catch {
          /* Fall back to the local list when the backend is unavailable */
        }
        set({
          roots: [node],
          activeRootId: info.root,
          loading: false,
          recent,
        })
        // Drop the other projects' search indexes on switch, to save memory
        for (const old of oldRootIds) useFileIndex.getState().forget(old)
        // Building the ⌘P index walks the whole tree and keeps every path in memory, so it waits for the
        // first ⌘P instead of riding along with opening a project. Lightweight mode never prebuilds.
        if (feature.eagerFileIndex()) void useFileIndex.getState().ensure(info.root)
        saveSession()
        await get().refreshDir(info.root, '')
        return node
      } catch (e) {
        set({ loading: false })
        // The project is already open in another window (backend brought it forward): no error dialog
        if (errorCode(e) !== 'workspace.openInOtherWindow') {
          useUi.getState().toast(errorText(e), 'error')
        }
        return null
      }
    },

    openFolders: async (paths) => {
      // Single-project mode keeps only the first dir, others should open in a new window
      if (paths.length === 0) return
      if (paths.length > 1) {
        useUi.getState().toast(t('toast.oneProjectPerWindow'), 'info')
      }
      await get().openFolder(paths[0])
    },

    closeWorkspace: async () => {
      const ids = get().roots.map((r) => r.id)
      for (const id of ids) {
        await api.closeFolder(id).catch(() => {})
        useFileIndex.getState().forget(id)
        useFolderChain.getState().invalidate(id)
      }
      set({ roots: [], activeRootId: null })
      saveSession()
    },

    removeRoot: async (rootId) => {
      await api.closeFolder(rootId).catch(() => {})
      useFileIndex.getState().forget(rootId)
      useFolderChain.getState().invalidate(rootId)
      const roots = get().roots.filter((r) => r.id !== rootId)
      set({
        roots,
        activeRootId: get().activeRootId === rootId ? (roots[0]?.id ?? null) : get().activeRootId,
      })
      saveSession()
    },

    removeRecent: async (path) => {
      const prev = get().recent
      const next = prev.filter((r) => r.path !== path)
      if (next.length === prev.length) return
      set({ recent: next })
      try {
        const list = await api.removeRecent(path)
        set({ recent: list })
      } catch (e) {
        // Roll back on backend write failure, so UI and disk stay consistent
        set({ recent: prev })
        useUi.getState().toast(errorText(e), 'error')
      }
    },

    setActiveRoot: (rootId) => {
      if (!get().roots.some((r) => r.id === rootId)) return
      set({ activeRootId: rootId })
      saveSession()
    },

    toggleRootCollapsed: (rootId) => {
      patchRoot(rootId, (node) => ({ ...node, collapsed: !node.collapsed }))
    },

    setGitRepo: (rootId, isGitRepo) => {
      const node = get().roots.find((r) => r.id === rootId)
      if (!node || node.isGitRepo === isGitRepo) return false
      patchRoot(rootId, (n) => ({ ...n, isGitRepo }))
      // .gitignore starts / stops applying here: rebuild the ⌘P index and recompute every ignored mark
      // in the tree (else entries that were greyed out stay grey)
      useFileIndex.getState().invalidate(rootId)
      useFolderChain.getState().invalidate(rootId)
      void get().refreshTree(rootId, { quiet: true })
      return true
    },

    requestTreeReveal: (target) => {
      set({ treeReveal: { ...target, nonce: nextRevealNonce++ } })
    },

    clearTreeReveal: (nonce) => {
      if (get().treeReveal?.nonce === nonce) set({ treeReveal: null })
    },

    toggleDir: async (root, rel) => {
      const node = get().roots.find((r) => r.id === root)
      if (!node) return
      const expanded = { ...node.expanded }
      if (expanded[rel]) {
        delete expanded[rel]
        // Collapsing drops child dir caches and their expanded marks, else re-expanding the parent shows
        // children as "expanded" with no entries
        const tree = { ...node.tree }
        for (const key of Object.keys(tree)) {
          if (key !== rel && key.startsWith(rel === '' ? '' : rel + '/')) delete tree[key]
        }
        for (const key of Object.keys(expanded)) {
          if (key && key.startsWith(rel === '' ? '' : rel + '/')) delete expanded[key]
        }
        patchRoot(root, (n) => ({ ...n, expanded, tree }))
        return
      }
      expanded[rel] = true
      patchRoot(root, (n) => ({ ...n, expanded }))
      if (!get().roots.find((r) => r.id === root)?.tree[rel]) {
        await get().refreshDir(root, rel)
      }
    },

    expandDir: async (root, rel) => {
      const node = get().roots.find((r) => r.id === root)
      if (!node) return
      // Already expanded with a cache hit: reveal calls this on every file open,
      // short-circuiting avoids rebuilding roots and re-rendering the whole tree
      if (node.expanded[rel] && node.tree[rel]) return
      patchRoot(root, (n) => ({ ...n, expanded: { ...n.expanded, [rel]: true } }))
      if (!node.tree[rel]) await get().refreshDir(root, rel)
    },

    expandChain: async (root, rels, options) => {
      const node = get().roots.find((r) => r.id === root)
      if (!node) return
      // Expanded with a cache hit means nothing to do: reveal runs on every file open,
      // rebuilding roots for it would re-render the whole tree
      const pending = rels.filter((rel) => !node.expanded[rel] || !node.tree[rel])
      if (pending.length === 0) return

      const missing = pending.filter((rel) => !node.tree[rel])
      // Fetch all missing dirs in parallel first (so 2+ levels don't await IPC level by level)
      const loaded: [string, DirState][] = []
      await mapLimit(missing, 4, async (rel) => {
        try {
          const page = await api.readDir(root, rel, 0, PAGE_SIZE)
          loaded.push([
            rel,
            { entries: page.entries, total: page.total, hasMore: page.hasMore, loading: false },
          ])
        } catch (e) {
          // One level unreadable (deleted / no permission): report it like step-by-step expansion, don't block others.
          // Silent on startup restore: a folder deleted while Tide was closed is not worth a toast.
          if (!options?.silent) useUi.getState().toast(errorText(e), 'error')
        }
      })
      // The project may have switched / a dir collapsed while fetching: merge against the latest tree
      patchRoot(root, (n) => {
        const expanded = { ...n.expanded }
        for (const rel of pending) expanded[rel] = true
        const tree = { ...n.tree }
        for (const [rel, state] of loaded) tree[rel] = state
        return { ...n, expanded, tree }
      })
    },

    collapseAll: () => {
      // Collapse levels only, keep the root cache: top-level files stay visible instead of
      // a blank tree (which would look like an empty project)
      set({
        roots: get().roots.map((r) => {
          const rootEntries: Record<string, DirState> = r.tree[''] ? { '': r.tree[''] } : {}
          return { ...r, expanded: { '': true }, tree: rootEntries }
        }),
      })
    },

    flushSession: () => saveSession(),

    expandAll: async (rootId, showHidden) => {
      const node = get().roots.find((r) => r.id === rootId)
      if (!node) return

      const expanded: Record<string, boolean> = { ...node.expanded, '': true }
      const tree: Record<string, DirState> = { ...node.tree }
      let budget = MAX_EXPAND_DIRS

      const load = async (rel: string): Promise<DirState | null> => {
        const cached = tree[rel]
        if (cached) return cached
        try {
          const page = await api.readDir(rootId, rel, 0, PAGE_SIZE)
          const state: DirState = {
            entries: page.entries,
            total: page.total,
            hasMore: page.hasMore,
            loading: false,
          }
          tree[rel] = state
          return state
        } catch {
          return null
        }
      }

      // Expand level by level: read each level in parallel instead of waiting serially on a big tree
      let frontier: { rel: string; depth: number }[] = [{ rel: '', depth: 0 }]
      while (frontier.length > 0 && budget > 0) {
        const next: { rel: string; depth: number }[] = []
        await mapLimit(frontier, 6, async ({ rel, depth }) => {
          const state = await load(rel)
          if (!state) return
          // Mark a dir expanded only when its entries really loaded, avoiding "expanded but blank" rows
          expanded[rel] = true
          if (depth >= MAX_EXPAND_DEPTH) return
          for (const entry of state.entries) {
            if (!entry.isDir || HEAVY_DIRS.has(entry.name)) continue
            if (!showHidden && entry.name.startsWith('.')) continue
            if (entry.ignored) continue
            if (budget <= 0) break
            budget -= 1
            next.push({ rel: entry.path, depth: depth + 1 })
          }
        })
        frontier = next
      }

      // The watcher may have committed a refresh meanwhile: merge instead of overwriting
      patchRoot(rootId, (n) => ({
        ...n,
        collapsed: false,
        expanded: { ...n.expanded, ...expanded },
        tree: { ...n.tree, ...tree },
      }))
    },

    loadMore: async (root, rel) => {
      const node = get().roots.find((r) => r.id === root)
      const current = node?.tree[rel]
      if (!node || !current || !current.hasMore || current.loading) return
      patchRoot(root, (n) => ({ ...n, tree: { ...n.tree, [rel]: { ...current, loading: true } } }))
      try {
        const page = await api.readDir(root, rel, current.entries.length, PAGE_SIZE)
        patchRoot(root, (n) => ({
          ...n,
          tree: {
            ...n.tree,
            [rel]: {
              entries: [...current.entries, ...page.entries],
              total: page.total,
              hasMore: page.hasMore,
              loading: false,
            },
          },
        }))
      } catch (e) {
        patchRoot(root, (n) => ({ ...n, tree: { ...n.tree, [rel]: { ...current, loading: false } } }))
        useUi.getState().toast(errorText(e), 'error')
      }
    },

    refreshDir: async (root, rel, options) => {
      try {
        const page = await api.readDir(root, rel, 0, PAGE_SIZE)
        patchRoot(root, (n) => ({
          ...n,
          tree: {
            ...n.tree,
            [rel]: {
              entries: page.entries,
              total: page.total,
              hasMore: page.hasMore,
              loading: false,
            },
          },
        }))
      } catch (e) {
        const message = errorText(e)
        // Dir deleted / renamed externally: drop the stale cache instead of showing a nonexistent dir
        if (errorCode(e) === 'io.notFound') {
          patchRoot(root, (n) => {
            const tree = { ...n.tree }
            delete tree[rel]
            const expanded = { ...n.expanded }
            delete expanded[rel]
            return { ...n, tree, expanded }
          })
        }
        // A background refresh failure (watching for changes) must not toast: dirs vanishing after a branch
        // switch is normal and a toast would look like files were lost
        if (options?.quiet) {
          console.warn('[Tide] 刷新目录失败', rel, message)
          return
        }
        useUi.getState().toast(message, 'error')
      }
    },

    refreshTree: async (root, options) => {
      // Whole tree re-read (branch switch / manual refresh): merged folder chains may have changed shape
      for (const node of root ? get().roots.filter((r) => r.id === root) : get().roots) {
        useFolderChain.getState().invalidate(node.id)
      }
      const targets = root ? get().roots.filter((r) => r.id === root) : get().roots
      for (const node of targets) {
        const expanded = Object.keys(node.expanded).filter((k) => node.expanded[k])
        const dirs = expanded.length > 0 ? expanded : ['']
        // Dirs are independent: read in parallel with a concurrency cap; serial is visibly slow with many open
        await mapLimit(dirs, 6, (rel) => get().refreshDir(node.id, rel, options))
      }
    },

    createEntry: async (root, dir, name, kind) => {
      const rel = joinRel(dir, name)
      try {
        await api.createEntry(root, rel, kind)
        useFileIndex.getState().invalidate(root)
        useFolderChain.getState().invalidate(root, dir)
        await get().expandDir(root, dir)
        await get().refreshDir(root, dir)
        return rel
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
        return null
      }
    },

    renameEntry: async (root, rel, nextName) => {
      const parent = dirname(rel)
      const to = joinRel(parent, nextName)
      if (to === rel) return rel
      try {
        await api.renameEntry(root, rel, to)
        useFileIndex.getState().invalidate(root)
        useFolderChain.getState().invalidate(root, parent)
        await get().refreshDir(root, parent)
        return to
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
        return null
      }
    },

    moveEntry: async (root, from, toDir) => {
      const to = joinRel(toDir, basename(from))
      // Dropped where it already lives, onto itself, or into its own subtree: nothing to do
      if (to === from || dirname(from) === toDir) return null
      if (isUnder(toDir, from)) return null
      try {
        // The backend renames (same device inside one project) under the same path checks as rename_entry
        await api.renameEntry(root, from, to)
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
        return null
      }
      useFileIndex.getState().invalidate(root)
      useFolderChain.getState().invalidate(root, dirname(from))
      useFolderChain.getState().invalidate(root, toDir)
      await get().refreshDir(root, dirname(from))
      await get().refreshDir(root, toDir)
      return to
    },

    deleteEntry: async (root, rel) => {
      try {
        await api.deleteEntry(root, rel)
        useFileIndex.getState().invalidate(root)
        useFolderChain.getState().invalidate(root, rel)
        await get().refreshDir(root, dirname(rel))
      } catch (e) {
        useUi.getState().toast(errorText(e), 'error')
      }
    },

    pruneCaches: () => {
      set({ roots: get().roots.map(pruneTree) })
    },
  }
})

/** Currently active root */
export function activeRoot(): RootNode | null {
  const { roots, activeRootId } = useWorkspace.getState()
  return roots.find((r) => r.id === activeRootId) ?? roots[0] ?? null
}

export function rootById(id: string | null): RootNode | null {
  if (!id) return null
  return useWorkspace.getState().roots.find((r) => r.id === id) ?? null
}

export function visibleEntries(state: DirState | undefined, showHidden: boolean): DirEntryInfo[] {
  if (!state) return []
  if (showHidden) return state.entries
  return state.entries.filter((e) => !e.name.startsWith('.'))
}

export function displayName(rel: string): string {
  return basename(rel)
}