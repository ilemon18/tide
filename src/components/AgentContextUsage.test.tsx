// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const { state } = vi.hoisted(() => ({ state: {
  chats: { chat: { root: '/repo', status: 'idle', currentContext: { contextTokens: 0, contextWindow: 100,
    inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, costUsd: null },
    messages: [{ role: 'assistant', usage: { contextTokens: 90, contextWindow: 100 } }] } },
  chatDrafts: {}, tokenEstimates: {},
} }))
vi.mock('../store/agent', () => ({ useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), {
  getState: () => ({ updateTokenEstimate: vi.fn() }),
}) }))
vi.mock('../i18n', () => ({ useT: () => (key: string, params?: { percent: number }) => params ? `${params.percent}%` : key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentContextUsage } from './AgentContextUsage'
afterEach(cleanup)
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
