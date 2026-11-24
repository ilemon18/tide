// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { state, getState } = vi.hoisted(() => ({ getState: vi.fn(), state: {
  chats: { chat: { root: '/repo', status: 'idle', currentContext: { contextTokens: 0, contextWindow: 100,
    inputTokens: 90, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10, reasoningOutputTokens: 0, totalTokens: 100 },
    sessionUsage: { inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0, totalTokens: 1000, costUsd: 1.25 },
    messages: [{ role: 'assistant', usage: { contextTokens: 90, contextWindow: 100, inputTokens: 90, outputTokens: 10, totalTokens: 100 } }] } },
} }))
vi.mock('../store/agent', () => ({ useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), {
  getState,
}) }))
vi.mock('../i18n', () => ({ useT: () => (key: string, params?: { percent: number }) => params ? `${params.percent}%` : key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentContextUsage } from './AgentContextUsage'
import { useUi } from '../store/ui'
beforeEach(() => { vi.clearAllMocks(); useUi.setState({ page: 'workspace' }) })
afterEach(() => { cleanup(); useUi.setState({ page: 'workspace' }); vi.useRealTimers() })
it('uses the persisted zero context snapshot and supports popup click, Escape and focus restoration', () => {
  render(<AgentContextUsage chatId="chat" />)
  const button = screen.getByRole('button', { name: /0%/ })
  fireEvent.click(button)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText('agent.context.window')).toBeTruthy()
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(button.getAttribute('aria-expanded')).toBe('false')
  expect(document.activeElement).toBe(button)
})

it('shows actual context and token usage without prices, estimates or a prompt breakdown', () => {
  vi.useFakeTimers()
  render(<AgentContextUsage chatId="chat" />)
  fireEvent.click(screen.getByRole('button', { name: /0%/ }))
  expect(screen.getByText('agent.usage.title')).toBeTruthy()
  expect(screen.getByText('agent.context.used')).toBeTruthy()
  expect(screen.getByText('agent.usage.input')).toBeTruthy()
  expect(screen.getByText('agent.usage.output')).toBeTruthy()
  expect(screen.getByText('agent.usage.total')).toBeTruthy()
  expect(screen.queryByText('agent.usage.latest')).toBeNull()
  for (const label of ['agent.usage.cost', 'agent.usage.costUnavailable', 'agent.context.tokenBreakdown', 'agent.context.prompt']) {
    expect(screen.queryByText(label)).toBeNull()
  }
  expect(screen.queryByText(/\$1\.25|250 tokens/)).toBeNull()
  expect(document.querySelector('.token-estimate-section')).toBeNull()
  vi.advanceTimersByTime(1000)
  expect(getState).not.toHaveBeenCalled()
})

it('uses the same token usage title for a new chat with no usage', () => {
  render(<AgentContextUsage chatId="missing" />)
  fireEvent.click(screen.getByRole('button', { name: /agent.context.unavailable/ }))
  expect(screen.getByText('agent.usage.title')).toBeTruthy()
  expect(screen.queryByText('agent.context.tokenBreakdown')).toBeNull()
  expect(screen.queryByText('agent.usage.cost')).toBeNull()
})


it('does not consume Escape or restore hidden popup focus while the history page is visible', () => {
  render(<AgentContextUsage chatId="chat" />)
  const button = screen.getByRole('button', { name: /0%/ })
  fireEvent.click(button)
  useUi.setState({ page: 'history' })
  const input = document.createElement('input')
  document.body.append(input)
  input.focus()
  const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  input.dispatchEvent(escape)
  expect(escape.defaultPrevented).toBe(false)
  expect(document.activeElement).toBe(input)
  input.remove()
})
