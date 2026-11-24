import { create } from 'zustand'
import { api, errorText, type CommitDetail } from '../lib/ipc'
import { budget, feature } from '../lib/memoryBudget'

export type CommitDetailQuery = {
  root: string
  rel: string
  sha: string
  line: number
  origLine: number
}

export function commitDetailKey(query: CommitDetailQuery): string {
  return JSON.stringify([query.root, query.sha, query.rel, query.origLine, query.line])
}

/** Completed results and in-flight requests are shared by prefetch and hover. */
const detailCache = new Map<string, CommitDetail>()
const inFlight = new Map<string, Promise<CommitDetail>>()
let generation = 0

function readCommitDetail(key: string): CommitDetail | undefined {
  const hit = detailCache.get(key)
  if (hit) {
    // A hit refreshes LRU order
    detailCache.delete(key)
    detailCache.set(key, hit)
  }
  return hit
}

function writeCommitDetail(key: string, detail: CommitDetail) {
  detailCache.delete(key)
  detailCache.set(key, detail)
  while (detailCache.size > budget.commitDetails()) {
    const oldest = detailCache.keys().next().value
    if (oldest === undefined) break
    detailCache.delete(oldest)
  }
}

export function loadCommitDetail(query: CommitDetailQuery): Promise<CommitDetail> {
  const key = commitDetailKey(query)
  const cached = readCommitDetail(key)
  if (cached) return Promise.resolve(cached)
  const pending = inFlight.get(key)
  if (pending) return pending

  const epoch = generation
  const request = api.gitCommitDetail(query.root, query.sha, query.rel, query.line, query.origLine || null)
    .then((detail) => {
      if (generation === epoch) writeCommitDetail(key, detail)
      return detail
    })
    .finally(() => {
      // An old request must not remove a newer request after memory reclamation.
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
  inFlight.set(key, request)
  return request
}

const PREFETCH_DELAY = 150
type Prefetch = { query: CommitDetailQuery; ready: boolean; timer: ReturnType<typeof setTimeout> }
let queuedPrefetch: Prefetch | null = null
let prefetchRunning = false

function pumpPrefetch() {
  if (prefetchRunning || !queuedPrefetch?.ready) return
  const { query } = queuedPrefetch
  queuedPrefetch = null
  if (!feature.inlineBlame()) return
  prefetchRunning = true
  void loadCommitDetail(query)
    .catch(() => { /* A speculative failure is retried on hover. */ })
    .finally(() => {
      prefetchRunning = false
      pumpPrefetch()
    })
}

/** Keep only the latest waiting cursor line; foreground hovers bypass this background queue. */
export function scheduleCommitPrefetch(query: CommitDetailQuery): () => void {
  if (queuedPrefetch) clearTimeout(queuedPrefetch.timer)
  queuedPrefetch = null
  if (!feature.inlineBlame() || readCommitDetail(commitDetailKey(query))) return () => {}
  const job: Prefetch = {
    query,
    ready: false,
    timer: setTimeout(() => {
      job.ready = true
      pumpPrefetch()
    }, PREFETCH_DELAY),
  }
  queuedPrefetch = job
  return () => {
    // A destroyed pane cannot cancel a newer cursor target from another pane.
    if (queuedPrefetch !== job) return
    clearTimeout(job.timer)
    queuedPrefetch = null
  }
}

/** Release eagerly on window hide / long blur, including pending presentation and prefetch. */
export function clearCommitDetails() {
  generation += 1
  detailCache.clear()
  inFlight.clear()
  if (queuedPrefetch) clearTimeout(queuedPrefetch.timer)
  queuedPrefetch = null
  useCommitHover.getState().hide()
}

export type CommitHoverRect = {
  left: number
  top: number
  right: number
  bottom: number
}

export type CommitHoverTarget = CommitDetailQuery & {
  author: string
  authorTime: number
  summary: string
  lineStart: number
  lineCount: number
  /** Viewport rect of the blame text, used to anchor the card */
  rect: CommitHoverRect
}

type CommitHoverContent = { detail: CommitDetail | null; error: string | null }
type CommitHoverStore = {
  /** Hover intent remains available while the card waits for complete content. */
  target: CommitHoverTarget | null
  content: CommitHoverContent | null
  show: (target: CommitHoverTarget) => void
  hide: () => void
  hideSoon: () => void
  cancelHide: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
let hoverSequence = 0

function clearTimer() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
}

export const useCommitHover = create<CommitHoverStore>((set, get) => ({
  target: null,
  content: null,

  show: (target) => {
    clearTimer()
    const sequence = ++hoverSequence
    const cached = readCommitDetail(commitDetailKey(target))
    if (cached) {
      set({ target, content: { detail: cached, error: null } })
      return
    }
    set({ target, content: null })
    void loadCommitDetail(target).then(
      (detail) => {
        if (hoverSequence === sequence) set({ content: { detail, error: null } })
      },
      (error) => {
        if (hoverSequence === sequence) set({ content: { detail: null, error: errorText(error) } })
      },
    )
  },

  hide: () => {
    clearTimer()
    hoverSequence += 1
    set({ target: null, content: null })
  },

  hideSoon: () => {
    clearTimer()
    if (!get().content) {
      get().hide()
      return
    }
    timer = setTimeout(() => get().hide(), 200)
  },

  cancelHide: clearTimer,
}))
