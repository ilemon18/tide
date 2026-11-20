// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../store/agent'

vi.mock('../i18n', () => ({ useT: () => (key: string, params?: { duration: string }) =>
  key === 'agent.completion.duration' ? `Duration ${params?.duration}` : key }))
vi.mock('./Icon', () => ({ Icon: ({ className }: { className?: string }) => <svg data-testid="status-icon" className={className} /> }))
import { AgentTurnStatus } from './AgentTurnStatus'

const message: AgentMessage = {
  id: 'reply', role: 'assistant', at: 1, completion: 'completed', durationMs: 65_000,
}

afterEach(() => { cleanup(); vi.useRealTimers() })

it.each([
  { hours: 9, minutes: 5, time: '09:05' },
  { hours: 15, minutes: 42, time: '15:42' },
  { hours: 0, minutes: 0, time: '00:00' },
])('appends the local completion time as $time after the duration', ({ hours, minutes, time }) => {
  const completedAt = new Date(2026, 10, 20, hours, minutes).getTime()
  render(<AgentTurnStatus message={{ ...message, completedAt }} running={false} />)
  expect(screen.getByRole('status').textContent).toBe(`agent.completion.completed · Duration 1m 05s · ${time}`)
})

it('keeps the recorded completion time after reopening later', () => {
  vi.useFakeTimers()
  const completed = { ...message, completedAt: new Date(2026, 10, 20, 9, 5).getTime() }
  const view = render(<AgentTurnStatus message={completed} running={false} />)
  view.unmount()
  vi.setSystemTime(new Date(2026, 10, 21, 16, 30))
  render(<AgentTurnStatus message={completed} running={false} />)
  expect(screen.getByRole('status').textContent).toBe('agent.completion.completed · Duration 1m 05s · 09:05')
})

it.each([undefined, NaN])('omits unavailable completion timestamps (%s) in older history', completedAt => {
  render(<AgentTurnStatus message={{ ...message, completedAt }} running={false} />)
  expect(screen.getByRole('status').textContent).toBe('agent.completion.completed · Duration 1m 05s')
})

it('does not show a completion time while the turn is running', () => {
  render(<AgentTurnStatus message={{ ...message, completedAt: new Date(2026, 10, 20, 9, 5).getTime() }} running />)
  expect(screen.getByRole('status').textContent).toBe('agent.working · Duration 0s')
  expect(screen.getByTestId('status-icon').getAttribute('class')).toContain('agent-spinner')
})
