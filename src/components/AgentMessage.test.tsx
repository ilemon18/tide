// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../store/agent'

const { resolvePlanAction } = vi.hoisted(() => ({ resolvePlanAction: vi.fn() }))
vi.mock('../store/agent', () => ({ useAgent: Object.assign((select: (state: unknown) => unknown) => select({ running: {} }), { getState: () => ({ resolvePlanAction }) }) }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({}) } }))
vi.mock('../lib/actions', () => ({ revealInExplorer: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentMarkdown', () => ({ AgentMarkdown: ({ text }: { text: string }) => <div>{text}</div> }))
vi.mock('./AgentTags', () => ({ CommandChip: () => null, SkillChip: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text, className, label }: { text: string; className: string; label: string }) => label === 'agent.copy.userTurn' ? <button data-testid="user-copy" data-copy={text} className={className} /> : null }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AssistantMessage, UserMessage, serializeUserMessage, serializeAssistantMessage, toolCommand, toolPreview } from './AgentMessage'

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

it('keeps tool previews and public reasoning in source order without details wrappers', () => {
  const message: AgentMessage = { id: 'stream', role: 'assistant', at: 1, completion: 'completed', durationMs: 1234,
    items: [
      { id: 'a', type: 'text', text: 'Before' },
      { id: 'r', type: 'thinking', text: 'Inspecting files' },
      { id: 't', type: 'tool', text: '', title: 'Bash', detail: '{"command":"pwd"}', output: 'one\ntwo\nthree\nfour', status: 'ok' },
      { id: 'b', type: 'text', text: 'After' },
    ] }
  const { container, rerender } = render(view(message))
  expect(container.firstElementChild?.className).toContain('group/reply')
  expect(container.firstElementChild?.className).not.toContain('group/item')
  expect(container.querySelector('.group\\/item')?.className).toContain('group/item')
  expect(container.querySelector('details')).toBeNull()
  expect(screen.getByText('pwd')).toBeTruthy()
  expect(screen.getByText('Inspecting files')).toBeTruthy()
  expect(screen.queryByText(/four/)).toBeNull()
  expect(screen.getByText('Before').compareDocumentPosition(screen.getByText('pwd')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'agent.output.expand' }))
  expect(screen.getByRole('button', { name: 'agent.output.collapse' }).className).toContain('cursor-pointer')
  expect(screen.getByRole('button', { name: 'agent.output.collapse' }).className).toContain('hover:bg-hover')
  expect(screen.getByText(/four/)).toBeTruthy()
  rerender(view({ ...message, items: message.items!.map(item => item.id === 't' ? { ...item, output: item.output + '\nfive' } : item) }))
  expect(screen.getByText(/five/)).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('agent.completion.completed')
  expect(screen.getByText('After').compareDocumentPosition(screen.getByRole('status')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(serializeAssistantMessage(message)).toContain('four')
})

it('right-aligns a shrink-wrapped user bubble and keeps indentation and full copy metadata', () => {
  const message: AgentMessage = { id: 'u', role: 'user', at: 1, text: '  first\n    second\n',
    mentions: [{ rel: 'src/a.ts', isDir: false }], skills: [{ name: 'audit', path: '/skills/audit', source: 'user' }] }
  const { container } = render(<UserMessage root="/repo" message={message} />)
  expect(container.firstElementChild?.className).toContain('ml-auto')
  expect(container.firstElementChild?.className).toContain('w-fit')
  expect(screen.getByTestId('user-copy').className).toContain('absolute right-1 top-1')
  expect(screen.getByTestId('user-copy').className).toContain('h-[22px] w-[22px]')
  expect(screen.getByTestId('user-copy').className).toContain('pointer-events-none')
  expect(screen.getByTestId('user-copy').getAttribute('data-copy')).toBe(serializeUserMessage(message))
  expect(serializeUserMessage(message)).toBe('$audit (/skills/audit)\n@src/a.ts\n  first\n    second\n')
})

it('extracts command paths and never splits surrogate pairs in previews', () => {
  expect(toolCommand({ id: 't', type: 'tool', text: '', title: 'Read', detail: '{"file_path":"src/main.rs"}' })).toBe('src/main.rs')
  const preview = toolPreview('🙂'.repeat(400), 2)
  expect(preview.clipped).toBe(true)
  expect(preview.text).toBe('🙂'.repeat(360) + '\n…')
})
