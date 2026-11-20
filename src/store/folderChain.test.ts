import { beforeEach, expect, it, vi } from 'vitest'

const { resolveDirChain } = vi.hoisted(() => ({ resolveDirChain: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { resolveDirChain } }))
import { useFolderChain } from './folderChain'

function deferred() {
  let resolve!: (value: string) => void
  const promise = new Promise<string>((done) => { resolve = done })
  return { promise, resolve }
}

beforeEach(() => {
  useFolderChain.getState().reset()
  resolveDirChain.mockReset()
})

it('keeps the displayed chain during invalidation and reuses the snapshot for an unchanged result', async () => {
  resolveDirChain.mockResolvedValue('src/a/b')
  useFolderChain.getState().resolve('/repo', 'src', false)
  await Promise.resolve()
  const snapshot = useFolderChain.getState().chains
  const pending = deferred()
  resolveDirChain.mockReturnValue(pending.promise)
  useFolderChain.getState().invalidate('/repo', 'src/a')
  expect(useFolderChain.getState().chains).toBe(snapshot)
  useFolderChain.getState().resolve('/repo', 'src', false)
  expect(resolveDirChain).toHaveBeenCalledTimes(2)
  expect(useFolderChain.getState().chains).toBe(snapshot)
  pending.resolve('src/a/b')
  await Promise.resolve()
  expect(useFolderChain.getState().chains).toBe(snapshot)
  useFolderChain.getState().resolve('/repo', 'src', false)
  expect(resolveDirChain).toHaveBeenCalledTimes(2)
})

it('drops late answers after another invalidation and after workspace release', async () => {
  const old = deferred()
  const fresh = deferred()
  resolveDirChain.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
  useFolderChain.getState().resolve('/repo', 'src', false)
  useFolderChain.getState().invalidate('/repo')
  useFolderChain.getState().resolve('/repo', 'src', true)
  fresh.resolve('src/new')
  await Promise.resolve()
  old.resolve('src/old')
  await Promise.resolve()
  expect(useFolderChain.getState().chains['/repo:src']).toBe('src/new')
  const closing = deferred()
  resolveDirChain.mockReturnValueOnce(closing.promise)
  useFolderChain.getState().invalidate('/repo')
  useFolderChain.getState().resolve('/repo', 'src', true)
  useFolderChain.getState().forget('/repo')
  closing.resolve('src/dead')
  await Promise.resolve()
  expect(useFolderChain.getState().chains).toEqual({})
})

it('invalidates root-level changes and keeps the last good result after a failed probe', async () => {
  resolveDirChain.mockResolvedValueOnce('src/a')
  useFolderChain.getState().resolve('/repo', 'src', false)
  await Promise.resolve()
  resolveDirChain.mockRejectedValueOnce(new Error('unreadable'))
  useFolderChain.getState().invalidate('/repo', '')
  useFolderChain.getState().resolve('/repo', 'src', false)
  await Promise.resolve()
  expect(useFolderChain.getState().chains['/repo:src']).toBe('src/a')
  useFolderChain.getState().resolve('/repo', 'src', false)
  expect(resolveDirChain).toHaveBeenCalledTimes(2)
  resolveDirChain.mockResolvedValueOnce('src')
  useFolderChain.getState().invalidate('/repo', '')
  useFolderChain.getState().resolve('/repo', 'src', false)
  await Promise.resolve()
  expect(useFolderChain.getState().chains['/repo:src']).toBe('src')
})
