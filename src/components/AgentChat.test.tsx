// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentChat as Chat } from '../store/agent'
import type { AgentChatPage } from '../lib/ipc'
const { state, initialChat } = vi.hoisted(() => {
  const initialChat: Chat = { v: 1, id: 'chat', title: 'Example', root: '/repo', provider: 'codex', model: '', effort: '',
    status: 'running', sessionId: null, error: null, createdAt: 0, updatedAt: 0,
    messages: [{ id: 'reply', role: 'assistant', at: 0, items: [{ id: 'text', type: 'text', text: 'Latest output' }] }],
  }
  return { initialChat, state: {
    chats: { chat: initialChat }, pages: {} as Record<string, Partial<AgentChatPage>>,
    pageLoading: {} as Record<string, boolean>, loadingChats: {} as Record<string, boolean>,
    running: { chat: Date.now() }, chatDrafts: {}, queues: {}, focusRequests: {}, localPicker: null,
    providers: [{ id: 'codex', installed: true, supported: true }],
  } }
})
vi.mock('../store/agent', () => ({
  useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), { getState: () => ({ loadCatalog: vi.fn() }) }),
  chatTabId: (id: string) => `chat:${id}`, findPendingQuestion: () => null, findPendingPlanAction: () => null,
}))
vi.mock('../store/tabs', () => ({ useTabs: (select: (state: unknown) => unknown) => select({ activeId: 'chat:chat' }) }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select({ agentEnabled: true }) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('../lib/actions', () => ({ openSettings: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentComposer', () => ({ AgentComposer: ({ outlined }: { outlined: boolean }) => <input aria-label="composer" data-outlined={outlined} /> }))
vi.mock('./AgentMessage', () => ({ AssistantMessage: ({ root }: { root: string }) => <div data-root={root}>Latest output</div>, UserMessage: () => null }))
vi.mock('./AgentContextUsage', () => ({ AgentContextUsage: () => null }))
vi.mock('./AgentPickers', () => ({ ModelPicker: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentChat } from './AgentChat'
beforeEach(() => {
  state.chats.chat = structuredClone(initialChat)
  state.pages = {}
  state.pageLoading = {}
  state.loadingChats = {}
  state.providers = [{ id: 'codex', installed: true, supported: true }]
})
afterEach(cleanup)
it('keeps the transcript before the composer without a separate running strip', () => {
  const { container } = render(<AgentChat chatId="chat" />)
  const output = screen.getByText('Latest output')
  expect(screen.queryByText('agent.status.running')).toBeNull()
  expect(output.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('.overflow-y-auto')?.contains(output)).toBe(true)
  expect(output.getAttribute('data-root')).toBe('/repo')
})

it('keeps the conversation title and provider without a duplicate result label', () => {
  state.chats.chat.status = 'error'
  render(<AgentChat chatId="chat" />)
  expect(screen.getByText('Example')).toBeTruthy()
  expect(screen.getByText('codex')).toBeTruthy()
  expect(screen.queryByText('agent.status.failed')).toBeNull()
})

function emptyChat() {
  state.chats.chat = { ...state.chats.chat, status: 'idle', messages: [] }
}

it('centers the welcome title above the framed composer and reuses its input after the first message', () => {
  emptyChat()
  const { rerender } = render(<AgentChat chatId="chat" />)
  const title = screen.getByRole('heading', { name: 'agent.empty' })
  const input = screen.getByRole('textbox')
  expect(title.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(input.getAttribute('data-outlined')).toBe('true')
  expect(input.closest('.my-auto')).toBeTruthy()
  expect(input.closest('.border-t')).toBeNull()
  input.focus()
  state.chats.chat = structuredClone(initialChat)
  rerender(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
  expect(screen.getByRole('textbox')).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('data-outlined')).toBe('false')
  expect(input.closest('.border-t')).toBeTruthy()
})

it.each([
  { total: 10 }, { hasEarlier: true }, { hasLater: true },
  { hasPendingQuestion: true }, { hasUnhandledPlanAction: true },
])('does not show a new conversation for unloaded history: %j', page => {
  emptyChat()
  state.pages.chat = page
  render(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
  expect(screen.getByRole('textbox').getAttribute('data-outlined')).toBe('false')
})

it.each(['loading', 'paging', 'running', 'session'] as const)('does not show a new conversation during %s', phase => {
  emptyChat()
  if (phase === 'loading') state.loadingChats.chat = true
  if (phase === 'paging') state.pageLoading.chat = true
  if (phase === 'running') state.chats.chat.status = 'running'
  if (phase === 'session') state.chats.chat.sessionId = 'existing-session'
  render(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
})

it('keeps errors and missing-provider guidance visible in the centered layout', () => {
  emptyChat()
  state.chats.chat.error = 'Launch failed'
  state.providers[0].installed = false
  render(<AgentChat chatId="chat" />)
  expect(screen.getByRole('alert').textContent).toBe('Launch failed')
  expect(screen.getByText('agent.providerMissing')).toBeTruthy()
  expect(screen.getByRole('textbox').getAttribute('data-outlined')).toBe('true')
})
