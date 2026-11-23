// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntryInfo, DirPage, GitStatus } from '../lib/ipc'

const { git, workspace, settings, tabs, actions, drag } = vi.hoisted(() => ({
  git: {
    statuses: {} as Record<string, GitStatus>, busy: null as string | null,
    refresh: vi.fn(), stage: vi.fn(), unstage: vi.fn(), discard: vi.fn(), resetConflict: vi.fn(),
  },
  workspace: { roots: [{ id: '/repo', name: 'Repo', isGitRepo: true }] },
  settings: { agentEnabled: true },
  tabs: { tabs: [], activeId: null, openDiff: vi.fn(), openFile: vi.fn(), refreshFromDisk: vi.fn() },
  actions: { readDir: vi.fn(), renameEntryFlow: vi.fn(), deleteEntryFlow: vi.fn(), revealEntry: vi.fn(), copyText: vi.fn(), newChat: vi.fn() },
  drag: { finished: false, begin: vi.fn() },
}))
vi.mock('../store/git', () => ({ useGit: (select: (state: unknown) => unknown) => select(git) }))
vi.mock('../store/workspace', () => ({ useWorkspace: (select: (state: unknown) => unknown) => select(workspace) }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select(settings) }))
vi.mock('../store/tabs', () => ({ useTabs: Object.assign((select: (state: unknown) => unknown) => select(tabs), { getState: () => tabs }) }))
vi.mock('../store/blame', () => ({ useBlame: { getState: () => ({ clear: vi.fn(), scheduleFetch: vi.fn() }) } }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ newChat: actions.newChat }) } }))
vi.mock('../lib/ipc', () => ({ api: { readDir: actions.readDir }, errorCode: (error: { code?: string }) => error.code ?? null }))
vi.mock('../lib/actions', () => ({ renameEntryFlow: actions.renameEntryFlow, deleteEntryFlow: actions.deleteEntryFlow, revealEntry: actions.revealEntry }))
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
  git.busy = null
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
  ['diff.openFile', 'openFile'], ['explorer.delete', 'deleteEntryFlow'],
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
  expect(button('explorer.delete').disabled).toBe(true)
  expect(button('explorer.copyRelativePath').disabled).toBe(false)
})

it('keeps symlink rename/delete actions but hides file opening and Agent entry points', async () => {
  actions.readDir.mockResolvedValue({ entries: [entry('src/a.ts', { isSymlink: true })], hasMore: false })
  render(<GitPanel />)
  await openMenu()
  expect(button('explorer.rename')).toBeTruthy()
  expect(button('explorer.delete')).toBeTruthy()
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
