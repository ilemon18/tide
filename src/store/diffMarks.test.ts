// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'

const { api } = vi.hoisted(() => ({
  api: { gitDiffFull: vi.fn() },
}))

vi.mock('../lib/ipc', () => ({ api }))

import { useDiffMarks } from './diffMarks'

function patchFor(firstAddedLine: number, count = 1): string {
  return [`@@ -0,0 +${firstAddedLine},${count} @@`, ...Array.from({ length: count }, (_, i) => `+line ${i}`)].join('\n')
}

beforeEach(() => {
  vi.clearAllMocks()
  useDiffMarks.getState().clear()
})

it('dedupes concurrent loads for the same signature', async () => {
  let resolve!: (value: { patch: string; binary: boolean; truncated: boolean }) => void
  api.gitDiffFull.mockReturnValue(new Promise((done) => { resolve = done }))

  const first = useDiffMarks.getState().load('/repo', 'a.ts', '1|0|0')
  const second = useDiffMarks.getState().load('/repo', 'a.ts', '1|0|0')
  expect(api.gitDiffFull).toHaveBeenCalledTimes(1)

  resolve({ patch: patchFor(2), binary: false, truncated: false })
  await Promise.all([first, second])
  expect(useDiffMarks.getState().byFile['/repo\u0000a.ts'].marks).toEqual([
    { from: 2, to: 2, kind: 'add' },
  ])
})

it('does not refetch an unchanged signature', async () => {
  api.gitDiffFull.mockResolvedValue({ patch: patchFor(1), binary: false, truncated: false })
  await useDiffMarks.getState().load('/repo', 'a.ts', '1|0|0')
  await useDiffMarks.getState().load('/repo', 'a.ts', '1|0|0')
  expect(api.gitDiffFull).toHaveBeenCalledTimes(1)
})

it('ignores a stale response that lost the signature race', async () => {
  let resolveFirst!: (value: { patch: string; binary: boolean; truncated: boolean }) => void
  let resolveSecond!: (value: { patch: string; binary: boolean; truncated: boolean }) => void
  api.gitDiffFull
    .mockReturnValueOnce(new Promise((done) => { resolveFirst = done }))
    .mockReturnValueOnce(new Promise((done) => { resolveSecond = done }))

  const first = useDiffMarks.getState().load('/repo', 'a.ts', '1|0|0')
  const second = useDiffMarks.getState().load('/repo', 'a.ts', '2|0|0')

  resolveFirst({ patch: patchFor(1), binary: false, truncated: false })
  await first
  expect(useDiffMarks.getState().byFile['/repo\u0000a.ts']).toBeUndefined()

  resolveSecond({ patch: patchFor(3), binary: false, truncated: false })
  await second
  expect(useDiffMarks.getState().byFile['/repo\u0000a.ts'].marks).toEqual([
    { from: 3, to: 3, kind: 'add' },
  ])
})

it('falls back to the staged patch when the worktree patch is empty', async () => {
  api.gitDiffFull
    .mockResolvedValueOnce({ patch: '', binary: false, truncated: false })
    .mockResolvedValueOnce({ patch: patchFor(4), binary: false, truncated: false })

  await useDiffMarks.getState().load('/repo', 'a.ts', '3|0|0')
  expect(api.gitDiffFull).toHaveBeenLastCalledWith('/repo', 'a.ts', true)
  expect(useDiffMarks.getState().byFile['/repo\u0000a.ts'].marks).toEqual([
    { from: 4, to: 4, kind: 'add' },
  ])
})

it('keeps the cache bounded', async () => {
  api.gitDiffFull.mockResolvedValue({ patch: patchFor(1), binary: false, truncated: false })
  for (let i = 0; i < 85; i += 1) {
    await useDiffMarks.getState().load('/repo', `f${i}.ts`, '1|0|0')
  }
  expect(Object.keys(useDiffMarks.getState().byFile).length).toBeLessThanOrEqual(80)
})
