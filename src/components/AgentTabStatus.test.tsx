// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentChat } from '../store/agent'

const { state } = vi.hoisted(() => ({ state: { chats: {} as Record<string, AgentChat>, pages: {} as Record<string, { hasLater: boolean }> } }))
vi.mock('../store/agent', () => ({ useAgent: (select: (value: typeof state) => unknown) => select(state) }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: ({ name, className }: { name: string; className: string }) => <svg data-icon={name} className={className} /> }))
import { AgentTabStatus } from './AgentTabStatus'

const chat = (status: AgentChat['status'], completion?: 'completed' | 'failed' | 'stopped'): AgentChat => ({
  v: 1, id: 'chat', root: '/repo', title: 'Example', provider: 'codex', model: '', effort: '',
  status, sessionId: null, error: null, createdAt: 0, updatedAt: 0,
  messages: [{ id: 'reply', role: 'assistant', at: 0, completion }],
})
afterEach(() => { cleanup(); state.chats = {}; state.pages = {} })

it.each([
  ['running', undefined, 'spinner', 'agent-spinner', 'agent.working'],
  ['idle', 'completed', 'check', 'text-success', 'agent.completion.completed'],
  ['error', 'completed', 'alert-circle', 'text-danger', 'agent.completion.failed'],
  ['cancelled', 'completed', 'stop', 'text-muted', 'agent.completion.stopped'],
  ['idle', 'failed', 'alert-circle', 'text-danger', 'agent.completion.failed'],
] as const)('shows the current %s/%s result', (status, completion, icon, style, label) => {
  state.chats.chat = chat(status, completion)
  const { container } = render(<AgentTabStatus chatId="chat" />)
  expect(screen.getByRole('img', { name: label })).toBeTruthy()
  expect(container.querySelector('svg')?.getAttribute('data-icon')).toBe(icon)
  expect(container.querySelector('svg')?.getAttribute('class')).toContain(style)
})

it('does not infer success for missing, new or historical pages', () => {
  const { rerender } = render(<AgentTabStatus chatId="chat" />)
  expect(screen.queryByRole('img')).toBeNull()
  state.chats.chat = chat('idle')
  rerender(<AgentTabStatus chatId="chat" />)
  expect(screen.queryByRole('img')).toBeNull()
  state.chats.chat = chat('idle', 'completed')
  state.pages.chat = { hasLater: true }
  rerender(<AgentTabStatus chatId="chat" />)
  expect(screen.queryByRole('img')).toBeNull()
  state.pages.chat.hasLater = false
  rerender(<AgentTabStatus chatId="chat" />)
  expect(screen.getByRole('img', { name: 'agent.completion.completed' })).toBeTruthy()
  state.chats.chat = chat('running', 'completed')
  rerender(<AgentTabStatus chatId="chat" />)
  expect(screen.getByRole('img', { name: 'agent.working' })).toBeTruthy()
})
