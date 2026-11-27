import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BlameResult } from '../lib/ipc'
import type { Tab } from './tabs'

const { gitBlame } = vi.hoisted(() => ({ gitBlame: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { gitBlame } }))
vi.mock('./settings', () => ({
  useSettings: { getState: () => ({ inlineBlame: true }) },
}))
import { blameRangeAt, useBlame } from './blame'

function result(overrides: Partial<BlameResult> = {}): BlameResult {
  return {
    disabled: false,
    reason: null,
    lineCount: 3,
    ranges: [
      {
        startLine: 1,
        lineCount: 2,
        origLine: 10,
        origPath: 'a.ts',
        sha: 'a'.repeat(40),
        author: 'Author',
        authorEmail: 'author@example.com',
        authorTime: 1,
        summary: 'Change',
        uncommitted: false,
        previousSha: null,
        previousPath: null,
      },
      {
        startLine: 3,
        lineCount: 1,
        origLine: 20,
        origPath: 'a.ts',
        sha: 'b'.repeat(40),
        author: 'Author',
        authorEmail: 'author@example.com',
        authorTime: 2,
        summary: 'Other',
        uncommitted: false,
        previousSha: null,
        previousPath: null,
      },
    ],
    root: '/repo',
    rel: 'a.ts',
    currentUserName: 'Tester',
    currentUserEmail: 'me@example.com',
    version: 0,
    ...overrides,
  }
}

const tab: Tab = {
  id: 'tab-1',
  root: '/repo',
  rel: 'a.ts',
  name: 'a.ts',
  kind: 'file',
  dirty: false,
  readOnly: false,
  tier: 'full',
  pinned: false,
  temporary: false,
  mtime: 10,
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
  useBlame.getState().clear()
  gitBlame.mockReset().mockResolvedValue(result())
})
afterEach(async () => {
  useBlame.getState().clear()
  await vi.advanceTimersByTimeAsync(0)
  vi.useRealTimers()
})

it('caches disk blame by root, rel and mtime', async () => {
  const first = await useBlame.getState().fetchNow(tab)
  const second = await useBlame.getState().fetchNow(tab)
  expect(first).toEqual(second)
  expect(gitBlame).toHaveBeenCalledTimes(1)
  expect(useBlame.getState().byTab[tab.id]).toEqual(first)
  expect(useBlame.getState().source[tab.id]).toBe('disk')

  // A new mtime is a new file version and must not reuse the old rows.
  await useBlame.getState().fetchNow({ ...tab, mtime: 11 })
  expect(gitBlame).toHaveBeenCalledTimes(2)
})

it('keeps editor-buffer blame out of the disk LRU', async () => {
  await useBlame.getState().fetchForBuffer(tab, 'buffer', 1)
  expect(useBlame.getState().source[tab.id]).toBe('buffer')
  await useBlame.getState().fetchNow(tab)
  expect(useBlame.getState().source[tab.id]).toBe('disk')
  // The buffer result was never cached, so only the disk read can satisfy this key.
  await useBlame.getState().fetchNow(tab)
  expect(gitBlame).toHaveBeenCalledTimes(2)
})

it('coalesces scheduled fetches and drops the timer on invalidate', async () => {
  useBlame.getState().scheduleFetch(tab)
  useBlame.getState().scheduleFetch(tab)
  await vi.advanceTimersByTimeAsync(199)
  expect(gitBlame).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(gitBlame).toHaveBeenCalledTimes(1)

  useBlame.getState().scheduleFetch({ ...tab, mtime: 20 })
  useBlame.getState().invalidate(tab.id)
  await vi.advanceTimersByTimeAsync(250)
  expect(gitBlame).toHaveBeenCalledTimes(1)
})

it('does not schedule disk blame for a dirty tab', async () => {
  useBlame.getState().scheduleFetch({ ...tab, dirty: true })
  await vi.advanceTimersByTimeAsync(300)
  expect(gitBlame).not.toHaveBeenCalled()
})

it('drops a stale buffer response so the newest edit wins', async () => {
  const first = deferred<BlameResult>()
  const second = deferred<BlameResult>()
  gitBlame.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const older = result({ version: 1, lineCount: 1 })
  const newer = result({ version: 2, lineCount: 1, ranges: [result().ranges[1]] })
  void useBlame.getState().fetchForBuffer(tab, 'one', 1)
  void useBlame.getState().fetchForBuffer(tab, 'two', 2)
  second.resolve(newer)
  await vi.advanceTimersByTimeAsync(0)
  expect(useBlame.getState().byTab[tab.id]).toEqual(newer)
  first.resolve(older)
  await vi.advanceTimersByTimeAsync(0)
  expect(useBlame.getState().byTab[tab.id]).toEqual(newer)
  expect(useBlame.getState().source[tab.id]).toBe('buffer')
})

it('attaches a disabled result instead of leaving the editor waiting', async () => {
  gitBlame.mockRejectedValueOnce(new Error('nope'))
  const value = await useBlame.getState().fetchForBuffer(tab, 'buffer', 3)
  expect(value?.disabled).toBe(true)
  expect(useBlame.getState().byTab[tab.id]?.disabled).toBe(true)
})

it('finds ranges with a binary search', () => {
  const data = result()
  expect(blameRangeAt(data, 1)?.startLine).toBe(1)
  expect(blameRangeAt(data, 2)?.startLine).toBe(1)
  expect(blameRangeAt(data, 3)?.startLine).toBe(3)
  expect(blameRangeAt(data, 4)).toBeNull()
  expect(blameRangeAt(null, 1)).toBeNull()
})
