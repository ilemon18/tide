// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import type { GitStatus } from '../lib/ipc'

const { api, workspace, ui, tabs } = vi.hoisted(() => ({
  api: {
    gitStatus: vi.fn(),
    gitStage: vi.fn(),
    gitUnstage: vi.fn(),
    gitDiscard: vi.fn(),
    gitCommit: vi.fn(),
    gitBranches: vi.fn(),
    gitUndoCommit: vi.fn(),
    gitStash: vi.fn(),
    gitStashPop: vi.fn(),
    gitResetAll: vi.fn(),
    gitTurnRevert: vi.fn(),
    gitProjectPreferences: vi.fn(), gitSetProjectPreferences: vi.fn(),
    gitRemoveFiles: vi.fn(), gitIgnoreFiles: vi.fn(), gitForcePush: vi.fn(), gitIdentity: vi.fn(), gitPreferences: vi.fn(), gitSetPreferences: vi.fn(),
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
  tabs: {
    tabs: [] as Array<Record<string, unknown>>,
    save: vi.fn(),
    onDeleted: vi.fn(),
    refreshFromDisk: vi.fn(),
    suspend: vi.fn(),
  },
}))

vi.mock('../lib/ipc', () => ({
  api,
  errorText: (error: unknown) => String(error),
}))
vi.mock('./workspace', () => ({ useWorkspace: { getState: () => workspace } }))
vi.mock('./tabs', () => ({
  useTabs: { getState: () => tabs },
  suspendFileSaves: tabs.suspend,
}))
vi.mock('./ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))

import { useGit, commitIdentity, DEFAULT_GIT_PREFERENCES } from './git'

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
  tabs.tabs = []
  tabs.save.mockReset().mockResolvedValue(true)
  tabs.onDeleted.mockReset()
  tabs.refreshFromDisk.mockReset().mockResolvedValue(undefined)
  tabs.suspend.mockReset().mockResolvedValue(vi.fn())
  api.gitStage.mockResolvedValue(undefined)
  api.gitUnstage.mockResolvedValue(undefined)
  api.gitDiscard.mockResolvedValue(undefined)
  api.gitCommit.mockResolvedValue('')
  api.gitStash.mockResolvedValue('')
  api.gitStashPop.mockResolvedValue('')
  api.gitResetAll.mockResolvedValue(undefined)
  api.gitTurnRevert.mockResolvedValue({ restored: [], deleted: [], skipped: [], error: null })
  api.gitStatus.mockResolvedValue(status())
  useGit.setState({
    statuses: { '/repo': status({ changes: [{ path: 'a.ts', status: 'M' }] }) },
    busy: null,
    indexPending: {},
    identities: {}, temporaryIdentity: null, preferences: DEFAULT_GIT_PREFERENCES, projectPreferences: {},
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

it('suspends open file saves, stashes and force-reloads them', async () => {
  tabs.tabs = [
    { id: 't1', root: '/repo', rel: 'a.ts', kind: 'file', external: false, dirty: false },
    { id: 't2', root: '/other', rel: 'b.ts', kind: 'file', external: false, dirty: false },
  ]

  await useGit.getState().stashChanges('/repo')

  expect(tabs.suspend).toHaveBeenCalledWith('/repo', ['a.ts'])
  expect(api.gitStash).toHaveBeenCalledWith('/repo')
  expect(tabs.refreshFromDisk).toHaveBeenCalledWith('/repo', { force: true, paths: ['a.ts'] })
  expect(useGit.getState().busy).toBeNull()
  expect(ui.toast).toHaveBeenCalledWith('toast.gitStashed', 'success')
})

it('saves dirty project files before stashing and aborts when a save fails', async () => {
  tabs.tabs = [
    { id: 't1', root: '/repo', rel: 'a.ts', kind: 'file', external: false, dirty: true },
  ]
  tabs.save.mockResolvedValue(false)

  await useGit.getState().stashChanges('/repo')

  expect(tabs.save).toHaveBeenCalledWith('t1')
  expect(api.gitStash).not.toHaveBeenCalled()
  expect(useGit.getState().busy).toBeNull()
})

it('closes tabs of staged-added files removed by a stash', async () => {
  useGit.setState({
    statuses: {
      '/repo': status({ staged: [{ path: 'new.ts', status: 'A' }], changes: [] }),
    },
  })
  tabs.tabs = [
    { id: 't1', root: '/repo', rel: 'new.ts', kind: 'file', external: false, dirty: false },
  ]

  await useGit.getState().stashChanges('/repo')

  expect(tabs.onDeleted).toHaveBeenCalledWith('/repo', 'new.ts')
  expect(tabs.refreshFromDisk).not.toHaveBeenCalled()
})

it('refreshes the worktree after a conflicted stash pop and still reports the error', async () => {
  api.gitStashPop.mockRejectedValue(new Error('conflict'))
  tabs.tabs = [
    { id: 't1', root: '/repo', rel: 'a.ts', kind: 'file', external: false, dirty: false },
  ]

  await useGit.getState().popStash('/repo')

  expect(ui.toast).toHaveBeenCalledWith('Error: conflict', 'error')
  expect(api.gitStatus).toHaveBeenCalled()
  expect(tabs.refreshFromDisk).toHaveBeenCalledWith('/repo', { force: true, paths: ['a.ts'] })
  expect(useGit.getState().busy).toBeNull()
})

it('requires confirmation before resetting all changes', async () => {
  ui.confirm.mockResolvedValue(false)
  await useGit.getState().resetAll('/repo')
  expect(api.gitResetAll).not.toHaveBeenCalled()

  ui.confirm.mockResolvedValue(true)
  tabs.tabs = [
    { id: 't1', root: '/repo', rel: 'a.ts', kind: 'file', external: false, dirty: false },
  ]
  await useGit.getState().resetAll('/repo')
  expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({
    danger: true,
    confirmOnEnter: false,
  }))
  expect(api.gitResetAll).toHaveBeenCalledWith('/repo')
  expect(tabs.refreshFromDisk).toHaveBeenCalledWith('/repo', { force: true, paths: ['a.ts'] })
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

it('reverts a turn by suspending saves, reloading restored files and dropping created ones', async () => {
  const changes = {
    snapshot: { worktree: 'tree-start', index: 'tree-index' },
    files: [
      { path: 'a.ts', status: 'M' as const, additions: 2, deletions: 1, binary: false },
      { path: 'new.ts', status: 'A' as const, additions: 3, deletions: 0, binary: false },
    ],
    additions: 5,
    deletions: 1,
    truncated: false,
  }
  api.gitTurnRevert.mockResolvedValueOnce({ restored: ['a.ts'], deleted: ['new.ts'], skipped: [], error: null })

  expect(await useGit.getState().revertTurnChanges('/repo', changes)).toBe('ok')

  expect(tabs.suspend).toHaveBeenCalledWith('/repo', ['a.ts', 'new.ts'])
  expect(api.gitTurnRevert).toHaveBeenCalledWith('/repo', changes.snapshot, changes.files)
  expect(tabs.onDeleted).toHaveBeenCalledWith('/repo', 'new.ts')
  expect(tabs.refreshFromDisk).toHaveBeenCalledWith('/repo', { force: true, paths: ['a.ts'] })
  expect(api.gitStatus).toHaveBeenCalled()
  expect(useGit.getState().busy).toBeNull()
})

it('suspends saves of both sides of a rename', async () => {
  const changes = {
    snapshot: { worktree: 'tree-start' },
    files: [{ path: 'new.ts', oldPath: 'old.ts', status: 'R' as const, additions: 1, deletions: 1, binary: false }],
    additions: 1,
    deletions: 1,
    truncated: false,
  }
  api.gitTurnRevert.mockResolvedValueOnce({ restored: ['old.ts'], deleted: ['new.ts'], skipped: [], error: null })
  await useGit.getState().revertTurnChanges('/repo', changes)
  expect(tabs.suspend).toHaveBeenCalledWith('/repo', ['new.ts', 'old.ts'])
})

it('keeps the files and toasts when the backend reports a partial revert', async () => {
  const changes = {
    snapshot: { worktree: 'tree-start' },
    files: [{ path: 'a.ts', status: 'M' as const, additions: 1, deletions: 0, binary: false }],
    additions: 1,
    deletions: 0,
    truncated: false,
  }
  api.gitTurnRevert.mockResolvedValueOnce({
    restored: [], deleted: [], skipped: [], error: { code: 'git.turnRevertBlocked', params: { path: 'a.ts' } },
  })
  expect(await useGit.getState().revertTurnChanges('/repo', changes)).toBe('error')
  expect(ui.toast).toHaveBeenCalled()
  expect(tabs.refreshFromDisk).not.toHaveBeenCalled()
})

it('reports a pruned baseline as stale without a generic error toast', async () => {
  const changes = {
    snapshot: { worktree: 'tree-start' },
    files: [{ path: 'a.ts', status: 'M' as const, additions: 1, deletions: 0, binary: false }],
    additions: 1,
    deletions: 0,
    truncated: false,
  }
  api.gitTurnRevert.mockRejectedValueOnce({ code: 'git.turnSnapshotMissing', params: {} })
  expect(await useGit.getState().revertTurnChanges('/repo', changes)).toBe('stale')
  expect(ui.toast).not.toHaveBeenCalled()
  expect(useGit.getState().busy).toBeNull()
})

it('uses the effective project identity by default regardless of legacy source flags', () => {
  useGit.setState({ identities: { '/repo': { global: { name: 'Global', email: 'g@example.invalid' }, effective: { name: 'Project', email: 'p@example.invalid' }, useGlobal: true } } })
  expect(commitIdentity('/repo')?.name).toBe('Project')
  useGit.setState({ identities: { '/repo': { ...useGit.getState().identities['/repo'], useGlobal: false } } })
  expect(commitIdentity('/repo')?.name).toBe('Project')
  useGit.getState().setTemporaryIdentity({ name: 'Temp', email: 't@example.invalid' })
  expect(commitIdentity('/repo')?.name).toBe('Temp')
  useGit.getState().forget('/repo')
  expect(useGit.getState().identities['/repo']).toBeUndefined()
  useGit.getState().reset()
  expect(useGit.getState().temporaryIdentity?.name).toBe('Temp')
})
it('includes temporary identity in commit options without persisting it', async () => {
  useGit.getState().setTemporaryIdentity({ name: 'Temp', email: 't@example.invalid' })
  await useGit.getState().commit('/repo', 'message', { amend: true, skipHooks: true })
  expect(api.gitCommit).toHaveBeenCalledWith('/repo', 'message', { amend: true, skipHooks: true, identity: { name: 'Temp', email: 't@example.invalid' }, resetAuthor: true })
})
it('skips automatic status refresh when disabled but allows explicit refresh', async () => {
  useGit.setState({ preferences: { ...DEFAULT_GIT_PREFERENCES, autoRefresh: false } })
  await useGit.getState().refresh('/repo')
  expect(api.gitStatus).not.toHaveBeenCalled()
  await useGit.getState().refresh('/repo', true)
  expect(api.gitStatus).toHaveBeenCalledWith('/repo')
})
it('metadata operations keep editors untouched and do not recreate forgotten roots', async () => {
  const pending = deferred<string>()
  api.gitForcePush.mockReturnValue(pending.promise)
  const running = useGit.getState().forcePush('/repo')
  await vi.waitFor(() => expect(api.gitForcePush).toHaveBeenCalled())
  workspace.roots = []
  useGit.getState().forget('/repo')
  pending.resolve('done'); await running
  expect(api.gitStatus).not.toHaveBeenCalled()
  expect(api.gitBranches).not.toHaveBeenCalled()
  expect(tabs.refreshFromDisk).not.toHaveBeenCalled()
  expect(useGit.getState().busy).toBeNull()
})
it('selected discard preserves unselected changes and refreshes only restored files', async () => {
  const discardApi = vi.fn().mockResolvedValue({ restored: ['a.ts'], deleted: [], error: null })
  Object.assign(api, { gitDiscardChanges: discardApi })
  useGit.setState({ statuses: { '/repo': status({ changes: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] }) } })
  await useGit.getState().discardFiles('/repo', ['a.ts'])
  expect(discardApi).toHaveBeenCalledWith('/repo', ['a.ts'], [])
  expect(tabs.refreshFromDisk).toHaveBeenCalledWith('/repo', { force: true, paths: ['a.ts'] })
})
it('does not overwrite a dirty .gitignore when ignoring files', async () => {
  tabs.tabs = [{ id: 'ignore', root: '/repo', rel: '.gitignore', kind: 'file', dirty: true }]
  await useGit.getState().ignoreFiles('/repo', ['new.ts'])
  expect(api.gitIgnoreFiles).not.toHaveBeenCalled()
  expect(ui.toast).toHaveBeenCalledWith('git.ignoreDirty', 'info')
})

it('keeps project preferences isolated and clears them with the closed root', async () => {
  workspace.roots = [{ id: '/repo', name: 'Repo', isGitRepo: true }, { id: '/other', name: 'Other', isGitRepo: true }]
  api.gitSetProjectPreferences.mockResolvedValue({ ...DEFAULT_GIT_PREFERENCES, autoRefresh: false })
  await useGit.getState().setProjectPreferences('/repo', { autoRefresh: false })
  expect(api.gitSetProjectPreferences).toHaveBeenCalledWith('/repo', { autoRefresh: false })
  expect(api.gitSetPreferences).not.toHaveBeenCalled()
  await useGit.getState().refresh('/repo')
  expect(api.gitStatus).not.toHaveBeenCalled()
  await useGit.getState().refresh('/other')
  expect(api.gitStatus).toHaveBeenCalledWith('/other')
  useGit.getState().forget('/repo')
  expect(useGit.getState().projectPreferences['/repo']).toBeUndefined()
})
it('keeps a successful commit successful if its message history cannot be written', async () => {
  api.gitCommit.mockResolvedValue({ output: 'done', historyError: { code: 'io.permissionDenied' } })
  expect(await useGit.getState().commit('/repo', 'done')).toBe(true)
  expect(ui.toast).toHaveBeenCalledWith('git.historySaveFailed', 'info')
})
