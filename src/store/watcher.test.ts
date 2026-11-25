import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FsChanged } from '../lib/ipc'

const mocks = vi.hoisted(() => ({
  listen: vi.fn(), refreshTree: vi.fn(), refreshDirs: vi.fn(), scheduleRefresh: vi.fn(),
  isIndexPending: vi.fn(() => false),
  invalidateBranches: vi.fn(), invalidateChain: vi.fn(), invalidateIndex: vi.fn(), refreshFromDisk: vi.fn(),
}))
vi.mock('@tauri-apps/api/event', () => ({ listen: mocks.listen }))
vi.mock('./workspace', () => ({ useWorkspace: { getState: () => workspace } }))
vi.mock('./git', () => ({ useGit: { getState: () => mocks } }))
vi.mock('./tabs', () => ({ useTabs: { getState: () => mocks } }))
vi.mock('./folderChain', () => ({ useFolderChain: { getState: () => ({ invalidate: mocks.invalidateChain }) } }))
vi.mock('./fileIndex', () => ({
  useFileIndex: { getState: () => ({ byRoot: { '/repo': { files: ['src/one'] } }, invalidate: mocks.invalidateIndex }) },
  indexHasFile: (_index: unknown, rel: string) => rel === 'src/one',
}))
const workspace = {
  roots: [{ id: '/repo', isGitRepo: true, tree: { '': { entries: [] }, src: { entries: [] } } }],
  refreshTree: mocks.refreshTree, refreshDirs: mocks.refreshDirs,
}
let emit: (payload: FsChanged) => void
let watcher: typeof import('./watcher')
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  mocks.isIndexPending.mockReturnValue(false)
  mocks.refreshDirs.mockResolvedValue(undefined)
  mocks.refreshTree.mockResolvedValue(undefined)
  mocks.refreshFromDisk.mockResolvedValue(undefined)
  mocks.listen.mockImplementation(async (_name, callback) => {
    emit = (payload) => callback({ payload })
    return () => {}
  })
  watcher = await import('./watcher')
  await watcher.setupFsEvents()
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
const event = (patch: Partial<FsChanged> = {}): FsChanged => ({
  root: '/repo', git: true, worktree: false, paths: [], rescan: false, ignoreChanged: false, ...patch,
})

it('refreshes Git and diff state without touching the tree for add/commit metadata', async () => {
  emit(event())
  expect(mocks.scheduleRefresh).toHaveBeenCalledWith('/repo')
  expect(mocks.invalidateBranches).toHaveBeenCalledWith('/repo')
  expect(mocks.refreshTree).not.toHaveBeenCalled()
  expect(mocks.refreshDirs).not.toHaveBeenCalled()
  expect(mocks.invalidateChain).not.toHaveBeenCalled()
  expect(mocks.invalidateIndex).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(400)
  expect(mocks.refreshFromDisk).toHaveBeenCalledWith('/repo', undefined)
})

it('skips the duplicate Git status while an optimistic index queue owns the refresh', () => {
  mocks.isIndexPending.mockReturnValue(true)
  emit(event())
  expect(mocks.scheduleRefresh).not.toHaveBeenCalled()
})

it('refreshes affected directories when Git and worktree changes share a batch', async () => {
  emit(event({ worktree: true, paths: ['src/one'] }))
  await Promise.resolve()
  expect(mocks.refreshDirs).toHaveBeenCalledWith('/repo', ['src'], { quiet: true })
  expect(mocks.refreshTree).not.toHaveBeenCalled()
  expect(mocks.invalidateChain).toHaveBeenCalledWith('/repo', 'src')
  expect(mocks.invalidateIndex).not.toHaveBeenCalled()
})

it.each([
  { rescan: true }, { ignoreChanged: true }, { worktree: true, paths: ['src/.gitignore'] },
])('uses a full refresh for incomplete batches or changed ignore rules: %j', (patch) => {
  emit(event(patch))
  expect(mocks.refreshTree).toHaveBeenCalledWith('/repo', { quiet: true })
  expect(mocks.invalidateIndex).toHaveBeenCalledWith('/repo')
})

it('suppresses fetch metadata but still processes worktree changes and loss signals', () => {
  watcher.beginGitMetadataTransition('/repo')
  emit(event())
  expect(mocks.scheduleRefresh).not.toHaveBeenCalled()
  emit(event({ worktree: true, paths: ['src/one'] }))
  expect(mocks.refreshDirs).toHaveBeenCalledTimes(1)
  emit(event({ rescan: true }))
  expect(mocks.refreshTree).toHaveBeenCalledTimes(1)
})

it('keeps branch-transition suppression but never suppresses a rescan', () => {
  watcher.beginBranchTransition('/repo')
  emit(event())
  expect(mocks.scheduleRefresh).not.toHaveBeenCalled()
  emit(event({ rescan: true }))
  expect(mocks.refreshTree).toHaveBeenCalledWith('/repo', { quiet: true })
})

it('merges mixed worktree batches during checkout and processes them after its debounce tail', async () => {
  watcher.beginBranchTransition('/repo')
  emit(event({ worktree: true, paths: ['src/one'] }))
  emit(event({ worktree: true, paths: ['new.ts'] }))
  expect(mocks.refreshDirs).not.toHaveBeenCalled()
  watcher.endBranchTransition('/repo')
  await vi.advanceTimersByTimeAsync(800)
  expect(mocks.refreshDirs).toHaveBeenCalledWith('/repo', ['src', ''], { quiet: true })
  expect(mocks.invalidateIndex).toHaveBeenCalledWith('/repo')
  await vi.advanceTimersByTimeAsync(400)
  expect(mocks.refreshFromDisk).toHaveBeenCalledWith('/repo', { paths: ['src/one', 'new.ts'] })
})

it('processes ignore rule changes even during a branch transition', () => {
  watcher.beginBranchTransition('/repo')
  emit(event({ ignoreChanged: true }))
  expect(mocks.refreshTree).toHaveBeenCalledWith('/repo', { quiet: true })
})
