import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CommitDetail, CommitFileDiff } from '../lib/ipc'
import { setMemoryProfile } from '../lib/memoryBudget'

const { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff } = vi.hoisted(() => ({
  gitCommitDetail: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitWorkingTreeDiff: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  api: { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff },
  errorText: (error: Error) => error.message,
}))
import {
  clearCommitDetails,
  loadCommitDetail,
  loadCommitDiff,
  scheduleCommitPrefetch,
  useCommitHover,
  type CommitHoverTarget,
} from './commitHover'

const target: CommitHoverTarget = {
  root: '/repo',
  rel: 'a.ts',
  path: 'old/a.ts',
  sha: 'abc1234',
  line: 2,
  origLine: 4,
  author: 'Author',
  authorEmail: 'author@example.com',
  authorTime: 1,
  summary: 'Change',
  currentUserEmail: 'me@example.com',
  lineStart: 2,
  lineCount: 1,
  uncommitted: false,
  rect: { left: 20, top: 200, right: 80, bottom: 220 },
}

const detail: CommitDetail = {
  sha: target.sha,
  shortSha: target.sha,
  author: 'Author',
  email: 'author@example.com',
  authorTime: 1,
  commitTime: 1,
  subject: 'Change',
  body: '',
  files: [],
  additions: 1,
  deletions: 0,
  merge: false,
}

const diff: CommitFileDiff = {
  path: 'old/a.ts',
  renamedFrom: null,
  additions: 1,
  deletions: 0,
  hunks: [
    {
      oldStart: 4,
      oldCount: 1,
      newStart: 4,
      newCount: 1,
      header: '@@ -4 +4 @@',
      lines: [{ kind: 'add', oldLine: null, newLine: 4, text: 'const value = 1' }],
    },
  ],
  truncated: false,
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.useFakeTimers()
  clearCommitDetails()
  setMemoryProfile('normal')
  gitCommitDetail.mockReset().mockResolvedValue(detail)
  gitCommitFileDiff.mockReset().mockResolvedValue(diff)
  gitWorkingTreeDiff.mockReset().mockResolvedValue(diff)
})
afterEach(async () => {
  clearCommitDetails()
  await vi.advanceTimersByTimeAsync(0)
  setMemoryProfile('normal')
  vi.useRealTimers()
})

it('shares a running prefetch with hover and presents cached content synchronously', async () => {
  const pending = deferred<CommitDetail>()
  gitCommitDetail.mockReturnValueOnce(pending.promise)
  scheduleCommitPrefetch(target)
  await vi.advanceTimersByTimeAsync(150)
  useCommitHover.getState().show(target)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  expect(gitCommitDetail).toHaveBeenCalledWith('/repo', 'abc1234')
  expect(useCommitHover.getState().content).toBeNull()
  pending.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  expect(useCommitHover.getState().content?.diff).toEqual(diff)
  useCommitHover.getState().hide()
  useCommitHover.getState().show(target)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  expect(gitCommitFileDiff).toHaveBeenCalledTimes(1)
})

it('caches the detail by root and sha and the diff by root, sha and commit path', async () => {
  await loadCommitDetail(target.root, target.sha)
  await loadCommitDetail(target.root, target.sha)
  await loadCommitDetail('/other', target.sha)
  expect(gitCommitDetail).toHaveBeenCalledTimes(2)

  await loadCommitDiff(target.root, target.sha, target.path)
  await loadCommitDiff(target.root, target.sha, target.path)
  await loadCommitDiff(target.root, target.sha, 'other.ts')
  expect(gitCommitFileDiff).toHaveBeenCalledTimes(2)
  expect(gitCommitFileDiff).toHaveBeenNthCalledWith(1, '/repo', 'abc1234', 'old/a.ts', null)
})

it('reuses the file diff when the hover moves to another line of the same commit', async () => {
  useCommitHover.getState().show(target)
  await vi.advanceTimersByTimeAsync(0)
  useCommitHover.getState().hide()
  useCommitHover.getState().show({ ...target, line: 9, origLine: 11 })
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().target?.origLine).toBe(11)
  expect(gitCommitFileDiff).toHaveBeenCalledTimes(1)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
})

it('uses the working-tree diff for uncommitted rows without touching commit caches', async () => {
  const work = deferred<CommitFileDiff | null>()
  gitWorkingTreeDiff.mockReturnValueOnce(work.promise)
  useCommitHover.getState().show({ ...target, uncommitted: true, sha: '0'.repeat(40) })
  expect(useCommitHover.getState().content?.loadingDiff).toBe(true)
  work.resolve(diff)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.work).toEqual(diff)
  expect(gitWorkingTreeDiff).toHaveBeenCalledWith('/repo', 'a.ts')
  expect(gitCommitDetail).not.toHaveBeenCalled()
  expect(gitCommitFileDiff).not.toHaveBeenCalled()
})

it('represents an unborn HEAD as a loaded null working diff', async () => {
  gitWorkingTreeDiff.mockResolvedValueOnce(null)
  useCommitHover.getState().show({ ...target, uncommitted: true })
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content).toMatchObject({ work: null, workLoaded: true })
})

it('ignores late results from a previous line and cancels pending hover on leave', async () => {
  const first = deferred<CommitDetail>()
  gitCommitDetail.mockReturnValueOnce(first.promise)
  useCommitHover.getState().show(target)
  const next = { ...target, line: 3, origLine: 5 }
  useCommitHover.getState().show(next)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().target).toEqual(next)
  first.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  // Content belongs to the current target only.
  expect(useCommitHover.getState().content?.detail).toEqual(detail)

  useCommitHover.getState().hideSoon()
  await vi.advanceTimersByTimeAsync(200)
  expect(useCommitHover.getState().target).toBeNull()
})

it('preserves the visible card while crossing the gap and closes it after the leave grace period', async () => {
  await loadCommitDetail(target.root, target.sha)
  await loadCommitDiff(target.root, target.sha, target.path)
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

it('retries a failed detail request on the next hover', async () => {
  gitCommitDetail.mockRejectedValueOnce(new Error('unreadable'))
  useCommitHover.getState().show(target)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.error).toBe('unreadable')
  useCommitHover.getState().show(target)
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content?.detail).toEqual(detail)
})

it('debounces prefetch to the latest line and serializes background reads', async () => {
  const first = deferred<CommitDetail>()
  gitCommitDetail.mockReturnValueOnce(first.promise)
  const cancelOld = scheduleCommitPrefetch({ ...target, line: 1 })
  scheduleCommitPrefetch(target)
  cancelOld()
  await vi.advanceTimersByTimeAsync(149)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
  first.resolve(detail)
  await vi.advanceTimersByTimeAsync(0)
  expect(gitCommitFileDiff).toHaveBeenCalledTimes(1)
})
