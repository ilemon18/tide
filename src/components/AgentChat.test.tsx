// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const { state } = vi.hoisted(() => ({ state: {
  chats: { chat: { id: 'chat', title: 'Example', root: '/repo', provider: 'codex', model: '', effort: '', status: 'running',
    messages: [{ id: 'reply', role: 'assistant', at: 0, items: [{ id: 'text', type: 'text', text: 'Latest output' }] }] } },
  pages: {}, pageLoading: {}, loadingChats: {}, running: { chat: Date.now() }, chatDrafts: {}, queues: {},
  focusRequests: {}, localPicker: null, providers: [{ id: 'codex', installed: true, supported: true }],
} }))
vi.mock('../store/agent', () => ({
  useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), { getState: () => ({ loadCatalog: vi.fn() }) }),
  chatTabId: (id: string) => `chat:${id}`, findPendingQuestion: () => null, findPendingPlanAction: () => null,
}))
vi.mock('../store/tabs', () => ({ useTabs: (select: (state: unknown) => unknown) => select({ activeId: 'chat:chat' }) }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select({ agentEnabled: true }) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('../lib/actions', () => ({ openSettings: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentComposer', () => ({ AgentComposer: () => <div data-testid="composer" /> }))
vi.mock('./AgentMessage', () => ({ AssistantMessage: () => <div>Latest output</div>, UserMessage: () => null }))
vi.mock('./AgentContextUsage', () => ({ AgentContextUsage: () => null }))
vi.mock('./AgentPickers', () => ({ ModelPicker: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentChat } from './AgentChat'
afterEach(cleanup)
it('places running activity after the latest transcript output and before the composer', () => {
  const { container } = render(<AgentChat chatId="chat" />)
  const output = screen.getByText('Latest output')
  const status = screen.getByText('agent.status.running')
  expect(output.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(status.compareDocumentPosition(screen.getByTestId('composer')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('.overflow-y-auto')?.contains(status)).toBe(true)
})
