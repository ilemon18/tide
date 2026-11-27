// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntryInfo, DirPage, GitStatus, GitIdentityInfo } from '../lib/ipc'

const { git, workspace, settings, tabs, actions, drag, ui } = vi.hoisted(() => ({
  git: {
    statuses: {} as Record<string, GitStatus>, busy: null as string | null,
    identities: {} as Record<string, GitIdentityInfo>, temporaryIdentity: null, loadIdentity: vi.fn(), setTemporaryIdentity: vi.fn(), fetch: vi.fn(), clearStash: vi.fn(), commit: vi.fn(),
    removeFiles: vi.fn(), ignoreFiles: vi.fn(), discardFiles: vi.fn(),
    refresh: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), resetConflict: vi.fn(),
    stashChanges: vi.fn(), popStash: vi.fn(), resetAll: vi.fn(),
  },
  workspace: { roots: [{ id: '/repo', name: 'Repo', isGitRepo: true }] },
  settings: { agentEnabled: true },
  tabs: { tabs: [], activeId: null, openDiff: vi.fn(), openFile: vi.fn(), refreshFromDisk: vi.fn() },
  actions: { readDir: vi.fn(), renameEntryFlow: vi.fn(), deleteEntryFlow: vi.fn(), revealEntry: vi.fn(), copyText: vi.fn(), newChat: vi.fn(), gitStashCount: vi.fn(), gitStashList: vi.fn(), gitCommitHistory: vi.fn() },
  ui: { openBranchMenu: vi.fn(), toast: vi.fn(), confirmReq: null },
  drag: { finished: false, begin: vi.fn() },
}))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../store/git', () => ({ useGit: Object.assign((select: (state: unknown) => unknown) => select(git), { getState: () => git }) }))
vi.mock('../store/workspace', () => ({ useWorkspace: (select: (state: unknown) => unknown) => select(workspace) }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select(settings) }))
vi.mock('../store/tabs', () => ({ useTabs: Object.assign((select: (state: unknown) => unknown) => select(tabs), { getState: () => tabs }) }))
vi.mock('../store/blame', () => ({ useBlame: { getState: () => ({ clear: vi.fn(), scheduleFetch: vi.fn() }) } }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ newChat: actions.newChat }) } }))
vi.mock('../lib/ipc', () => ({ api: { readDir: actions.readDir, gitStashCount: actions.gitStashCount, gitStashList: actions.gitStashList, gitCommitHistory: actions.gitCommitHistory }, errorCode: (error: { code?: string }) => error.code ?? null }))
vi.mock('../lib/actions', () => ({ renameEntryFlow: actions.renameEntryFlow, deleteEntryFlow: actions.deleteEntryFlow, revealEntry: actions.revealEntry, createBranch: vi.fn(), openRemoteRepository: vi.fn() }))
vi.mock('../lib/clipboard', () => ({ copyText: actions.copyText }))
vi.mock('../lib/fileDragState', () => ({ beginFilePointerDrag: drag.begin, wasFileDragJustFinished: () => drag.finished }))
vi.mock('../lib/memoryBudget', () => ({ budget: { gitPollInterval: () => 10000 } }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { GitPanel } from './GitPanel'

const entry = (path = 'src/a.ts', extra: Partial<DirEntryInfo> = {}): DirEntryInfo => ({
  path, name: path.split('/').at(-1)!, isDir: false, isSymlink: false, ignored: false, size: 0, mtime: 0, ...extra,
})
beforeEach(() => {
  vi.clearAllMocks()
  actions.readDir.mockReset().mockResolvedValue({ entries: [entry()], hasMore: false })
  actions.gitStashCount.mockReset().mockResolvedValue(2)
  git.busy = null
  git.identities = {}
  actions.gitCommitHistory.mockResolvedValue({ messages: ['saved message'], limit: 5 })
  git.stashChanges.mockResolvedValue(true)
  git.clearStash.mockResolvedValue(true)
  actions.gitStashList.mockResolvedValue({ entries: [{ selector: 'stash@{0}', sha: 'abc', time: 0, message: 'latest' }], hasMore: false })
  git.statuses = { '/repo': {
    isRepo: true, branch: 'main', head: 'abc', ahead: 0, behind: 0,
    changes: [{ path: 'src/a.ts', status: 'M' }], staged: [], untracked: [], conflicts: [],
    operation: null, pendingMessage: '', error: null,
  } }
  settings.agentEnabled = true
  drag.finished = false
  workspace.roots = [{ id: '/repo', name: 'Repo', isGitRepo: true }]
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

async function openMenu(path = 'src/a.ts') {
  fireEvent.contextMenu(screen.getByTitle(path), { clientX: 50, clientY: 100 })
  await waitFor(() => expect(actions.readDir).toHaveBeenCalled())
  await act(async () => {})
}
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement

it('opens one diff on the first click and the file menu on double-click', async () => {
  render(<GitPanel />)
  const row = screen.getByTitle('src/a.ts')
  fireEvent.click(row, { detail: 1 })
  fireEvent.click(row, { detail: 2 })
  fireEvent.doubleClick(row, { clientX: 50, clientY: 100 })
  expect(tabs.openDiff).toHaveBeenCalledExactlyOnceWith('/repo', 'src/a.ts', false)
  await screen.findByRole('button', { name: 'explorer.rename' })
  expect(button('git.stage')).toBeTruthy()
  expect(button('explorer.copyRelativePath')).toBeTruthy()
})

it('offers worktree and tree actions and reuses the existing rename flow', async () => {
  render(<GitPanel />)
  await openMenu()
  expect(button('diff.openFile')).toBeTruthy()
  expect(button('titlebar.agentTip')).toBeTruthy()
  fireEvent.click(button('explorer.rename'))
  expect(actions.renameEntryFlow).toHaveBeenCalledWith('/repo', 'src/a.ts')
  expect(tabs.openDiff).not.toHaveBeenCalled()
})

it.each([
  ['diff.openFile', 'openFile'],
  ['explorer.revealInFinder', 'revealEntry'], ['explorer.copyRelativePath', 'copyText'],
  ['titlebar.agentTip', 'newChat'],
] as const)('runs %s on the menu target', async (label, action) => {
  render(<GitPanel />)
  await openMenu()
  fireEvent.click(button(label))
  const fn = action === 'openFile' ? tabs.openFile : actions[action]
  if (action === 'newChat') expect(fn).toHaveBeenCalledWith('/repo', [{ rel: 'src/a.ts', isDir: false }])
  else if (action === 'copyText') expect(fn).toHaveBeenCalledWith('src/a.ts', label)
  else expect(fn).toHaveBeenCalledWith('/repo', 'src/a.ts')
})

it('shows staged actions and opens the staged diff from its menu', async () => {
  git.statuses['/repo'].staged = git.statuses['/repo'].changes
  git.statuses['/repo'].changes = []
  render(<GitPanel />)
  await openMenu()
  expect(button('git.unstage')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'git.stage' })).toBeNull()
  fireEvent.click(button('git.openChanges'))
  expect(tabs.openDiff).toHaveBeenCalledWith('/repo', 'src/a.ts', true)
})

it('retains path and Git actions for a deleted file without disk actions', async () => {
  git.statuses['/repo'].changes[0].status = 'D'
  actions.readDir.mockResolvedValue({ entries: [], hasMore: false })
  render(<GitPanel />)
  await openMenu()
  expect(button('git.stage').disabled).toBe(false)
  expect(button('git.discardChanges')).toBeTruthy()
  expect(button('explorer.copyName')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'diff.openFile' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'explorer.rename' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'titlebar.agentTip' })).toBeNull()
})

it('uses worktree metadata even when a staged deletion has a replacement file', async () => {
  git.statuses['/repo'].staged = [{ path: 'src/a.ts', status: 'D' }]
  git.statuses['/repo'].changes = []
  render(<GitPanel />)
  await openMenu()
  expect(button('diff.openFile')).toBeTruthy()
  expect(button('explorer.rename')).toBeTruthy()
})

it('offers stash, pop and reset in the more-actions menu', async () => {
  const { container } = render(<GitPanel />)
  fireEvent.click(container.querySelector('[data-tip="git.moreActions"]') as HTMLElement)
  await waitFor(() => expect(actions.gitStashCount).toHaveBeenCalledWith('/repo'))
  await screen.findByRole('button', { name: 'git.popStashCount' })

  fireEvent.click(button('git.stashChanges'))
  await screen.findByRole('dialog', { name: 'git.stashChanges' })
  fireEvent.change(screen.getByRole('textbox', { name: 'git.stashMessage' }), { target: { value: 'my work' } })
  fireEvent.click(screen.getAllByRole('button', { name: 'git.stashChanges' }).at(-1)!)
  await waitFor(() => expect(git.stashChanges).toHaveBeenCalledWith('/repo', 'my work'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  fireEvent.click(container.querySelector('[data-tip="git.moreActions"]') as HTMLElement)
  fireEvent.click(await screen.findByRole('button', { name: 'git.popStashCount' }))
  await screen.findByRole('radio')
  fireEvent.click(button('git.popStash'))
  await waitFor(() => expect(git.popStash).toHaveBeenCalledWith('/repo', 'abc'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

  fireEvent.click(container.querySelector('[data-tip="git.moreActions"]') as HTMLElement)
  fireEvent.click(await screen.findByRole('button', { name: 'git.resetAll' }))
  expect(git.resetAll).toHaveBeenCalledWith('/repo')
})

it('disables stash and reset when there are no tracked changes', async () => {
  git.statuses['/repo'].changes = []
  const { container } = render(<GitPanel />)
  fireEvent.click(container.querySelector('[data-tip="git.moreActions"]') as HTMLElement)
  await screen.findByRole('button', { name: 'git.resetAll' })
  expect(button('git.stashChanges').disabled).toBe(true)
  expect(button('git.resetAll').disabled).toBe(true)
})

it('shows conflict actions and opens the worktree on single click', async () => {
  git.statuses['/repo'].conflicts = [{ path: 'src/a.ts', status: 'UU' }]
  git.statuses['/repo'].changes = []
  render(<GitPanel />)
  fireEvent.click(screen.getByTitle('src/a.ts'))
  expect(tabs.openFile).toHaveBeenCalledWith('/repo', 'src/a.ts')
  await openMenu()
  expect(button('git.regenerateMarkers')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'git.discardChanges' })).toBeNull()
  fireEvent.click(button('git.markResolved'))
  expect(git.stage).toHaveBeenCalledWith('/repo', ['src/a.ts'])
})

it('disables mutations while Git is busy but keeps copying available', async () => {
  git.busy = 'commit'
  render(<GitPanel />)
  await openMenu()
  expect(button('git.stage').disabled).toBe(true)
  expect(button('git.discardChanges').disabled).toBe(true)
  expect(button('explorer.rename').disabled).toBe(true)
  expect(button('git.deleteFile').disabled).toBe(true)
  expect(button('explorer.copyRelativePath').disabled).toBe(false)
})

it('keeps symlink rename/delete actions but hides file opening and Agent entry points', async () => {
  actions.readDir.mockResolvedValue({ entries: [entry('src/a.ts', { isSymlink: true })], hasMore: false })
  render(<GitPanel />)
  await openMenu()
  expect(button('explorer.rename')).toBeTruthy()
  expect(button('git.deleteFile')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'diff.openFile' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'titlebar.agentTip' })).toBeNull()
})

it('does not expose file operations for an untracked directory placeholder', async () => {
  git.statuses['/repo'].changes = []
  git.statuses['/repo'].untracked = [{ path: 'nested/', status: '?' }]
  actions.readDir.mockResolvedValue({ entries: [entry('nested', { isDir: true })], hasMore: false })
  render(<GitPanel />)
  await openMenu('nested/')
  expect(button('explorer.copyRelativePath')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'git.stage' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'git.deleteFile' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'explorer.delete' })).toBeNull()
})

it('hides Agent actions when the feature is disabled', async () => {
  settings.agentEnabled = false
  render(<GitPanel />)
  await openMenu()
  expect(screen.queryByRole('button', { name: 'titlebar.agentTip' })).toBeNull()
})

it('isolates inline action buttons and ignores completed drags', () => {
  render(<GitPanel />)
  const row = screen.getByTitle('src/a.ts')
  fireEvent.pointerEnter(row)
  const stage = button('git.stage')
  fireEvent.click(stage)
  fireEvent.doubleClick(stage)
  expect(git.stage).toHaveBeenCalledOnce()
  expect(tabs.openDiff).not.toHaveBeenCalled()
  expect(actions.readDir).not.toHaveBeenCalled()
  drag.finished = true
  fireEvent.click(row)
  fireEvent.doubleClick(row)
  expect(tabs.openDiff).not.toHaveBeenCalled()
  expect(actions.readDir).not.toHaveBeenCalled()
})

it('discards metadata for a dismissed menu and does not reopen it', async () => {
  let resolve!: (page: Partial<DirPage>) => void
  actions.readDir.mockReturnValue(new Promise(done => { resolve = done }))
  render(<GitPanel />)
  fireEvent.contextMenu(screen.getByTitle('src/a.ts'))
  expect(button('git.stage').disabled).toBe(true)
  expect(button('git.openChanges').disabled).toBe(true)
  fireEvent.keyDown(document, { key: 'Escape' })
  await act(async () => { resolve({ entries: [entry()], hasMore: false }) })
  expect(screen.queryByRole('button', { name: 'explorer.rename' })).toBeNull()
})

it('keeps Git actions available after an entire parent directory was removed', async () => {
  git.statuses['/repo'].changes[0].status = 'D'
  actions.readDir.mockRejectedValue({ code: 'io.notFound' })
  render(<GitPanel />)
  await openMenu()
  expect(button('git.stage').disabled).toBe(false)
  expect(button('git.openChanges').disabled).toBe(false)
  expect(screen.queryByRole('button', { name: 'explorer.rename' })).toBeNull()
})

it('keeps only reading path actions available when metadata is inaccessible', async () => {
  actions.readDir.mockRejectedValue({ code: 'io.permissionDenied' })
  render(<GitPanel />)
  await openMenu()
  expect(button('git.stage').disabled).toBe(true)
  expect(button('git.openChanges').disabled).toBe(true)
  expect(button('explorer.copyAbsolutePath').disabled).toBe(false)
  expect(screen.queryByRole('button', { name: 'diff.openFile' })).toBeNull()
})

it('Shift selects a range and the context stage action targets the whole range without opening diffs', async () => {
  git.statuses['/repo'].changes = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({ path, status: 'M' }))
  actions.readDir.mockResolvedValue({ entries: [entry(), entry('src/b.ts'), entry('src/c.ts')], hasMore: false })
  render(<GitPanel />)
  fireEvent.click(screen.getByTitle('src/a.ts'), { detail: 1 })
  tabs.openDiff.mockClear()
  fireEvent.click(screen.getByTitle('src/c.ts'), { detail: 1, shiftKey: true })
  expect(tabs.openDiff).not.toHaveBeenCalled()
  await openMenu('src/b.ts')
  fireEvent.click(button('git.stage'))
  expect(git.stage).toHaveBeenCalledWith('/repo', ['src/a.ts', 'src/b.ts', 'src/c.ts'])
})
it('uses the native batch remove flow and distinguishes added and deleted names', async () => {
  git.statuses['/repo'].changes = [{ path: 'src/a.ts', status: 'D' }]
  git.statuses['/repo'].untracked = [{ path: 'src/b.ts', status: '?' }]
  actions.readDir.mockResolvedValue({ entries: [entry('src/b.ts')], hasMore: false })
  render(<GitPanel />)
  expect(screen.getByText('a.ts').className).toContain('line-through')
  expect(screen.getByText('b.ts').className).toContain('text-success')
  await openMenu('src/b.ts')
  fireEvent.click(button('git.deleteFile'))
  expect(git.removeFiles).toHaveBeenCalledWith('/repo', ['src/b.ts'])
})
it('fetches all remotes through the source control toolbar', () => {
  const { container } = render(<GitPanel />)
  fireEvent.click(container.querySelector('[data-tip="git.fetchAllTip"]')!)
  expect(git.fetch).toHaveBeenCalledWith('/repo')
})

it('disables all path and filename copies for a multi-file selection', async () => {
  git.statuses['/repo'].changes = ['src/a.ts', 'src/b.ts'].map(path => ({ path, status: 'M' }))
  render(<GitPanel />)
  fireEvent.click(screen.getByTitle('src/a.ts'), { detail: 1 })
  fireEvent.click(screen.getByTitle('src/b.ts'), { detail: 1, shiftKey: true })
  await openMenu('src/a.ts')
  for (const label of ['explorer.copyRelativePath', 'explorer.copyAbsolutePath', 'explorer.copyName']) {
    expect(button(label).disabled).toBe(true)
    fireEvent.click(button(label))
  }
  expect(actions.copyText).not.toHaveBeenCalled()
})
it('opens a local-branch picker from the complete branch name', () => {
  git.statuses['/repo'].branch = 'feature/a-long-branch-name'
  render(<GitPanel />)
  const branch = button('feature/a-long-branch-name')
  expect(branch.title).toBe('feature/a-long-branch-name')
  expect(branch.className).toContain('cursor-pointer')
  fireEvent.click(branch)
  expect(ui.openBranchMenu).toHaveBeenCalledWith({ root: '/repo', localOnly: true })
})
it('reads history only on opening and does not requery when the panel rerenders', async () => {
  const { rerender } = render(<GitPanel />)
  expect(actions.gitCommitHistory).not.toHaveBeenCalled()
  fireEvent.click(button('git.commitHistory'))
  await screen.findByText('saved message')
  rerender(<GitPanel />)
  fireEvent.click(screen.getByRole('button', { name: 'saved message' }))
  expect(actions.gitCommitHistory).toHaveBeenCalledExactlyOnceWith('/repo')
  expect((screen.getByPlaceholderText('git.commitPlaceholder') as HTMLTextAreaElement).value).toBe('saved message')
})

it('clears only the commit input and returns focus without modifying history', async () => {
  render(<GitPanel />)
  const input = screen.getByPlaceholderText('git.commitPlaceholder') as HTMLTextAreaElement
  expect(button('git.clearCommitMessage').disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'draft message' } })
  fireEvent.click(button('git.clearCommitMessage'))
  expect(input.value).toBe('')
  expect(document.activeElement).toBe(input)
  expect(git.commit).not.toHaveBeenCalled()
  expect(actions.gitCommitHistory).not.toHaveBeenCalled()
})

it('uses checkboxes for staging and unstaging while row selection stays independent', () => {
  const { rerender } = render(<GitPanel />)
  const checkbox = within(screen.getByTitle('src/a.ts')).getByRole('checkbox') as HTMLInputElement
  expect(checkbox.checked).toBe(false)
  fireEvent.click(checkbox)
  expect(git.stage).toHaveBeenCalledExactlyOnceWith('/repo', ['src/a.ts'])
  expect(tabs.openDiff).not.toHaveBeenCalled()
  expect(screen.getByTitle('src/a.ts').getAttribute('aria-selected')).toBe('false')

  git.statuses['/repo'] = { ...git.statuses['/repo'], changes: [], staged: [{ path: 'src/a.ts', status: 'M' }] }
  rerender(<GitPanel key="staged-status" />)
  const staged = within(screen.getByTitle('src/a.ts')).getByRole('checkbox') as HTMLInputElement
  expect(staged.checked).toBe(true)
  fireEvent.click(staged)
  expect(git.unstage).toHaveBeenCalledExactlyOnceWith('/repo', ['src/a.ts'])
  expect(tabs.openDiff).not.toHaveBeenCalled()
})

it('Shift and Ctrl selection only highlight rows, and checking a selected row stages only that file', () => {
  git.statuses['/repo'].changes = ['src/a.ts', 'src/b.ts', 'src/c.ts'].map(path => ({ path, status: 'M' }))
  render(<GitPanel />)
  fireEvent.click(screen.getByTitle('src/a.ts'))
  fireEvent.click(screen.getByTitle('src/b.ts'), { shiftKey: true })
  fireEvent.click(screen.getByTitle('src/c.ts'), { ctrlKey: true })
  for (const path of ['src/a.ts', 'src/b.ts', 'src/c.ts']) {
    const row = screen.getByTitle(path)
    expect(row.getAttribute('aria-selected')).toBe('true')
    expect((within(row).getByRole('checkbox') as HTMLInputElement).checked).toBe(false)
  }
  expect(git.stage).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByTitle('src/b.ts')).getByRole('checkbox'))
  expect(git.stage).toHaveBeenCalledExactlyOnceWith('/repo', ['src/b.ts'])
  expect(screen.getByTitle('src/a.ts').getAttribute('aria-selected')).toBe('true')
})

it('group checkboxes stage or unstage every real file regardless of range selection', () => {
  git.statuses['/repo'].changes = ['src/a.ts', 'src/b.ts'].map(path => ({ path, status: 'M' }))
  git.statuses['/repo'].untracked = [{ path: 'nested/', status: '?' }, { path: 'new.ts', status: '?' }]
  git.statuses['/repo'].staged = [{ path: 'staged.ts', status: 'A' }]
  render(<GitPanel />)
  fireEvent.click(screen.getByTitle('src/a.ts'))
  fireEvent.click(screen.getByRole('checkbox', { name: 'git.stageAll' }))
  expect(git.stage).toHaveBeenCalledExactlyOnceWith('/repo', ['src/a.ts', 'src/b.ts', 'new.ts'])
  fireEvent.click(screen.getByRole('checkbox', { name: 'git.unstageAll' }))
  expect(git.unstage).toHaveBeenCalledExactlyOnceWith('/repo', ['staged.ts'])
  expect((within(screen.getByTitle('nested/')).getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
})

it('blocks staging checkboxes while Git is busy and prevents bulk resolution of conflicts', () => {
  git.busy = 'commit'
  const { rerender } = render(<GitPanel />)
  for (const checkbox of screen.getAllByRole('checkbox') as HTMLInputElement[]) {
    expect(checkbox.disabled).toBe(true)
    fireEvent.click(checkbox)
  }
  expect(git.stage).not.toHaveBeenCalled()
  git.busy = null
  git.statuses['/repo'] = { ...git.statuses['/repo'], changes: [], conflicts: [{ path: 'src/a.ts', status: 'UU' }] }
  rerender(<GitPanel key="conflict-status" />)
  expect((screen.getByRole('checkbox', { name: 'git.markResolvedFirst' }) as HTMLInputElement).disabled).toBe(true)
})
