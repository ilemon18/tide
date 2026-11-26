// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentHistory } from '../store/agent'

const { state, actions, workspace, ui } = vi.hoisted(() => ({
  state: {
    historyByRoot: {} as Record<string, AgentHistory>,
    providers: [{ id: 'codex', name: 'Codex' }],
    running: {} as Record<string, number>,
    chats: {} as Record<string, { status: string }>,
    deletingChats: {} as Record<string, boolean>, resumingChatId: null as string | null,
  },
  actions: { loadHistory: vi.fn(), clearHistory: vi.fn(), resumeChat: vi.fn(), deleteChat: vi.fn() },
  workspace: { activeRootId: '/repo', roots: [{ id: '/repo', name: 'Example project', lifetime: Symbol('/repo') }] },
  ui: { historyOpen: true, historySearchFocus: 0, closeHistory: vi.fn(), toast: vi.fn(), confirm: vi.fn() },
}))

vi.mock('../store/agent', () => ({
  AGENT_HISTORY_PAGE_SIZE: 15,
  useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), { getState: () => ({ ...state, ...actions }) }),
}))
vi.mock('../store/workspace', () => ({ useWorkspace: (select: (state: unknown) => unknown) => select(workspace) }))
vi.mock('../store/ui', () => ({ useUi: Object.assign((select: (state: unknown) => unknown) => select(ui), { getState: () => ui }) }))
vi.mock('../i18n', () => ({ useT: () => (key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${Object.values(params).join(' ')}` : key }))
import { AgentHistoryPage } from './AgentHistoryPage'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const summary = (id = 'saved', provider = 'codex', updatedAt = NOW - 30_000) => ({ id, provider, root: '/repo', title: 'Saved conversation', model: '', updatedAt, messageCount: 2 })
const history = (patch: Partial<AgentHistory> = {}): AgentHistory => ({
  chats: [summary()], page: 1, query: '', total: 16, loaded: true, loading: false, error: false, ...patch,
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.clearAllMocks()
  state.historyByRoot = { '/repo': history() }
  state.running = {}
  state.chats = {}
  state.deletingChats = {}
  state.resumingChatId = null
  workspace.roots = [{ id: '/repo', name: 'Example project', lifetime: Symbol('/repo') }]
  workspace.activeRootId = '/repo'
  ui.historyOpen = true
  ui.historySearchFocus = 0
  ui.confirm.mockResolvedValue(false)
  actions.resumeChat.mockResolvedValue(true)
  actions.deleteChat.mockResolvedValue(true)
})
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers() })

it('shows the project and provider icon before the conversation name, and releases summaries on exit', () => {
  const { container, unmount } = render(<AgentHistoryPage />)
  expect(screen.getByRole('complementary', { name: 'agent.history.title' })).toBeTruthy()
  expect(screen.getByText('Example project')).toBeTruthy()
  expect(actions.loadHistory).toHaveBeenCalledExactlyOnceWith('/repo', { page: 1, query: '' })
  const row = screen.getByRole('button', { name: 'agent.history.open Saved conversation' })
  const logo = row.querySelector<HTMLElement>('[style*="mask-image"]')!
  expect(logo).toBeTruthy()
  expect(logo.getAttribute('style')).toContain('codex')
  expect(logo.compareDocumentPosition(screen.getByText('Saved conversation')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(row.getAttribute('title')).toBe('Saved conversation')
  expect(screen.getByText('30s')).toBeTruthy()
  expect(screen.queryByText('Codex')).toBeNull()
  expect(screen.queryByText('saved')).toBeNull()
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  actions.clearHistory.mockClear()
  unmount()
  expect(actions.clearHistory).toHaveBeenCalledOnce()
})

it('uses the generic Agent icon when a provider has no registered logo', () => {
  state.historyByRoot['/repo'] = history({ chats: [summary('unknown', 'custom-agent')] })
  render(<AgentHistoryPage />)
  const row = screen.getByRole('button', { name: 'agent.history.open Saved conversation' })
  expect(row.querySelector('img')).toBeNull()
  expect(row.querySelector('svg')).toBeTruthy()
})

it('does not expose provider text or the ID when the conversation uses the localized empty-title fallback', () => {
  state.historyByRoot['/repo'] = history({ chats: [{ ...summary(), title: '' }] })
  render(<AgentHistoryPage />)
  const row = screen.getByRole('button', { name: 'agent.history.open agent.newChat' })
  expect(row.getAttribute('title')).toBe('agent.newChat')
  expect(screen.queryByText('Codex')).toBeNull()
  expect(screen.queryByText('saved')).toBeNull()
})

it('shows compact relative ages with absolute tooltips and refreshes them while mounted', () => {
  state.historyByRoot['/repo'] = history({
    chats: [
      summary('seconds', 'codex', NOW - 30_000),
      summary('days', 'codex', NOW - 2 * 86_400_000),
      summary('longer', 'codex', NOW - 10 * 86_400_000),
      summary('months', 'codex', NOW - 60 * 86_400_000),
    ],
  })
  render(<AgentHistoryPage />)
  const expectedTooltip = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(NOW - 30_000))
  expect(screen.getByText('30s').getAttribute('title')).toBe(expectedTooltip)
  expect(screen.getByText('2d')).toBeTruthy()
  expect(screen.getByText('10d')).toBeTruthy()
  expect(screen.getByText('2m')).toBeTruthy()
  act(() => { vi.advanceTimersByTime(30_000) })
  expect(screen.getByText('1min')).toBeTruthy()
})

it('navigates to a selected conversation and keeps deletion a separate action', async () => {
  render(<AgentHistoryPage />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'agent.history.open Saved conversation' })) })
  expect(actions.resumeChat).toHaveBeenCalledExactlyOnceWith('saved', '/repo')
  expect(actions.deleteChat).not.toHaveBeenCalled()
})

it('retains the page after a failed restore and allows selecting the conversation again', async () => {
  actions.resumeChat.mockResolvedValueOnce(false)
  render(<AgentHistoryPage />)
  const open = screen.getByRole('button', { name: 'agent.history.open Saved conversation' })
  await act(async () => { fireEvent.click(open) })
  expect(ui.closeHistory).not.toHaveBeenCalled()
  expect(ui.toast).toHaveBeenCalledWith('agent.missingChat', 'error')
  await act(async () => { fireEvent.click(open) })
  expect(actions.resumeChat).toHaveBeenCalledTimes(2)
})

it.each([false, true])('requires confirmation before deleting (confirmed=%s)', async confirmed => {
  ui.confirm.mockResolvedValueOnce(confirmed)
  render(<AgentHistoryPage />)
  const trigger = screen.getByRole('button', { name: 'agent.history.delete Saved conversation' })
  await act(async () => { fireEvent.click(trigger) })
  expect(ui.confirm).toHaveBeenCalledWith({ title: 'agent.history.deleteTitle', message: 'agent.history.deleteMessage Saved conversation',
    confirmText: 'agent.history.deleteTitle', danger: true, confirmOnEnter: true })
  if (confirmed) expect(actions.deleteChat).toHaveBeenCalledExactlyOnceWith('saved', '/repo')
  else expect(actions.deleteChat).not.toHaveBeenCalled()
  expect(actions.resumeChat).not.toHaveBeenCalled()
  expect(document.activeElement).toBe(trigger)
})

it('blocks repeated delete confirmations while a decision is pending', async () => {
  let answer!: (confirmed: boolean) => void
  ui.confirm.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
  render(<AgentHistoryPage />)
  const trigger = screen.getByRole('button', { name: 'agent.history.delete Saved conversation' })
  fireEvent.click(trigger)
  fireEvent.click(trigger)
  expect(ui.confirm).toHaveBeenCalledOnce()
  await act(async () => { answer(false) })
  expect(actions.deleteChat).not.toHaveBeenCalled()
})

it('disables deletion for running or deleting chats and locks selection during restore', () => {
  state.running = { saved: 1 }
  const { rerender } = render(<AgentHistoryPage />)
  const remove = () => screen.getByRole('button', { name: 'agent.history.delete Saved conversation' }) as HTMLButtonElement
  expect(remove().disabled).toBe(true)
  state.running = {}
  state.deletingChats = { saved: true }
  rerender(<AgentHistoryPage />)
  expect(remove().disabled).toBe(true)
  state.deletingChats = {}
  state.resumingChatId = 'saved'
  rerender(<AgentHistoryPage />)
  expect((screen.getByRole('button', { name: 'agent.history.open Saved conversation' }) as HTMLButtonElement).disabled).toBe(true)
})

it('debounces name search, resets to page one and loads clearing immediately', () => {
  state.historyByRoot['/repo'] = history({ page: 2 })
  render(<AgentHistoryPage />)
  actions.loadHistory.mockClear()
  const input = screen.getByRole('searchbox')
  fireEvent.change(input, { target: { value: '  Saved chat  ' } })
  expect(actions.clearHistory).toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(249) })
  expect(actions.loadHistory).not.toHaveBeenCalled()
  act(() => { vi.advanceTimersByTime(1) })
  expect(actions.loadHistory).toHaveBeenCalledExactlyOnceWith('/repo', { page: 1, query: 'Saved chat' })
  fireEvent.change(input, { target: { value: '' } })
  expect(actions.loadHistory).toHaveBeenLastCalledWith('/repo', { page: 1, query: '' })
})

it('does not search incomplete IME text or allow its timer to survive a project switch', () => {
  const { rerender } = render(<AgentHistoryPage />)
  actions.loadHistory.mockClear()
  const input = screen.getByRole('searchbox')
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: '\u4e2d' } })
  act(() => { vi.advanceTimersByTime(500) })
  expect(actions.loadHistory).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input, { data: '\u4e2d' })
  act(() => { vi.advanceTimersByTime(250) })
  expect(actions.loadHistory).toHaveBeenCalledExactlyOnceWith('/repo', { page: 1, query: '\u4e2d' })
  actions.loadHistory.mockClear()
  fireEvent.change(input, { target: { value: 'old project' } })
  workspace.roots = [{ id: '/other', name: 'Other project', lifetime: Symbol('/other') }]
  workspace.activeRootId = '/other'
  rerender(<AgentHistoryPage />)
  act(() => { vi.advanceTimersByTime(500) })
  expect(actions.loadHistory).toHaveBeenCalledExactlyOnceWith('/other', { page: 1, query: '' })
})

it('resets search when the same workspace path has a new symbol lifetime', () => {
  const { rerender } = render(<AgentHistoryPage />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'old search' } })
  actions.loadHistory.mockClear()
  workspace.roots = [{ ...workspace.roots[0], lifetime: Symbol('/repo') }]
  rerender(<AgentHistoryPage />)
  act(() => { vi.advanceTimersByTime(500) })
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  expect(actions.loadHistory).toHaveBeenCalledExactlyOnceWith('/repo', { page: 1, query: '' })
})

it('shows page navigation and requests the selected page', () => {
  state.historyByRoot['/repo'] = history({ page: 2, total: 31 })
  render(<AgentHistoryPage />)
  expect(screen.getByText('agent.history.page 2 3')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.previous' }))
  expect(actions.loadHistory).toHaveBeenLastCalledWith('/repo', { page: 1 })
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.next' }))
  expect(actions.loadHistory).toHaveBeenLastCalledWith('/repo', { page: 3 })
})

it.each([0, 15, 16, 30, 31])('shows page counts and boundary controls for %s records', total => {
  state.historyByRoot['/repo'] = history({ total })
  const { rerender } = render(<AgentHistoryPage />)
  const pages = Math.max(1, Math.ceil(total / 15))
  const previous = () => screen.getByRole('button', { name: 'agent.history.previous' }) as HTMLButtonElement
  const next = () => screen.getByRole('button', { name: 'agent.history.next' }) as HTMLButtonElement
  expect(screen.getByText(`agent.history.page 1 ${pages}`)).toBeTruthy()
  expect(previous().disabled).toBe(true)
  expect(next().disabled).toBe(pages === 1)
  state.historyByRoot['/repo'] = history({ total, page: pages })
  rerender(<AgentHistoryPage />)
  expect(previous().disabled).toBe(pages === 1)
  expect(next().disabled).toBe(true)
})

it('focuses and selects the page search when Find is requested', () => {
  const { rerender } = render(<AgentHistoryPage />)
  const input = screen.getByRole('searchbox') as HTMLInputElement
  fireEvent.change(input, { target: { value: 'keyword' } })
  screen.getByRole('button', { name: 'agent.history.close' }).focus()
  ui.historySearchFocus++
  rerender(<AgentHistoryPage />)
  expect(document.activeElement).toBe(input)
  expect(input.value).toBe('keyword')
  expect(input.selectionStart).toBe(0)
  expect(input.selectionEnd).toBe('keyword'.length)
})

it.each([
  { patch: { chats: [], total: 0 }, label: 'agent.history.empty' },
  { patch: { chats: [], total: 0, error: true }, label: 'agent.history.retry' },
  { patch: { chats: [], total: 0, loading: true }, label: 'agent.history.loading' },
])('renders the $label state', ({ patch, label }) => {
  state.historyByRoot['/repo'] = history(patch)
  render(<AgentHistoryPage />)
  expect(screen.getByText(label)).toBeTruthy()
})

it('shows no results for a keyword and supports retry after a list failure', () => {
  state.historyByRoot['/repo'] = history({ chats: [], total: 0 })
  const { rerender } = render(<AgentHistoryPage />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  act(() => { vi.advanceTimersByTime(250) })
  expect(screen.getByText('agent.history.noResults')).toBeTruthy()
  state.historyByRoot['/repo'] = history({ chats: [], total: 0, error: true })
  rerender(<AgentHistoryPage />)
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.retry' }))
  expect(actions.loadHistory).toHaveBeenLastCalledWith('/repo')
})

it('explains the missing project without querying history and can close the drawer', () => {
  workspace.roots = []
  render(<AgentHistoryPage />)
  expect(screen.getByText('agent.history.noProject')).toBeTruthy()
  expect(actions.loadHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.close' }))
  expect(ui.closeHistory).toHaveBeenCalledOnce()
})

it('closes the drawer from its close button and Escape, and restores the opener on unmount', () => {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  const { unmount } = render(<AgentHistoryPage />)
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.close' }))
  expect(ui.closeHistory).toHaveBeenCalledOnce()
  fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
  expect(ui.closeHistory).toHaveBeenCalledTimes(2)
  unmount()
  expect(document.activeElement).toBe(opener)
  opener.remove()
})
