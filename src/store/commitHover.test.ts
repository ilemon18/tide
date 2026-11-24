import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommitDetail } from '../lib/ipc'
import { budget, setMemoryProfile } from '../lib/memoryBudget'

const { gitCommitDetail } = vi.hoisted(() => ({ gitCommitDetail: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { gitCommitDetail }, errorText: (error: Error) => error.message }))
import {
  clearCommitDetails, loadCommitDetail, scheduleCommitPrefetch, useCommitHover,
  type CommitHoverTarget,
} from './commitHover'

const target: CommitHoverTarget = {
  root: '/repo', rel: 'a.ts', sha: 'abc1234', line: 2, origLine: 4,
  author: 'Author', authorTime: 1, summary: 'Change', lineStart: 2, lineCount: 1,
  rect: { left: 20, top: 200, right: 80, bottom: 220 },
}
const detail: CommitDetail = {
  sha: target.sha, shortSha: target.sha, author: 'Author', email: '', authorTime: 1,
  commitTime: 1, subject: 'Change', body: '', files: [], additions: 1, deletions: 0,
  fileDiff: '+const value = 1', merge: false,
}
function deferred() {
  let resolve!: (value: CommitDetail) => void
  let reject!: (error: Error) => void
  const promise = new Promise<CommitDetail>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearCommitDetails()
  setMemoryProfile('normal')
  gitCommitDetail.mockReset().mockResolvedValue(detail)
})
afterEach(async () => {
  clearCommitDetails()
  await vi.advanceTimersByTimeAsync(0)
  setMemoryProfile('normal')
  vi.useRealTimers()
})

it('shares a running prefetch with hover and synchronously presents cached results', async () => {
  const pending = deferred()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  scheduleCommitPrefetch(target)
  await vi.advanceTimersByTimeAsync(150)
  useCommitHover.getState().show(target)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  expect(gitCommitDetail).toHaveBeenCalledWith('/repo', 'abc1234', 'a.ts', 2, 4)
  expect(useCommitHover.getState().content).toBeNull()
  pending.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  useCommitHover.getState().hide()
  useCommitHover.getState().show(target)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
})

it('ignores late results from a previous line and cancels pending hover immediately on leave', async () => {
  const first = deferred()
  const second = deferred()
  const next = { ...target, line: 3, origLine: 5 }
  gitCommitDetail.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  useCommitHover.getState().show(target)
  useCommitHover.getState().show(next)
  const nextDetail = { ...detail, fileDiff: '+next' }
  second.resolve(nextDetail)
  await vi.advanceTimersByTimeAsync(0)
  first.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState()).toMatchObject({ target: next, content: { detail: nextDetail } })

  const leaving = deferred()
  gitCommitDetail.mockReturnValueOnce(leaving.promise)
  useCommitHover.getState().show({ ...target, line: 9 })
  useCommitHover.getState().hideSoon()
  expect(useCommitHover.getState().target).toBeNull()
  leaving.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content).toBeNull()
})

it('preserves the visible card while crossing the gap and closes it after the leave grace period', async () => {
  await loadCommitDetail(target)
  useCommitHover.getState().show(target)
  useCommitHover.getState().hideSoon()
  await vi.advanceTimersByTimeAsync(199)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  useCommitHover.getState().cancelHide()
  await vi.advanceTimersByTimeAsync(200)
  expect(useCommitHover.getState().target).toEqual(target)
  useCommitHover.getState().hideSoon()
  await vi.advanceTimersByTimeAsync(200)
  expect(useCommitHover.getState().target).toBeNull()
})

it('isolates roots and retries a failed request on the next hover', async () => {
  await loadCommitDetail(target)
  gitCommitDetail.mockRejectedValueOnce(new Error('unreadable'))
  const otherRoot = { ...target, root: '/other' }
  useCommitHover.getState().show(otherRoot)
  expect(useCommitHover.getState().content).toBeNull()
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content).toEqual({ detail: null, error: 'unreadable' })
  useCommitHover.getState().show(otherRoot)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  expect(gitCommitDetail).toHaveBeenCalledTimes(3)
})

it('debounces to the latest line, serializes background reads and prioritizes foreground hover', async () => {
  const first = deferred()
  gitCommitDetail.mockReturnValueOnce(first.promise)
  const cancelOld = scheduleCommitPrefetch({ ...target, line: 1 })
  scheduleCommitPrefetch(target)
  cancelOld()
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  scheduleCommitPrefetch({ ...target, line: 3 })
  await vi.advanceTimersByTimeAsync(150)
  scheduleCommitPrefetch({ ...target, line: 4 })
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  useCommitHover.getState().show({ ...target, line: 5 })
  expect(gitCommitDetail).toHaveBeenCalledTimes(2)
  expect(gitCommitDetail.mock.calls[1][3]).toBe(5)
  first.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(gitCommitDetail.mock.calls.map((call) => call[3])).toEqual([2, 5, 4])
})

it('cancels queued work and never repopulates reclaimed caches with late answers', async () => {
  const old = deferred()
  const fresh = deferred()
  gitCommitDetail.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  scheduleCommitPrefetch(target)
  await vi.advanceTimersByTimeAsync(150)
  useCommitHover.getState().show(target)
  scheduleCommitPrefetch({ ...target, line: 3 })
  clearCommitDetails()
  const freshRequest = loadCommitDetail(target)
  old.resolve(detail)
  await vi.advanceTimersByTimeAsync(150)
  expect(useCommitHover.getState().target).toBeNull()
  expect(loadCommitDetail(target)).toBe(freshRequest)
  expect(gitCommitDetail).toHaveBeenCalledTimes(2)
  fresh.resolve({ ...detail, fileDiff: '+fresh' })
  await freshRequest
  useCommitHover.getState().show(target)
  expect(useCommitHover.getState().content?.detail?.fileDiff).toBe('+fresh')
})

it('contains speculative errors and skips background reads in lightweight mode', async () => {
  gitCommitDetail.mockRejectedValueOnce(new Error('unreadable'))
  scheduleCommitPrefetch(target)
  await vi.advanceTimersByTimeAsync(150)
  expect(useCommitHover.getState().target).toBeNull()
  useCommitHover.getState().show(target)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  setMemoryProfile('light')
  scheduleCommitPrefetch({ ...target, line: 3 })
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).toHaveBeenCalledTimes(2)
})

it('evicts completed details using the existing LRU budget', async () => {
  await loadCommitDetail(target)
  const second = { ...target, line: 3 }
  await loadCommitDetail(second)
  for (let i = 0; i < budget.commitDetails() - 2; i += 1) {
    await loadCommitDetail({ ...target, line: 10 + i })
  }
  await loadCommitDetail(target)
  await loadCommitDetail({ ...target, line: 100 })
  const calls = gitCommitDetail.mock.calls.length
  await loadCommitDetail(target)
  expect(gitCommitDetail).toHaveBeenCalledTimes(calls)
  await loadCommitDetail(second)
  expect(gitCommitDetail).toHaveBeenCalledTimes(calls + 1)
})
