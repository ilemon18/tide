import { create } from 'zustand'
import {
  api,
  errorText,
  type CommitDetail,
  type CommitFileDiff,
} from '../lib/ipc'
import { budget, feature } from '../lib/memoryBudget'

export type CommitHoverRect = {
  left: number
  top: number
  right: number
  bottom: number
}

export type CommitHoverTarget = {
  root: string
  /** Current file, used for display and the working-tree diff */
  rel: string
  /** Path inside the introducing commit (blame origPath), used for committed diffs */
  path: string
  sha: string
  /** Cursor line in the current file */
  line: number
  /** Cursor line inside the introducing commit */
  origLine: number
  author: string
  authorEmail: string
  authorTime: number
  summary: string
  /** Used to render the author as `You` */
  currentUserEmail: string
  lineStart: number
  lineCount: number
  uncommitted: boolean
  /** Viewport rect of the blame text, used to anchor the card */
  rect: CommitHoverRect
}

export function commitDetailKey(root: string, sha: string): string {
  return `${root}|${sha}`
}

export function commitDiffKey(root: string, sha: string, path: string): string {
  return `${root}|${sha}|${path}`
}

function workDiffKey(root: string, rel: string, stamp: number): string {
  // The uncommitted blame timestamp changes with every buffer blame run, so an old working-tree
  // diff cannot masquerade as the current one.
  return `${root}|${rel}|${stamp}`
}

/** Dedupe key for prefetching the content a hover target needs. */
export function commitHoverKey(target: CommitHoverTarget): string {
  return target.uncommitted
    ? `work|${workDiffKey(target.root, target.rel, target.authorTime)}`
    : commitDiffKey(target.root, target.sha, target.path)
}

/** Completed results and in-flight requests are shared by prefetch and hover. */
const detailCache = new Map<string, CommitDetail>()
const detailInFlight = new Map<string, Promise<CommitDetail>>()
const diffCache = new Map<string, CommitFileDiff>()
const diffInFlight = new Map<string, Promise<CommitFileDiff>>()
/** Working-tree diffs stay separate from commit caches; null records an unborn-branch result. */
const workCache = new Map<string, CommitFileDiff | null>()
const workInFlight = new Map<string, Promise<CommitFileDiff | null>>()
let generation = 0

function touch<K, V>(cache: Map<K, V>, key: K, value: V, limit: number) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > limit) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

function readDetail(key: string): CommitDetail | undefined {
  const hit = detailCache.get(key)
  if (hit) {
    detailCache.delete(key)
    detailCache.set(key, hit)
  }
  return hit
}

function readDiff(key: string): CommitFileDiff | undefined {
  const hit = diffCache.get(key)
  if (hit) {
    diffCache.delete(key)
    diffCache.set(key, hit)
  }
  return hit
}

function readWork(key: string): CommitFileDiff | null | undefined {
  if (!workCache.has(key)) return undefined
  const hit = workCache.get(key) ?? null
  workCache.delete(key)
  workCache.set(key, hit)
  return hit
}

export function loadCommitDetail(root: string, sha: string): Promise<CommitDetail> {
  const key = commitDetailKey(root, sha)
  const cached = readDetail(key)
  if (cached) return Promise.resolve(cached)
  const pending = detailInFlight.get(key)
  if (pending) return pending

  const epoch = generation
  const request = api.gitCommitDetail(root, sha)
    .then((detail) => {
      if (generation === epoch) touch(detailCache, key, detail, budget.commitDetails())
      return detail
    })
    .finally(() => {
      // An old request must not remove a newer request after memory reclamation.
      if (detailInFlight.get(key) === request) detailInFlight.delete(key)
    })
  detailInFlight.set(key, request)
  return request
}

/** One full file diff per commit+commit-path, reused when the cursor moves to another line. */
export function loadCommitDiff(
  root: string,
  sha: string,
  path: string,
): Promise<CommitFileDiff> {
  const key = commitDiffKey(root, sha, path)
  const cached = readDiff(key)
  if (cached) return Promise.resolve(cached)
  const pending = diffInFlight.get(key)
  if (pending) return pending

  const epoch = generation
  const request = api
    // No target line: cache every hunk, then the card selects the exact one client-side.
    .gitCommitFileDiff(root, sha, path, null)
    .then((diff) => {
      if (generation === epoch) touch(diffCache, key, diff, budget.commitDetails())
      return diff
    })
    .finally(() => {
      if (diffInFlight.get(key) === request) diffInFlight.delete(key)
    })
  diffInFlight.set(key, request)
  return request
}

/** Working-tree diff for uncommitted rows; null means the repository has no HEAD yet. */
export function loadWorkingDiff(
  root: string,
  rel: string,
  stamp: number,
): Promise<CommitFileDiff | null> {
  const key = workDiffKey(root, rel, stamp)
  const cached = readWork(key)
  if (cached !== undefined) return Promise.resolve(cached)
  const pending = workInFlight.get(key)
  if (pending) return pending

  const epoch = generation
  const request = api
    .gitWorkingTreeDiff(root, rel)
    .then((diff) => {
      if (generation === epoch) {
        touch(workCache, key, diff, Math.max(2, Math.floor(budget.commitDetails() / 2)))
      }
      return diff
    })
    .finally(() => {
      if (workInFlight.get(key) === request) workInFlight.delete(key)
    })
  workInFlight.set(key, request)
  return request
}

function hasCommitContent(target: CommitHoverTarget): boolean {
  if (target.uncommitted) {
    return readWork(workDiffKey(target.root, target.rel, target.authorTime)) !== undefined
  }
  return Boolean(
    readDetail(commitDetailKey(target.root, target.sha)) &&
      readDiff(commitDiffKey(target.root, target.sha, target.path)),
  )
}

const PREFETCH_DELAY = 150
type Prefetch = { target: CommitHoverTarget; ready: boolean; timer: ReturnType<typeof setTimeout> }
let queuedPrefetch: Prefetch | null = null
let prefetchRunning = false

/** Detail first, then the file diff: one serial chain keeps background git work predictable. */
async function prefetch(target: CommitHoverTarget): Promise<void> {
  if (target.uncommitted) {
    await loadWorkingDiff(target.root, target.rel, target.authorTime)
    return
  }
  await loadCommitDetail(target.root, target.sha)
  await loadCommitDiff(target.root, target.sha, target.path)
}

function pumpPrefetch() {
  if (prefetchRunning || !queuedPrefetch?.ready) return
  const { target } = queuedPrefetch
  queuedPrefetch = null
  if (!feature.inlineBlame() || hasCommitContent(target)) return
  prefetchRunning = true
  void prefetch(target)
    .catch(() => {
      /* A speculative failure is retried on hover. */
    })
    .finally(() => {
      prefetchRunning = false
      pumpPrefetch()
    })
}

/** Keep only the latest waiting cursor line; foreground hovers bypass this background queue. */
export function scheduleCommitPrefetch(target: CommitHoverTarget): () => void {
  if (queuedPrefetch) clearTimeout(queuedPrefetch.timer)
  queuedPrefetch = null
  if (!feature.inlineBlame() || hasCommitContent(target)) return () => {}
  const job: Prefetch = {
    target,
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
  detailInFlight.clear()
  diffCache.clear()
  diffInFlight.clear()
  workCache.clear()
  workInFlight.clear()
  if (queuedPrefetch) clearTimeout(queuedPrefetch.timer)
  queuedPrefetch = null
  useCommitHover.getState().hide()
}

export type CommitHoverContent = {
  detail: CommitDetail | null
  /** Committed file diff (all hunks; the card selects by line) */
  diff: CommitFileDiff | null
  /** Working-tree diff; null with `workLoaded` set means the repo has no HEAD */
  work: CommitFileDiff | null
  workLoaded: boolean
  error: string | null
  loadingDiff: boolean
}

const EMPTY_CONTENT: CommitHoverContent = {
  detail: null,
  diff: null,
  work: null,
  workLoaded: false,
  error: null,
  loadingDiff: false,
}

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

    if (target.uncommitted) {
      const cached = readWork(workDiffKey(target.root, target.rel, target.authorTime))
      if (cached !== undefined) {
        set({
          target,
          content: { ...EMPTY_CONTENT, work: cached, workLoaded: true },
        })
        return
      }
      set({ target, content: { ...EMPTY_CONTENT, loadingDiff: true } })
      void loadWorkingDiff(target.root, target.rel, target.authorTime).then(
        (diff) => {
          if (hoverSequence === sequence) {
            set({ content: { ...EMPTY_CONTENT, work: diff, workLoaded: true } })
          }
        },
        (error) => {
          if (hoverSequence === sequence) {
            set({ content: { ...EMPTY_CONTENT, error: errorText(error) } })
          }
        },
      )
      return
    }

    const detailKey = commitDetailKey(target.root, target.sha)
    const diffKey = commitDiffKey(target.root, target.sha, target.path)
    const detail = readDetail(detailKey)
    const diff = readDiff(diffKey)
    if (detail && diff) {
      set({ target, content: { ...EMPTY_CONTENT, detail, diff } })
      return
    }

    // Detail cached but the file diff is still loading: show the card at once and fill the hunk.
    if (detail) {
      set({ target, content: { ...EMPTY_CONTENT, detail, loadingDiff: true } })
    } else {
      set({ target, content: null })
    }

    const diffRequest = loadCommitDiff(target.root, target.sha, target.path).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    const detailRequest = detail
      ? Promise.resolve(detail)
      : loadCommitDetail(target.root, target.sha)

    detailRequest.then(
      (complete) => {
        diffRequest.then((outcome) => {
          if (hoverSequence !== sequence) return
          set({
            content: {
              ...EMPTY_CONTENT,
              detail: complete,
              diff: outcome.ok ? outcome.value : null,
              error: outcome.ok ? null : errorText(outcome.error),
            },
          })
        })
      },
      (error) => {
        if (hoverSequence === sequence) {
          set({ content: { ...EMPTY_CONTENT, error: errorText(error) } })
        }
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
