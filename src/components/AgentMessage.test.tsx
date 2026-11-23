// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentMessage } from '../store/agent'
import { en } from '../i18n/messages/en'

const { resolvePlanAction, answerQuestion } = vi.hoisted(() => ({ resolvePlanAction: vi.fn(), answerQuestion: vi.fn() }))
vi.mock('../store/agent', () => ({ useAgent: Object.assign((select: (state: unknown) => unknown) => select({ running: {} }), { getState: () => ({ resolvePlanAction, answerQuestion }) }) }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({}) } }))
vi.mock('../lib/actions', () => ({ revealInExplorer: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentMarkdown', () => ({ AgentMarkdown: ({ text, root }: { text: string; root?: string }) => <div data-root={root}>{text}</div> }))
vi.mock('./AgentTags', () => ({ CommandChip: () => null, SkillChip: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text, className, label }: { text: string; className: string; label: string }) => label === 'agent.copy.userTurn' ? <button data-testid="user-copy" data-copy={text} className={className} /> : null }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AssistantMessage, serializeAssistantMessage, toolCommand, toolPreview } from './AgentMessage'

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
beforeEach(() => {
  resolvePlanAction.mockReset(); resolvePlanAction.mockResolvedValue(true)
  answerQuestion.mockReset(); answerQuestion.mockResolvedValue(true)
})
afterEach(cleanup)

it('preserves the live status and spinner when streaming updates or inserts content blocks', () => {
  const message: AgentMessage = { id: 'reply', role: 'assistant', at: 1, items: [
    { id: 'text', type: 'text', text: 'Starting' },
  ] }
  const { rerender } = render(view(message, true))
  const status = screen.getByRole('status')
  const spinner = status.querySelector('.agent-spinner')!
  expect(spinner).toBeTruthy()
  const streamed: AgentMessage = { ...message, items: [
    { id: 'text', type: 'text', text: 'Starting to inspect' },
    { id: 'tool', type: 'tool', text: '', title: 'Read', detail: 'src/main.ts', status: 'running' },
    { id: 'after', type: 'text', text: 'Continuing' },
  ] }
  rerender(view(streamed, true))
  expect(screen.getByRole('status')).toBe(status)
  expect(status.querySelector('.agent-spinner')).toBe(spinner)
  rerender(view({ ...streamed, completion: 'completed' }, false))
  expect(status.querySelector('.agent-spinner')).toBeNull()
})

it('passes the conversation workspace to text, reasoning and plan Markdown', () => {
  const message: AgentMessage = { id: 'reply', role: 'assistant', at: 1, items: [
    { id: 'text', type: 'text', text: 'Reply' },
    { id: 'thinking', type: 'thinking', text: 'Reasoning' },
    { id: 'plan', type: 'plan', text: 'Plan', resolved: true },
  ] }
  render(<AssistantMessage chatId="chat" root="/owning-repo" message={message} running={false} pendingQuestionId={null} />)
  for (const text of ['Reply', 'Reasoning', 'Plan']) expect(screen.getByText(text).getAttribute('data-root')).toBe('/owning-repo')
})

it('shows the plan once followed by three next actions and optional instructions', () => {
  render(view())
  expect(screen.getAllByText('The agreed plan')).toHaveLength(1)
  expect(screen.getAllByRole('button')).toHaveLength(3)
  const instructions = screen.getByRole('textbox', { name: 'agent.plan.instructions' })
  for (const button of screen.getAllByRole('button')) {
    expect(button.compareDocumentPosition(instructions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  }
})

it('keeps the official Codex option order wired to the matching persisted actions', async () => {
  const options = [
    ['agent.plan.implementCurrent', 'Yes, implement this plan', 'implement-current'],
    ['agent.plan.implementFresh', 'Yes, clear context and implement', 'implement-fresh'],
    ['agent.plan.continuePlanning', 'No, stay in Plan mode', 'continue-planning'],
  ] as const
  const { unmount } = render(view())
  expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(options.map(([key]) => key))
  unmount()
  for (const [key, label, action] of options) {
    expect(en[key]).toBe(label)
    const card = render(view())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: key })) })
    expect(resolvePlanAction).toHaveBeenLastCalledWith('chat', 'choice', action, '')
    card.unmount()
  }
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

const questionMessage = (multiSelect = false, answer?: string): AgentMessage => ({
  id: 'question-reply', role: 'assistant', at: 1, readOnly: true, planning: true,
  items: [{ id: 'question', type: 'question', text: '', complete: true, header: 'Scope', question: 'Which scope?',
    multiSelect, answer, options: [
      { label: 'Option A', description: 'First scope' },
      { label: 'Option B', description: 'Second scope' },
    ] }],
})
const questionView = (message = questionMessage(), running = false, pendingQuestionId: string | null = 'question') => (
  <AssistantMessage chatId="chat" message={message} running={running} pendingQuestionId={pendingQuestionId} />
)

it('hides structured question options until streaming completes', async () => {
  const streaming = questionMessage()
  streaming.items![0].complete = false
  const { rerender } = render(questionView(streaming, true, null))
  expect(screen.getByText('Which scope?')).toBeTruthy()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  expect(screen.queryByRole('button', { name: 'agent.question.submit' })).toBeNull()
  expect(answerQuestion).not.toHaveBeenCalled()

  rerender(questionView(questionMessage()))
  const option = screen.getByRole('radio', { name: /Option A/ }) as HTMLButtonElement
  const custom = screen.getByRole('textbox') as HTMLInputElement
  const submit = screen.getByRole('button', { name: 'agent.question.submit' }) as HTMLButtonElement
  fireEvent.click(option)
  expect(option.getAttribute('aria-checked')).toBe('true')
  fireEvent.change(custom, { target: { value: 'Custom scope' } })
  expect(option.getAttribute('aria-checked')).toBe('false')
  await act(async () => { fireEvent.click(submit) })
  expect(answerQuestion).toHaveBeenCalledWith('chat', 'question', 'Custom scope')
})

it('does not expose a failed or cancelled question as an interactive card', () => {
  const failed = questionMessage()
  failed.completion = 'failed'
  failed.items![0].complete = false
  const { rerender } = render(questionView(failed, false, null))
  expect(screen.getByText('Which scope?')).toBeTruthy()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
  const stopped = { ...failed, completion: 'stopped' as const }
  rerender(questionView(stopped, false, null))
  expect(screen.queryByRole('button', { name: 'agent.question.submit' })).toBeNull()
})

it.each([
  { mode: 'single', failure: 'declined' },
  { mode: 'multi', failure: 'declined' },
  { mode: 'custom', failure: 'declined' },
  { mode: 'single', failure: 'rejected' },
  { mode: 'multi', failure: 'rejected' },
  { mode: 'custom', failure: 'rejected' },
])('unlocks a $mode answer after a $failure launch and preserves it for one retry', async ({ mode, failure }) => {
  let finish!: (accepted: boolean) => void
  let reject!: (error: Error) => void
  answerQuestion.mockReturnValueOnce(new Promise<boolean>((resolve, rejectPromise) => { finish = resolve; reject = rejectPromise }))
  const message = questionMessage(mode === 'multi')
  const { rerender } = render(questionView(message))
  const role = mode === 'multi' ? 'checkbox' : 'radio'
  if (mode !== 'custom') fireEvent.click(screen.getByRole(role, { name: /Option A/ }))
  if (mode === 'multi') fireEvent.click(screen.getByRole(role, { name: /Option B/ }))
  if (mode !== 'single') fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Extra scope' } })
  const answer = mode === 'single' ? 'Option A' : mode === 'multi' ? 'Option A\nOption B\nExtra scope' : 'Extra scope'
  const submit = screen.getByRole('button', { name: 'agent.question.submit' })
  fireEvent.click(submit)
  fireEvent.click(submit)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(answerQuestion).toHaveBeenCalledTimes(1)
  expect(answerQuestion).toHaveBeenLastCalledWith('chat', 'question', answer)
  for (const option of screen.getAllByRole(role)) expect((option as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
  expect((submit as HTMLButtonElement).disabled).toBe(true)

  // The store first saves the answer, then restores the same mounted card on launch failure.
  rerender(questionView(questionMessage(mode === 'multi', answer), true, null))
  expect(screen.getByText('agent.question.answered')).toBeTruthy()
  expect(screen.queryByRole('textbox')).toBeNull()
  rerender(questionView(message))
  expect((screen.getByRole('button', { name: 'agent.question.submit' }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => {
    if (failure === 'rejected') reject(new Error('offline'))
    else finish(false)
  })

  for (const option of screen.getAllByRole(role)) {
    expect((option as HTMLButtonElement).disabled).toBe(false)
    expect(option.getAttribute('aria-checked')).toBe(String(mode !== 'custom' && (mode === 'multi' || option.textContent?.includes('Option A'))))
  }
  expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe(mode === 'single' ? '' : 'Extra scope')
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(false)
  expect((screen.getByRole('button', { name: 'agent.question.submit' }) as HTMLButtonElement).disabled).toBe(false)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'agent.question.submit' })) })
  expect(answerQuestion).toHaveBeenCalledTimes(2)
  expect(answerQuestion).toHaveBeenLastCalledWith('chat', 'question', answer)
})

it('keeps inactive questions locked and answered questions in their saved display', () => {
  const { rerender } = render(questionView(questionMessage(), false, 'another-question'))
  for (const option of screen.getAllByRole('radio')) expect((option as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('textbox') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'agent.question.submit' }) as HTMLButtonElement).disabled).toBe(true)
  rerender(questionView(questionMessage(false, 'Option A'), false, null))
  expect(screen.getByText('agent.question.answered')).toBeTruthy()
  expect(screen.getByText('Option A')).toBeTruthy()
  expect(screen.queryByRole('radio')).toBeNull()
  expect(screen.queryByRole('textbox')).toBeNull()
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

it('extracts command paths and never splits surrogate pairs in previews', () => {
  expect(toolCommand({ id: 't', type: 'tool', text: '', title: 'Read', detail: '{"file_path":"src/main.rs"}' })).toBe('src/main.rs')
  const preview = toolPreview('🙂'.repeat(400), 2)
  expect(preview.clipped).toBe(true)
  expect(preview.text).toBe('🙂'.repeat(360) + '\n…')
})
