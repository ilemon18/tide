// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../store/agent'

const { resolvePlanAction } = vi.hoisted(() => ({ resolvePlanAction: vi.fn() }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ resolvePlanAction }) } }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({}) } }))
vi.mock('../lib/actions', () => ({ revealInExplorer: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentMarkdown', () => ({ AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div> }))
vi.mock('./AgentTags', () => ({ CommandChip: () => null, SkillChip: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: () => null }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AssistantMessage } from './AgentMessage'

const planMessage = (resolved = false): AgentMessage => ({
  id: 'reply', role: 'assistant', at: 1, readOnly: true,
  items: [
    { id: 'text', type: 'text', text: 'The agreed plan' },
    { id: 'choice', type: 'plan', text: '', resolved },
  ],
})
const view = (message = planMessage(), running = false) => (
  <AssistantMessage chatId="chat" message={message} running={running} pendingQuestionId={null} />
)
beforeEach(() => { resolvePlanAction.mockReset(); resolvePlanAction.mockResolvedValue(true) })
afterEach(cleanup)

it('shows the plan once followed by three next actions and optional instructions', () => {
  render(view())
  expect(screen.getAllByText('The agreed plan')).toHaveLength(1)
  expect(screen.getAllByRole('button')).toHaveLength(3)
  expect(screen.getByRole('textbox', { name: 'agent.plan.instructions' })).toBeTruthy()
})

it('sends refinement instructions, blocks duplicate clicks, and allows retry after rejection', async () => {
  let finish!: (accepted: boolean) => void
  resolvePlanAction.mockReturnValueOnce(new Promise<boolean>(resolve => { finish = resolve }))
  render(view())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep the existing API' } })
  const continueButton = screen.getByRole('button', { name: /agent.plan.continuePlanning/ })
  fireEvent.click(continueButton)
  fireEvent.click(continueButton)
  expect(resolvePlanAction).toHaveBeenCalledTimes(1)
  expect(resolvePlanAction).toHaveBeenCalledWith('chat', 'choice', 'continue-planning', 'Keep the existing API')
  expect((continueButton as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { finish(false) })
  expect((continueButton as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { fireEvent.click(continueButton) })
  expect(resolvePlanAction).toHaveBeenCalledTimes(2)
})

it('disables actions while a turn runs and restores the saved resolved state', () => {
  const { rerender } = render(view(planMessage(), true))
  for (const button of screen.getAllByRole('button')) expect((button as HTMLButtonElement).disabled).toBe(true)
  rerender(view(planMessage(true)))
  expect(screen.queryAllByRole('button')).toHaveLength(0)
  expect(screen.getByText('agent.plan.resolved')).toBeTruthy()
})
