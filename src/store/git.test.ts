// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { GitStatus } from '../lib/ipc'

const { api, workspace, ui } = vi.hoisted(() => ({
  api: {
    gitStatus: vi.fn(),
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitDiscard: vi.fn(),
    gitCommit: vi.fn(),
    gitBranches: vi.fn(),
    gitUndoCommit: vi.fn(),
  },
  workspace: {
    roots: [{ id: '/repo', name: 'Repo', isGitRepo: true }],
    setGitRepo: vi.fn(() => false),
  },
  ui: {
    confirm: vi.fn(),
    toast: vi.fn(),
    confirmReq: null,
  },
}))

vi.mock('../lib/ipc', () => ({
  api,
  errorText: (error: unknown) => String(error),
}))
vi.mock('./workspace', () => ({ useWorkspace: { getState: () => workspace } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

import { useGit } from './git'

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepo: true,
    branch: 'main',
    head: 'abc',
    ahead: 0,
    behind: 0,
    staged: [],
    changes: [],
    untracked: [],
    conflicts: [],
    operation: null,
    pendingMessage: '',
    error: null,
    ...overrides,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  useGit.getState().reset()
  workspace.roots = [{ id: '/repo', name: 'Repo', isGitRepo: true }]
  ui.confirm.mockResolvedValue(true)
  api.gitStage.mockResolvedValue(undefined)
  api.gitUnstage.mockResolvedValue(undefined)
  api.gitDiscard.mockResolvedValue(undefined)
  api.gitCommit.mockResolvedValue('')
  api.gitStatus.mockResolvedValue(status())
  useGit.setState({
    statuses: { '/repo': status({ changes: [{ path: 'a.ts', status: 'M' }] }) },
    busy: null,
    indexPending: {},
  })
})

it('moves staged rows optimistically without taking the global busy lock', async () => {
  const write = deferred()
  api.gitStage.mockReturnValue(write.promise)

  const pending = useGit.getState().stage('/repo', ['a.ts'])
  const optimistic = useGit.getState().statuses['/repo']
  expect(optimistic.staged).toEqual([{ path: 'a.ts', status: 'M' }])
  expect(optimistic.changes).toEqual([])
  expect(useGit.getState().busy).toBeNull()
  expect(useGit.getState().isIndexPending('/repo')).toBe(true)

  write.resolve()
  await pending
  await vi.waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(1))
  expect(useGit.getState().isIndexPending('/repo')).toBe(false)
})

it('moves a newly added file back to untracked when unstaged', async () => {
  useGit.setState({
    statuses: { '/repo': status({ staged: [{ path: 'new.ts', status: 'A' }] }) },
  })
  const pending = useGit.getState().unstage('/repo', ['new.ts'])
  expect(useGit.getState().statuses['/repo'].staged).toEqual([])
  expect(useGit.getState().statuses['/repo'].untracked).toEqual([{ path: 'new.ts', status: '?' }])
  await pending
})

it('serializes rapid index mutations and coalesces their status refresh', async () => {
  useGit.setState({
    statuses: {
      '/repo': status({
        changes: [
          { path: 'a.ts', status: 'M' },
          { path: 'b.ts', status: 'M' },
        ],
      }),
    },
  })
  const first = deferred()
  const second = deferred()
  api.gitStage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

  const one = useGit.getState().stage('/repo', ['a.ts'])
  const two = useGit.getState().stage('/repo', ['b.ts'])
  await vi.waitFor(() => expect(api.gitStage).toHaveBeenCalledTimes(1))
  expect(useGit.getState().statuses['/repo'].staged.map((file) => file.path)).toEqual(['a.ts', 'b.ts'])

  first.resolve()
  await vi.waitFor(() => expect(api.gitStage).toHaveBeenCalledTimes(2))
  second.resolve()
  await Promise.all([one, two])
  await vi.waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(1))
})

it('restores authoritative rows after a failed optimistic mutation', async () => {
  api.gitStage.mockRejectedValue(new Error('index locked'))
  api.gitStatus.mockResolvedValue(status({ changes: [{ path: 'a.ts', status: 'M' }] }))

  await useGit.getState().stage('/repo', ['a.ts'])
  await vi.waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(1))
  expect(ui.toast).toHaveBeenCalledOnce()
  expect(useGit.getState().statuses['/repo'].changes).toEqual([{ path: 'a.ts', status: 'M' }])
  expect(useGit.getState().statuses['/repo'].staged).toEqual([])
})

it('makes commit wait for queued index work', async () => {
  const write = deferred()
  api.gitStage.mockReturnValue(write.promise)
  const stagePromise = useGit.getState().stage('/repo', ['a.ts'])
  const commitPromise = useGit.getState().commit('/repo', 'message')
  expect(api.gitCommit).not.toHaveBeenCalled()
  expect(useGit.getState().busy).toBe('commit')

  write.resolve()
  await stagePromise
  await vi.waitFor(() => expect(api.gitCommit).toHaveBeenCalledOnce())
  await commitPromise
})
