import { create } from 'zustand'
import { api } from '../lib/ipc'
import { budget } from '../lib/memoryBudget'

/**
 * Quick-open file index.
 *
 * Memory matters more than it looks: a big repo holds tens of thousands of paths, and every extra
 * object or Set around them costs several MB for the whole session. So the index keeps a plain sorted
 * `string[]` — no `{ path }` wrappers, no parallel Set (membership is a binary search) — and it is built
 * lazily: opening a project no longer walks the tree, only asking for the list (⌘P) does.
 */

/** Index TTL: past it, the next ⌘P rebuilds (so externally added files are not missed) */
const MAX_AGE = 5 * 60 * 1000

export type RootIndex = {
  /** Sorted file paths (relative to the root): sorting enables both the binary search and a stable list */
  files: string[]
  truncated: boolean
  builtAt: number
  building: boolean
  /** Directory changed but not rebuilt yet */
  stale: boolean
}

type FileIndexStore = {
  byRoot: Record<string, RootIndex>
  /** Ensure the index is usable; concurrent calls for one root run once */
  ensure: (root: string) => Promise<void>
  /** Structure likely changed (branch switch / pull): rebuild before next use */
  invalidate: (root: string) => void
  forget: (root: string) => void
}

const EMPTY: RootIndex = {
  files: [],
  truncated: false,
  builtAt: 0,
  building: false,
  stale: true,
}

/** Is this path in the index? Binary search over the sorted array: no Set to keep in memory */
export function indexHasFile(index: RootIndex | undefined, path: string): boolean {
  if (!index) return false
  const files = index.files
  let low = 0
  let high = files.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const value = files[mid]
    if (value === path) return true
    if (value < path) low = mid + 1
    else high = mid - 1
  }
  return false
}

export const useFileIndex = create<FileIndexStore>((set, get) => {
  const patchRoot = (root: string, next: Partial<RootIndex>) => {
    const current = get().byRoot[root] ?? EMPTY
    set({ byRoot: { ...get().byRoot, [root]: { ...current, ...next } } })
  }

  return {
    byRoot: {},

    ensure: async (root) => {
      const current = get().byRoot[root]
      if (current?.building) return
      const fresh =
        current && !current.stale && current.builtAt > 0 && Date.now() - current.builtAt < MAX_AGE
      if (fresh) return

      patchRoot(root, { building: true })
      try {
        const page = await api.listFiles(root, budget.quickOpenFiles())
        // Sort here once: every later "is this path known" check is a binary search instead of a Set
        const files = page.files.map((hit) => hit.path).sort()
        patchRoot(root, {
          files,
          truncated: page.truncated,
          builtAt: Date.now(),
          building: false,
          stale: false,
        })
      } catch {
        // Index failure stays quiet: keep old results and retry later
        patchRoot(root, { building: false, stale: true })
      }
    },

    invalidate: (root) => {
      const current = get().byRoot[root]
      if (!current) return
      patchRoot(root, { stale: true })
    },

    forget: (root) => {
      const next = { ...get().byRoot }
      delete next[root]
      set({ byRoot: next })
    },
  }
})
