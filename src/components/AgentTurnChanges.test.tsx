// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentTurnChanges as TurnChanges } from '../lib/ipc'

const { agent, git, tabs, ui } = vi.hoisted(() => ({
  agent: {
    markTurnChangesReverted: vi.fn(),
    markTurnChangesStale: vi.fn(),
    chats: { chat: { status: 'idle', messages: [{ id: 'm1' }] } } as Record<string, { status: string; messages: Array<{ id: string }> }>,
  },
  git: { busy: null as string | null, revertTurnChanges: vi.fn() },
  tabs: { openDiff: vi.fn() },
  ui: { confirm: vi.fn(), toast: vi.fn() },
}))

vi.mock('../store/agent', () => ({ useAgent: { getState: () => agent } }))
vi.mock('../store/git', () => ({
  useGit: Object.assign(
    (select: (state: { busy: string | null }) => unknown) => select({ busy: git.busy }),
    { getState: () => git },
  ),
}))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => tabs } }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentTurnChanges } from './AgentTurnChanges'

const changes = (overrides: Partial<TurnChanges> = {}): TurnChanges => ({
  snapshot: { worktree: 'tree-start', index: 'tree-index' },
  files: [
    { path: 'src/a.ts', status: 'M', additions: 3, deletions: 1, binary: false },
    { path: 'src/b.ts', status: 'A', additions: 2, deletions: 0, binary: false },
  ],
  additions: 5,
  deletions: 1,
  truncated: false,
  ...overrides,
})

const view = (value = changes(), latest = true) => (
  <AgentTurnChanges chatId="chat" root="/repo" messageId="m1" changes={value} latest={latest} />
)

beforeEach(() => {
  vi.clearAllMocks()
  agent.chats.chat.status = 'idle'
  git.busy = null
  git.revertTurnChanges.mockResolvedValue('ok')
  ui.confirm.mockResolvedValue(true)
})
afterEach(cleanup)

it('lists totals and per-file line counts and opens the diff of a clicked row', () => {
  const { container } = render(view())
  expect(screen.getByText('agent.changes.title')).toBeTruthy()
  const total = (name: string) => container.querySelector(`[data-changes-${name}]`)?.getAttribute(`data-changes-${name}`)
  expect(total('additions')).toBe('5')
  expect(total('deletions')).toBe('1')
  expect(screen.getByText('+3')).toBeTruthy()
  expect(screen.queryByText('−0')).toBeNull()
  const rows = container.querySelector('[data-agent-changes] > div:nth-of-type(2)')
  expect(rows?.className).toContain('gap-0.5')
  fireEvent.click(screen.getByText('src/a.ts'))
  expect(tabs.openDiff).toHaveBeenCalledExactlyOnceWith('/repo', 'src/a.ts', false)
})

it('omits zero totals and zero per-file counts', () => {
  const { container } = render(view(changes({
    files: [{ path: 'src/a.ts', status: 'M', additions: 0, deletions: 0, binary: false }],
    additions: 0,
    deletions: 0,
  })))
  expect(container.querySelector('[data-changes-additions]')).toBeNull()
  expect(container.querySelector('[data-changes-deletions]')).toBeNull()
  expect(screen.queryByText('+0')).toBeNull()
  expect(screen.queryByText('−0')).toBeNull()
})

it('offers undo only on the latest reply', () => {
  const { rerender } = render(view(changes(), false))
  expect(screen.queryByText('agent.changes.revert')).toBeNull()
  rerender(view(changes(), true))
  expect(screen.getByText('agent.changes.revert')).toBeTruthy()
})

it('marks the turn undone only after the confirmation dialog accepts', async () => {
  const { rerender } = render(view())
  fireEvent.click(screen.getByText('agent.changes.revert'))
  await vi.waitFor(() => expect(git.revertTurnChanges).toHaveBeenCalledWith('/repo', changes()))
  expect(ui.confirm).toHaveBeenCalledWith(expect.objectContaining({ danger: true }))
  expect(agent.markTurnChangesReverted).toHaveBeenCalledWith('chat', 'm1')
  expect(ui.toast).toHaveBeenCalledWith('toast.agentChangesReverted', 'success')

  rerender(view(changes({ revertedAt: 5 })))
  expect(screen.getByText('agent.changes.reverted')).toBeTruthy()
  expect(screen.queryByText('agent.changes.revert')).toBeNull()
})

it('keeps the turn untouched when the confirmation is dismissed', async () => {
  ui.confirm.mockResolvedValue(false)
  render(view())
  fireEvent.click(screen.getByText('agent.changes.revert'))
  await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalled())
  expect(git.revertTurnChanges).not.toHaveBeenCalled()
  expect(agent.markTurnChangesReverted).not.toHaveBeenCalled()
})

it('warns that a commit stays behind when the turn committed', async () => {
  render(view(changes({ head: 'abc', headChanged: true })))
  fireEvent.click(screen.getByText('agent.changes.revert'))
  await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalled())
  const request = ui.confirm.mock.calls[0][0] as { message: string }
  expect(request.message).toContain('dialog.agentRevert.messageWithCommit')
})

it('does nothing when a queued turn started while the dialog was open', async () => {
  agent.chats.chat.status = 'running'
  render(view())
  fireEvent.click(screen.getByText('agent.changes.revert'))
  await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalled())
  expect(git.revertTurnChanges).not.toHaveBeenCalled()
})

it('drops the action and says so when the baseline snapshot is gone', async () => {
  git.revertTurnChanges.mockResolvedValue('stale')
  const { rerender } = render(view())
  fireEvent.click(screen.getByText('agent.changes.revert'))
  await vi.waitFor(() => expect(agent.markTurnChangesStale).toHaveBeenCalledWith('chat', 'm1'))
  expect(ui.toast).toHaveBeenCalledWith('agent.changes.unavailable', 'error')

  rerender(view(changes({ stale: true })))
  expect(screen.queryByText('agent.changes.revert')).toBeNull()
  expect(screen.getByText('agent.changes.unavailable')).toBeTruthy()
})

it('shows six rows first and expands the rest on demand', () => {
  const files = Array.from({ length: 8 }, (_, index) => ({
    path: `src/file-${index}.ts`, status: 'M' as const, additions: 1, deletions: 0, binary: false,
  }))
  render(view(changes({ files, additions: 8, deletions: 0 })))
  expect(screen.queryByText('src/file-6.ts')).toBeNull()
  fireEvent.click(screen.getByText('agent.changes.showMore'))
  expect(screen.getByText('src/file-6.ts')).toBeTruthy()
  expect(screen.getByText('src/file-7.ts')).toBeTruthy()
  fireEvent.click(screen.getByText('agent.changes.showLess'))
  expect(screen.queryByText('src/file-7.ts')).toBeNull()
})

it('labels binary files and renames without line counts', () => {
  render(view(changes({
    files: [
      { path: 'assets/logo.png', status: 'M', additions: 0, deletions: 0, binary: true },
      { path: 'src/new.ts', oldPath: 'src/old.ts', status: 'R', additions: 1, deletions: 1, binary: false },
    ],
    additions: 1,
    deletions: 1,
  })))
  expect(screen.getByText('agent.changes.binary')).toBeTruthy()
  expect(screen.getByText('src/old.ts → src/new.ts')).toBeTruthy()
})

it('does not offer undo for a truncated file list', () => {
  render(view(changes({ truncated: true })))
  expect(screen.queryByText('agent.changes.revert')).toBeNull()
  expect(screen.getByText('agent.changes.unavailable')).toBeTruthy()
})

it('renders nothing for a turn without file changes', () => {
  const { container } = render(view(changes({ files: [], additions: 0, deletions: 0 })))
  expect(container.textContent).toBe('')
})
