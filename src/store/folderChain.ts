import { create } from 'zustand'
import { api } from '../lib/ipc'
import { isUnder } from '../lib/paths'

/**
 * Folder compaction cache (see settings.compactFolders).
 *
 * A folder that holds no files (only one subfolder) is a wasted row: the chain shrinks to one line.
 * Resolving that chain means descending until it branches, which is done by one backend command so
 * a visible row costs a single round-trip (reading level by level from the frontend would spawn a
 * `git check-ignore` subprocess per level and blow the tree's performance budget).
 *
 * Results are cached per `root:rel` and only recomputed when something above that folder changed.
 */

/** Matches the backend cap: deep enough for `java/com/company/product/module/...` trees */
export const MAX_CHAIN_DEPTH = 16
/** Parallel probes: one per visible folder, but no burst of 30 calls at once */
const CONCURRENCY = 4

const keyOf = (root: string, rel: string) => `${root}:${rel}`

type QueueItem = { id: number; root: string; rel: string; showHidden: boolean }

/** Queued / running probes, so a row rendered several times only asks once */
const inFlight = new Set<string>()
/** Probes that failed (browser dev mode / unreadable folder): no retry until something invalidates them */
const failed = new Set<string>()
/**
 * Latest probe id per key. A probe started before an invalidate can come back afterwards with the old
 * shape; comparing ids drops that late answer instead of writing it over the fresh one.
 */
const latest = new Map<string, number>()
let nextId = 1
let queue: QueueItem[] = []
let active = 0

type FolderChainStore = {
  /** `${root}:${rel}` -> deepest rel of its single-child chain (rel itself when it already branches) */
  chains: Record<string, string>
  /** Ask for a chain (cache hit queues nothing) */
  resolve: (root: string, rel: string, showHidden: boolean) => void
  /**
   * Drop cached chains a change at `rel` can affect: only chains starting at an ancestor of `rel`, because
   * an entry added/removed inside a folder is what can turn a single-child chain into a branching one.
   * Without `rel` the whole root is dropped (git operations touch arbitrary paths).
   */
  invalidate: (root: string, rel?: string) => void
  reset: () => void
}

export const useFolderChain = create<FolderChainStore>((set, get) => {
  const pump = () => {
    while (active < CONCURRENCY && queue.length > 0) {
      const task = queue.shift()
      if (!task) break
      const key = keyOf(task.root, task.rel)
      if (failed.has(key)) {
        inFlight.delete(key)
        continue
      }
      active += 1
      void (async () => {
        const current = () => latest.get(key) === task.id
        try {
          const deepest = await api.resolveDirChain(
            task.root,
            task.rel,
            task.showHidden,
            MAX_CHAIN_DEPTH,
          )
          // Outdated answer (the folder changed while probing): let the newer probe decide
          if (!current()) return
          if (!deepest) {
            failed.add(key)
            return
          }
          // Cache even an unchanged folder: it is what makes the row repaint settle instead of re-probing
          if (get().chains[key] !== deepest) {
            set({ chains: { ...get().chains, [key]: deepest } })
          }
        } catch {
          // Browser dev / folder gone: remember it, otherwise the tree re-probes on every rebuild
          if (current()) failed.add(key)
        } finally {
          if (current()) {
            inFlight.delete(key)
            latest.delete(key)
          }
          active -= 1
          pump()
        }
      })()
    }
  }

  /** Whether a chain starting at `startRel` is affected by a change at `rel` */
  const affected = (startRel: string, rel: string | undefined) =>
    rel === undefined || isUnder(rel, startRel) || isUnder(startRel, rel)

  return {
    chains: {},

    resolve: (root, rel, showHidden) => {
      const key = keyOf(root, rel)
      if (key in get().chains || inFlight.has(key) || failed.has(key)) return
      inFlight.add(key)
      const id = nextId++
      latest.set(key, id)
      queue.push({ id, root, rel, showHidden })
      pump()
    },

    invalidate: (root, rel) => {
      const prefix = `${root}:`
      const chains = get().chains
      const next: Record<string, string> = {}
      let changed = false
      for (const [key, value] of Object.entries(chains)) {
        if (!key.startsWith(prefix) || !affected(key.slice(prefix.length), rel)) {
          next[key] = value
          continue
        }
        changed = true
      }
      queue = queue.filter((task) => task.root !== root || !affected(task.rel, rel))
      for (const [key] of [...latest]) {
        if (key.startsWith(prefix) && affected(key.slice(prefix.length), rel)) latest.delete(key)
      }
      for (const set of [inFlight, failed]) {
        for (const key of [...set]) {
          if (key.startsWith(prefix) && affected(key.slice(prefix.length), rel)) set.delete(key)
        }
      }
      if (changed) set({ chains: next })
    },

    reset: () => {
      queue = []
      inFlight.clear()
      failed.clear()
      latest.clear()
      set({ chains: {} })
    },
  }
})
