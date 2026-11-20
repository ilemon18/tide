import { listen } from '@tauri-apps/api/event'
import { useGit } from './git'
import { useTabs } from './tabs'
import { useWorkspace } from './workspace'
import { useFileIndex, indexHasFile } from './fileIndex'
import { useFolderChain } from './folderChain'
import { dirname } from '../lib/paths'

import type { FsChanged } from '../lib/ipc'

let ready = false
const diskTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Paths accumulated within the debounce window: null means recompute all diff tabs under that root */
const diskPaths = new Map<string, string[] | null>()

type WatchTransition = {
  depth: number
  graceTimer?: ReturnType<typeof setTimeout>
  pending?: FsChanged
}
/** Explicit checkout/create refresh owns the watcher work until it finishes, plus one watcher debounce window. */
const branchTransitions = new Map<string, WatchTransition>()
/** A fetch only changes remote-tracking refs: ignore its pure .git event instead of rebuilding the file tree. */
const metadataTransitions = new Map<string, WatchTransition>()
const WATCH_GRACE_MS = 800

function beginTransition(transitions: Map<string, WatchTransition>, root: string): void {
  const current = transitions.get(root)
  if (current) {
    if (current.graceTimer) clearTimeout(current.graceTimer)
    current.graceTimer = undefined
    current.depth += 1
    return
  }
  transitions.set(root, { depth: 1 })
}

function endTransition(transitions: Map<string, WatchTransition>, root: string): void {
  const current = transitions.get(root)
  if (!current) return
  current.depth = Math.max(0, current.depth - 1)
  if (current.depth > 0 || current.graceTimer) return
  // The backend batches fs events for 300ms. Keep the last event from repeating work after the explicit
  // refresh has completed or, for a fetch, from rebuilding the tree through its debounce tail.
  current.graceTimer = setTimeout(() => {
    if (transitions.get(root) === current && current.depth === 0) {
      transitions.delete(root)
      if (current.pending) processFsChanged(current.pending)
    }
  }, WATCH_GRACE_MS)
}

export function beginBranchTransition(root: string): void {
  beginTransition(branchTransitions, root)
}

export function endBranchTransition(root: string): void {
  endTransition(branchTransitions, root)
}

export function beginGitMetadataTransition(root: string): void {
  beginTransition(metadataTransitions, root)
}

export function endGitMetadataTransition(root: string): void {
  endTransition(metadataTransitions, root)
}

/** After external changes reload open files on demand; debounced to avoid repeated reads during checkout. No paths means recompute everything under that root. */
function scheduleRefreshFromDisk(root: string, paths?: string[] | null) {
  if (paths == null) {
    // A full refresh overrides previously accumulated incremental paths
    diskPaths.set(root, null)
  } else if (diskPaths.get(root) !== null) {
    const merged = new Set(diskPaths.get(root) ?? [])
    for (const rel of paths) merged.add(rel)
    diskPaths.set(root, [...merged])
  }

  const existing = diskTimers.get(root)
  if (existing) clearTimeout(existing)
  diskTimers.set(
    root,
    setTimeout(() => {
      diskTimers.delete(root)
      const collected = diskPaths.get(root)
      diskPaths.delete(root)
      void useTabs
        .getState()
        .refreshFromDisk(root, collected ? { paths: collected } : undefined)
    }, 400),
  )
}

/**
 * Worktree changes pushed by the backend watcher: git state refreshes at once (350ms debounce); the file tree
 * refreshes only touched expanded dirs; open files are checked by mtime.
 */
export async function setupFsEvents() {
  if (ready) return
  ready = true
  try {
    await listen<FsChanged>('fs:changed', (event) => {
      processFsChanged(event.payload)
    })
  } catch {
    ready = false
  }
}
function processFsChanged(payload: FsChanged) {
  const { root, git, worktree, paths, rescan, ignoreChanged } = payload
  // checkout/create explicitly rebuild status, branches, tree and open files. Ignore the watcher's
  // duplicate .git/tree batch while that work is active (and through its debounce tail).
  const transition = branchTransitions.get(root)
  if (transition && !rescan && !ignoreChanged && !paths.some(rel => rel === '.gitignore' || rel.endsWith('/.gitignore'))) {
    // Explicit Git refresh covers metadata; worktree notifications may include unrelated edits.
    if (worktree) {
      const previous = transition.pending
      transition.pending = { ...payload, git: false,
        paths: [...new Set([...(previous?.paths ?? []), ...paths])],
        rescan: !!previous?.rescan || paths.length === 0 }
    }
    return
  }

  const workspace = useWorkspace.getState()
  const node = workspace.roots.find((r) => r.id === root)
  if (!node) return

  // Fetch updates remote-tracking refs only. Its explicit action already refreshes branches and status,
  // so a pure .git batch must not invalidate folder chains or rebuild the expanded tree.
  const metadataOnly = git && metadataTransitions.has(root)
  if (metadataOnly && !worktree && !rescan && !ignoreChanged) return

  const gitStore = useGit.getState()
  // Don't call git for non-repo projects: a status run per save is a wasted subprocess. A .git hit must
  // probe once (signal of git init / rm -rf .git in a terminal); refresh() fixes isRepo via the result.
  if (git || rescan || node.isGitRepo) gitStore.scheduleRefresh(root)
  if (git || rescan) gitStore.invalidateBranches(root)

  const ignoreRulesChanged = ignoreChanged || paths.some((rel) => rel === '.gitignore' || rel.endsWith('/.gitignore'))
  if (rescan || ignoreRulesChanged || (worktree && paths.length === 0)) {
    // Incomplete event batches and ignore rules require a conservative refresh.
    void workspace.refreshTree(root, { quiet: true })
    useFileIndex.getState().invalidate(root)
  } else if (worktree) {
    const dirs = new Set<string>()
    for (const rel of paths) {
      dirs.add(dirname(rel))
      // Directory-only notifications may stand for changes anywhere beneath that directory.
      for (const cached of Object.keys(node.tree)) {
        if (cached === rel || cached.startsWith(`${rel}/`)) dirs.add(cached)
      }
    }
    for (const dir of dirs) useFolderChain.getState().invalidate(root, dir)
    const cached = [...dirs].filter((dir) => Boolean(node.tree[dir]))
    const known = useFileIndex.getState().byRoot[root]
    if (known && paths.some((rel) => !indexHasFile(known, rel))) useFileIndex.getState().invalidate(root)
    void workspace.refreshDirs(root, cached, { quiet: true }).then(() => {
      const latest = useWorkspace.getState().roots.find((item) => item.id === root)
      if (!latest) return
      // A removed file is still in the old quick-open index. Compare directory membership after
      // refresh as well, while ordinary saves keep the index usable.
      if (cached.some((dir) => {
        const before = node.tree[dir]?.entries ?? []
        const after = latest.tree[dir]?.entries ?? []
        return before.length !== after.length || before.some((entry, i) =>
          entry.path !== after[i]?.path || entry.isDir !== after[i]?.isDir)
      })) useFileIndex.getState().invalidate(root)
    })
  }

  // .git change = stage / commit / branch switch: recompute diff tabs too;
  // a plain file change recomputes only the diff of that file. A fetch is metadata-only.
  scheduleRefreshFromDisk(root, rescan || (git && !metadataOnly) ? undefined : paths)
}
