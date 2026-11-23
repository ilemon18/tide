import { beforeEach, expect, it, vi } from 'vitest'
import type { DirEntryInfo } from './ipc'
const { readDir } = vi.hoisted(() => ({ readDir: vi.fn() }))
vi.mock('./ipc', () => ({ api: { readDir }, errorCode: (error: { code?: string }) => error.code ?? null }))
import { readDirectoryEntries, readWorkspaceEntry } from './workspaceEntries'

const entry = (name: string): DirEntryInfo => ({ name, path: `src/${name}`, isDir: true, isSymlink: false, ignored: false, size: 0, mtime: 0 })
beforeEach(() => readDir.mockReset())

it('reads all returned pages, including directories beyond the first page', async () => {
  readDir.mockResolvedValueOnce({ entries: [entry('a')], hasMore: true })
    .mockResolvedValueOnce({ entries: [entry('empty')], hasMore: false })
  expect((await readDirectoryEntries('/repo', 'src')).map(item => item.name)).toEqual(['a', 'empty'])
  expect(readDir).toHaveBeenNthCalledWith(2, '/repo', 'src', 1, 200)
})

it('finds a target on a later page without reading further pages', async () => {
  readDir.mockResolvedValueOnce({ entries: [entry('a')], hasMore: true })
    .mockResolvedValueOnce({ entries: [entry('empty')], hasMore: true })
  expect(await readWorkspaceEntry('/repo', 'src/empty/')).toEqual(entry('empty'))
  expect(readDir).toHaveBeenCalledTimes(2)
})

it('discards obsolete responses and stops pagination', async () => {
  let resolve!: (page: { entries: DirEntryInfo[]; hasMore: boolean }) => void
  readDir.mockReturnValue(new Promise(done => { resolve = done }))
  let current = true
  const pending = readDirectoryEntries('/repo', '', () => current)
  current = false
  resolve({ entries: [entry('old')], hasMore: true })
  expect(await pending).toEqual([])
  expect(readDir).toHaveBeenCalledTimes(1)
})

it('does not loop forever if an incomplete directory returns an empty page', async () => {
  readDir.mockResolvedValue({ entries: [], hasMore: true })
  expect(await readWorkspaceEntry('/repo', 'gone')).toBeUndefined()
  expect(readDir).toHaveBeenCalledTimes(1)
})

it('confirms absence when the parent was deleted, but preserves permission errors', async () => {
  readDir.mockRejectedValueOnce({ code: 'io.notFound' })
  expect(await readWorkspaceEntry('/repo', 'removed/file.ts')).toBeUndefined()
  const error = { code: 'io.permissionDenied' }
  readDir.mockRejectedValueOnce(error)
  await expect(readWorkspaceEntry('/repo', 'private/file.ts')).rejects.toEqual(error)
})
