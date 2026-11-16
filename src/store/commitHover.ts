import { create } from 'zustand'
import type { CommitDetail } from '../lib/ipc'
import { budget } from '../lib/memoryBudget'

/** Hover card detail cache: one lookup per commit + file + line. Entries carry diff hunks, so LRU-capped. */
const detailCache = new Map<string, CommitDetail>()

export function readCommitDetail(key: string): CommitDetail | undefined {
  const hit = detailCache.get(key)
  if (hit) {
    // A hit refreshes LRU order
    detailCache.delete(key)
    detailCache.set(key, hit)
  }
  return hit
}

export function writeCommitDetail(key: string, detail: CommitDetail) {
  detailCache.delete(key)
  detailCache.set(key, detail)
  while (detailCache.size > budget.commitDetails()) {
    const oldest = detailCache.keys().next().value
    if (oldest === undefined) break
    detailCache.delete(oldest)
  }
}

/** Release eagerly (on window hide / long blur) */
export function clearCommitDetails() {
  detailCache.clear()
}

export type CommitHoverRect = {
  left: number
  top: number
  right: number
  bottom: number
}

export type CommitHoverTarget = {
  root: string
  rel: string
  sha: string
  /** blame already has author / time: first paint uses them, no need to wait for git detail */
  author: string
  authorTime: number
  summary: string
  lineStart: number
  lineCount: number
  /** Real line number the hover targets (cursor line) */
  line: number
  /** Line number inside the introducing commit, used to locate the diff hunk */
  origLine: number
  /** Viewport rect of the blame text, used to anchor the card */
  rect: CommitHoverRect
}

type CommitHoverStore = {
  target: CommitHoverTarget | null
  show: (target: CommitHoverTarget) => void
  hide: () => void
  hideSoon: () => void
  cancelHide: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

export const useCommitHover = create<CommitHoverStore>((set, get) => ({
  target: null,

  show: (target) => {
    clearTimer()
    const current = get().target
    // Same commit and same lines: only update position, avoid flickering card rebuild
    if (current && current.sha === target.sha && current.rel === target.rel) {
      set({ target })
      return
    }
    set({ target })
  },

  hide: () => {
    clearTimer()
    set({ target: null })
  },

  hideSoon: () => {
    clearTimer()
    timer = setTimeout(() => {
      timer = null
      set({ target: null })
    }, 200)
  },

  cancelHide: () => {
    clearTimer()
  },
}))