import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/ipc'
import { parseDiffMarks, type DiffMark } from '../lib/diffMarks'

/** One file's parsed git change marks, keyed by root + rel */
export type FileDiffMarks = {
  key: string
  /** `mtime | dirty | diffEpoch`: a different value means the cached marks are stale */
  signature: string
  marks: DiffMark[]
  /** New-side line count of the patch (0 when there is no change) */
  lines: number
  at: number
}

type DiffMarksStore = {
  byFile: Record<string, FileDiffMarks>
  load: (root: string, rel: string, signature: string) => Promise<void>
  clear: (root?: string) => void
}

/** Small LRU: every open file's mark array is tiny, but a long session can visit many files */
const MAX_FILES = 80
const EMPTY_MARKS: DiffMark[] = []

const inflight = new Map<string, Promise<void>>()
/** The signature currently requested for a key; lets a late older response know it lost the race */
const pending = new Map<string, string>()
/** Bumped by clear(): a task that started before the clear must not refill the cache */
const generations = new Map<string, number>()

export function diffMarksKey(root: string, rel: string): string {
  return `${root}\u0000${rel}`
}

export const useDiffMarks = create<DiffMarksStore>((set, get) => ({
  byFile: {},

  load: async (root, rel, signature) => {
    const key = diffMarksKey(root, rel)
    const cached = get().byFile[key]
    if (cached?.signature === signature) return

    if (pending.get(key) === signature) {
      await inflight.get(key)
      return
    }

    const generation = generations.get(key) ?? 0
    const task = (async () => {
      let patch = ''
      try {
        // Prefer worktree vs index: new-side line numbers are editor line numbers. A fully staged
        // file has an empty worktree side, so fall back to index vs HEAD (same line numbers).
        const plain = await api.gitDiffFull(root, rel, false)
        if (!plain.binary && !plain.truncated) patch = plain.patch
        if (!patch.trim()) {
          const staged = await api.gitDiffFull(root, rel, true)
          if (!staged.binary && !staged.truncated) patch = staged.patch
        }
      } catch {
        // Not a Git repo / deleted file: present as "no changes" without bothering the user
        patch = ''
      }
      if ((generations.get(key) ?? 0) !== generation) return
      if (pending.get(key) !== signature) return
      const parsed = patch.trim() ? parseDiffMarks(patch) : { marks: EMPTY_MARKS, lines: 0 }
      set((state) => {
        const byFile: Record<string, FileDiffMarks> = {
          ...state.byFile,
          [key]: {
            key,
            signature,
            marks: parsed.marks,
            lines: parsed.lines,
            at: Date.now(),
          },
        }
        const keys = Object.keys(byFile)
        if (keys.length > MAX_FILES) {
          keys.sort((a, b) => byFile[a].at - byFile[b].at)
          for (const old of keys.slice(0, keys.length - MAX_FILES)) delete byFile[old]
        }
        return { byFile }
      })
    })().finally(() => {
      if (pending.get(key) === signature) {
        pending.delete(key)
        inflight.delete(key)
      }
    })

    pending.set(key, signature)
    inflight.set(key, task)
    await task
  },

  clear: (root) => {
    set((state) => {
      const byFile = { ...state.byFile }
      const prefix = root ? `${root}\u0000` : null
      const keys = new Set([...Object.keys(byFile), ...pending.keys()])
      for (const key of keys) {
        if (prefix && !key.startsWith(prefix)) continue
        delete byFile[key]
        generations.set(key, (generations.get(key) ?? 0) + 1)
      }
      return { byFile }
    })
  },
}))

/** Latest marks for a file, used synchronously right after an EditorState swap. */
export function diffMarksFor(root: string, rel: string): DiffMark[] {
  return useDiffMarks.getState().byFile[diffMarksKey(root, rel)]?.marks ?? EMPTY_MARKS
}

/**
 * Loads and subscribes to one file's diff marks. The same signature is shared with DiffRuler:
 * both callers mount on the same file, and the store dedupes the in-flight git call.
 */
export function useFileDiffMarks(
  root: string,
  rel: string,
  enabled: boolean,
  dirty: boolean,
  mtime: number,
  epoch: number,
): FileDiffMarks | null {
  const key = root && rel ? diffMarksKey(root, rel) : ''
  const entry = useDiffMarks((state) => (key ? state.byFile[key] : undefined))
  const signature = `${mtime}|${dirty ? 1 : 0}|${epoch}`

  useEffect(() => {
    if (!enabled || !root || !rel) return
    void useDiffMarks.getState().load(root, rel, signature)
  }, [enabled, root, rel, signature])

  return entry && entry.signature === signature ? entry : null
}
