import { listen } from '@tauri-apps/api/event'
import { useGit } from './git'
import { useTabs } from './tabs'
import { useWorkspace } from './workspace'
import { useFileIndex, indexHasFile } from './fileIndex'
import { useFolderChain } from './folderChain'
import { dirname } from '../lib/paths'

type FsChanged = {
  root: string
  /** Hit .git: branch switch / stage / commit / fetch */
  git: boolean
  /** Worktree file change */
  worktree: boolean
  paths: string[]
}

let ready = false
const diskTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Paths accumulated within the debounce window: null means recompute all diff tabs under that root */
const diskPaths = new Map<string, string[] | null>()

type WatchTransition = {
  depth: number
  graceTimer?: ReturnType<typeof setTimeout>
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
      const { root, git, worktree, paths } = event.payload
      // checkout/create explicitly rebuild status, branches, tree and open files. Ignore the watcher's
      // duplicate .git/tree batch while that work is active (and through its debounce tail).
      if (git && branchTransitions.has(root)) return

      const workspace = useWorkspace.getState()
      const node = workspace.roots.find((r) => r.id === root)
      if (!node) return

      // Fetch updates remote-tracking refs only. Its explicit action already refreshes branches and status,
      // so a pure .git batch must not invalidate folder chains or rebuild the expanded tree.
      const metadataOnly = git && metadataTransitions.has(root)
      if (metadataOnly && !worktree) return

      const gitStore = useGit.getState()
      // Don't call git for non-repo projects: a status run per save is a wasted subprocess. A .git hit must
      // probe once (signal of git init / rm -rf .git in a terminal); refresh() fixes isRepo via the result.
      if (git || node.isGitRepo) gitStore.scheduleRefresh(root)
      if (git) gitStore.invalidateBranches(root)

      if (git && !metadataOnly) {
        // Branch switch / reset / merge touches many files: refresh the whole expanded tree.
        // quiet: no toast on background failure (dirs vanishing after a checkout is normal)
        useFolderChain.getState().invalidate(root)
        void workspace.refreshTree(root, { quiet: true })
        // The file set probably changed: mark the ⌘P index stale so it rebuilds next open
        useFileIndex.getState().invalidate(root)
      } else if (worktree) {
        // Plain file change: refresh only the parent dirs of touched paths (and only if cached)
        const dirs = new Set<string>()
        for (const rel of paths) dirs.add(dirname(rel))
        for (const dir of dirs) {
          // A merged folder chain breaks as soon as an entry appears next to it
          useFolderChain.getState().invalidate(root, dir)
          if (node.tree[dir]) void workspace.refreshDir(root, dir, { quiet: true })
        }
        // Rebuild only when a path is unknown to the index (new file / external output);
        // a plain edit-save must not rescan on every ⌘P
        const known = useFileIndex.getState().byRoot[root]
        if (known && known.files.length > 0 && paths.some((rel) => !indexHasFile(known, rel))) {
          useFileIndex.getState().invalidate(root)
        }
      }

      // .git change = stage / commit / branch switch: recompute diff tabs too;
      // a plain file change recomputes only the diff of that file. A fetch is metadata-only.
      scheduleRefreshFromDisk(root, git && !metadataOnly ? undefined : paths)
    })
  } catch {
    ready = false
  }
}