// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../store/agent', () => ({ useAgent: Object.assign((select: (state: unknown) => unknown) => select({ skillsByRoot: { '/repo': [{ name: 'audit', path: 'skills/audit', source: 'project', description: 'Inspect' }] }, skillsLoading: {} }), { getState: () => ({ loadSkills: vi.fn() }) }) }))
vi.mock('../store/fileIndex', () => ({ useFileIndex: Object.assign((select: (state: unknown) => unknown) => select({ byRoot: { '/repo': { files: ['src/a.ts'] } }, indexing: {} }), { getState: () => ({ ensure: vi.fn() }) }) }))
const { settings } = vi.hoisted(() => ({ settings: { agentComposerHeight: 90 } }))
vi.mock('../store/settings', () => ({
  AGENT_COMPOSER_MAX_HEIGHT: 480, AGENT_COMPOSER_MIN_HEIGHT: 90,
  useSettings: (select: (state: unknown) => unknown) => select(settings),
}))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }))
vi.mock('./AgentPickers', () => ({ AgentPicker: () => null, ModelPicker: () => null, EffortPicker: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentComposer } from './AgentComposer'
import { en } from '../i18n/messages/en'
import { zhCN } from '../i18n/messages/zh-CN'
afterEach(() => { cleanup(); settings.agentComposerHeight = 90; vi.unstubAllGlobals() })
it('orders context, stop and send and allows a standalone plan toggle', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const onChange = vi.fn()
  const view = render(<AgentComposer root="/repo" draft="/plan" mentions={[]} skills={[]} provider="codex" model="" effort=""
    running contextUsage={<button aria-label="context" />} onDraft={onChange} onMentions={onChange} onCommand={onChange}
    onSkills={onChange} onProvider={onChange} onModel={onChange} onEffort={onChange} onStop={onChange} onSend={onChange} />)
  const buttons = [...view.container.querySelectorAll('button')]
  expect(buttons.indexOf(screen.getByLabelText('context'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.stop')))
  expect(buttons.indexOf(screen.getByLabelText('agent.stop'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.queue.send')))
  expect((screen.getByLabelText('agent.queue.send') as HTMLButtonElement).disabled).toBe(false)
  vi.unstubAllGlobals()
})

function composer(overrides: Partial<React.ComponentProps<typeof AgentComposer>> = {}) {
  const onSend = vi.fn(), onCommand = vi.fn(), onMentions = vi.fn(), onDraft = vi.fn()
  const view = render(<AgentComposer root="/repo" draft="hello" mentions={[]} skills={[]} provider="codex" model="" effort=""
    running={false} onDraft={onDraft} onMentions={onMentions} onCommand={onCommand}
    onSkills={vi.fn()} onProvider={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} onStop={vi.fn()}
    onSend={onSend} {...overrides} />)
  return { ...view, input: screen.getByRole('textbox'), onSend, onCommand, onMentions, onDraft }
}

it('sends Enter and modifier Enter, keeps Shift+Enter, and ignores repeated Enter', () => {
  const { input, onSend } = composer()
  fireEvent.keyDown(input, { key: 'Enter' })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  fireEvent.keyDown(input, { key: 'Enter', shiftKey: true })
  fireEvent.keyDown(input, { key: 'Enter', repeat: true })
  expect(onSend).toHaveBeenCalledTimes(3)
})

it.each(['中文', '日本語'])('prioritizes %s composition over sends and tag removal including WebKit end ordering', text => {
  const { input, onSend, onMentions } = composer({ draft: 'hello', mentions: [{ rel: 'a.ts', isDir: false }] })
  fireEvent.compositionStart(input)
  fireEvent.change(input, { target: { value: text } })
  fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })
  fireEvent.keyDown(input, { key: 'Backspace' })
  expect(onMentions).not.toHaveBeenCalled()
  fireEvent.compositionEnd(input)
  fireEvent.keyDown(input, { key: 'Enter', metaKey: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 })
  expect(onSend).not.toHaveBeenCalled()
})

it('selects a command candidate on Enter before sending', () => {
  const { input, onSend, onCommand } = composer({ draft: '/plan' })
  fireEvent.change(input, { target: { value: '/pla', selectionStart: 4 } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onCommand).toHaveBeenCalledWith('plan')
  expect(onSend).not.toHaveBeenCalled()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledOnce()
})

it('renders command candidates as a floating layer without changing the composer structure', () => {
  const { input, container } = composer({ draft: '/pl' })
  fireEvent.change(input, { target: { value: '/pla', selectionStart: 4 } })
  const candidate = screen.getByText('/plan')
  const popup = candidate.closest('div')
  expect(popup?.classList.contains('absolute')).toBe(true)
  expect(popup?.classList.contains('bottom-full')).toBe(true)
  expect(container.querySelector('textarea')).toBe(input)
  expect(screen.getByRole('button', { name: 'agent.send' })).toBeTruthy()
})

it.each([{ draft: '  ' }, { pendingQuestion: true }, { pendingPlan: true }])('keeps empty and pending-card send guards: %j', options => {
  const { input, onSend } = composer(options)
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).not.toHaveBeenCalled()
})

it('uses the same send action to enqueue while running', () => {
  const { input, onSend } = composer({ running: true })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).toHaveBeenCalledOnce()
})

it.each([{}, { running: true }, { pendingQuestion: true }, { pendingPlan: true }])(
  'keeps only the short Enter hint on the send button: %j', options => {
    const { container } = composer(options)
    const button = container.querySelector('button[data-tip="agent.composer.sendHint"]')!
    expect(button).toBeTruthy()
    expect(button.getAttribute('data-tip')).toBe('agent.composer.sendHint')
    expect(en['agent.composer.sendHint']).toBe('Press Enter to send')
    expect(zhCN['agent.composer.sendHint']).toBe(String.fromCodePoint(0x70b9, 0x51fb) + 'Enter' + String.fromCodePoint(0x53d1, 0x9001))
    if ('pendingQuestion' in options) expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('agent.question.pendingHint')
    if ('pendingPlan' in options) expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('agent.plan.pendingHint')
  },
)

it('ignores native composition flags and keyCode 229 even without composition lifecycle events', () => {
  const { input, onSend } = composer()
  fireEvent.keyDown(input, { key: 'Enter', isComposing: true, ctrlKey: true })
  fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, metaKey: true })
  expect(onSend).not.toHaveBeenCalled()
})
it.each(['@src', '$au'])('commits %s completion before sending', value => {
  const { input, onSend, onMentions } = composer({ draft: value })
  fireEvent.change(input, { target: { value: value + 'd', selectionStart: value.length } })
  // Put the caret after the original query to exercise the nearest-token contract.
  fireEvent.change(input, { target: { value, selectionStart: value.length } })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onSend).not.toHaveBeenCalled()
  if (value.startsWith('@')) expect(onMentions).toHaveBeenCalledWith([{ rel: 'src/a.ts', isDir: false }])
})

it.each([60, 90, 150])('uses at least 90px for a saved composer height of %s', saved => {
  settings.agentComposerHeight = saved
  const { input } = composer()
  expect(input.style.height).toBe(`${Math.max(90, saved)}px`)
})

it('clamps short windows without overwriting the saved minimum', () => {
  settings.agentComposerHeight = 300
  vi.stubGlobal('innerHeight', 240)
  const { input } = composer()
  expect(input.style.height).toBe('120px')
  expect(settings.agentComposerHeight).toBe(300)
})

it('grows a long draft up to the window cap and shrinks back to the saved height', () => {
  const { input } = composer()
  const height = vi.spyOn(input, 'scrollHeight', 'get').mockReturnValue(240)
  vi.stubGlobal('innerHeight', 400)
  fireEvent(window, new Event('resize'))
  expect(input.style.height).toBe('200px')
  height.mockReturnValue(0)
  vi.stubGlobal('innerHeight', 768)
  fireEvent(window, new Event('resize'))
  expect(input.style.height).toBe('90px')
  height.mockRestore()
})

it('frames the input, chips and toolbar together in the initial layout', () => {
  const { input, container } = composer({ outlined: true, command: 'plan' })
  const frame = container.firstElementChild!
  expect(frame.classList.contains('border-accent')).toBe(true)
  expect(frame.contains(input)).toBe(true)
  expect(frame.contains(screen.getByText('/plan'))).toBe(true)
  expect(frame.contains(screen.getByRole('button', { name: 'agent.send' }))).toBe(true)
})
