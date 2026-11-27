// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { DirEntryInfo, DirPage } from '../lib/ipc'
const { readDir, toast } = vi.hoisted(() => ({ readDir: vi.fn(), toast: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { readDir }, errorText: (error: Error) => error.message, errorCode: (error: { code?: string }) => error.code ?? null }))
vi.mock('../store/workspace', () => ({ useWorkspace: (select: (state: unknown) => unknown) => select({ roots: [] }) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }))
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
const dirEntry = (path: string, isDir = true): DirEntryInfo => ({
  path, name: path.split('/').at(-1)!, isDir, isSymlink: false, ignored: false, size: 0, mtime: 0,
})
beforeEach(() => {
  readDir.mockReset().mockImplementation(async (_root: string, rel: string) => ({
    entries: rel === '' ? [dirEntry('src'), dirEntry('empty')] : [dirEntry('src/a.ts', false), dirEntry('src/empty')],
    hasMore: false,
  }))
  toast.mockClear()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 500, 400, 100))
})
afterEach(() => { cleanup(); settings.agentComposerHeight = 90; vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('orders context, stop and send and allows a standalone plan toggle', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const onChange = vi.fn()
  const view = render(<AgentComposer root="/repo" draft="/plan" mentions={[]} skills={[]} provider="codex" model="" effort=""
    running contextUsage={<button aria-label="context" />} onDraft={onChange} onMentions={onChange} onCommand={onChange}
    onSkills={onChange} onProvider={onChange} onModel={onChange} onEffort={onChange} onStop={onChange} onSend={onChange} />)
  const buttons = [...view.container.querySelectorAll('button')]
  expect(buttons.indexOf(screen.getByLabelText('context'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.stopHint')))
  expect(buttons.indexOf(screen.getByLabelText('agent.stopHint'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.queue.send')))
  expect(screen.getByLabelText('agent.stopHint').getAttribute('data-tip')).toBe('agent.stopHint')
  expect(en['agent.stopHint']).toContain('Esc')
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
  const popup = candidate.closest('[data-agent-suggestions]')
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
it.each(['@src/a', '$au'])('commits %s completion before sending', value => {
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

function query(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value: value + 'x', selectionStart: value.length } })
}

it('opens all commands on a bare slash and supports mouse selection beyond the first eight', () => {
  const { input, onCommand, onDraft, onSend } = composer({ draft: '/' })
  query(input, '/')
  expect(screen.getByText('/new')).toBeTruthy()
  expect(screen.getByText('/help')).toBeTruthy()
  expect(screen.getByText('/new').closest('button')?.getAttribute('data-candidate-index')).toBe('0')
  expect(screen.getByText('/help').closest('button')?.parentElement?.style.maxHeight).toBe('224px')
  fireEvent.mouseDown(screen.getByText('/help'))
  expect(onCommand).toHaveBeenCalledWith(undefined)
  expect(onDraft).toHaveBeenCalledWith('/help ')
  expect(onSend).not.toHaveBeenCalled()
})

it('wraps keyboard navigation through the complete command list and closes with Escape', () => {
  const { input, onDraft, onSend } = composer({ draft: '/' })
  query(input, '/')
  fireEvent.keyDown(input, { key: 'ArrowUp' })
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(onDraft).toHaveBeenCalledWith('/help ')
  query(input, '/')
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(screen.queryByText('/help')).toBeNull()
  expect(onSend).not.toHaveBeenCalled()
})

it('positions the caret after the selected local command for arguments', () => {
  const callbacks: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callbacks.push(callback); return callbacks.length })
  const onDraft = vi.fn()
  const props = { draft: '/mod', onDraft }
  const view = composer(props)
  query(view.input, '/mod')
  fireEvent.mouseDown(screen.getByText('/model'))
  view.rerender(<AgentComposer root="/repo" draft="/model " mentions={[]} skills={[]} provider="codex" model="" effort=""
    running={false} onDraft={onDraft} onMentions={vi.fn()} onCommand={vi.fn()} onSkills={vi.fn()}
    onProvider={vi.fn()} onModel={vi.fn()} onEffort={vi.fn()} onStop={vi.fn()} onSend={vi.fn()} />)
  act(() => { callbacks.forEach(callback => callback(0)) })
  expect((view.input as HTMLTextAreaElement).selectionStart).toBe('/model '.length)
})

it.each(['empty', 'src'])('references the %s directory with its directory flag', async path => {
  const { input, onMentions, onDraft, onSend } = composer({ draft: '@' + path })
  query(input, '@' + path)
  await screen.findByText(path + '/')
  fireEvent.keyDown(input, { key: 'Enter' })
  await waitFor(() => expect(onMentions).toHaveBeenCalledWith([{ rel: path, isDir: true }]))
  expect(onDraft).toHaveBeenCalledWith('')
  expect(onSend).not.toHaveBeenCalled()
})

it('finds empty nested folders through typed directory paths', async () => {
  const { input, onMentions } = composer({ draft: '@src/empty' })
  query(input, '@src/empty')
  fireEvent.mouseDown(await screen.findByText('src/empty/'))
  await waitFor(() => expect(onMentions).toHaveBeenCalledWith([{ rel: 'src/empty', isDir: true }]))
  expect(readDir).toHaveBeenCalledWith('/repo', 'src', 0, 200)
})

it('does not duplicate a selected directory chip', async () => {
  const { input, onMentions, onDraft } = composer({ draft: '@src', mentions: [{ rel: 'src', isDir: true }] })
  query(input, '@src')
  fireEvent.mouseDown(screen.getByText('src/'))
  await waitFor(() => expect(onDraft).toHaveBeenCalledWith(''))
  expect(onMentions).not.toHaveBeenCalled()
})

it('keeps the token and reports an inferred directory that disappeared before selection', async () => {
  readDir.mockResolvedValue({ entries: [], hasMore: false })
  const { input, onMentions, onDraft } = composer({ draft: '@src' })
  query(input, '@src')
  onDraft.mockClear()
  fireEvent.mouseDown(screen.getByText('src/'))
  await waitFor(() => expect(toast).toHaveBeenCalled())
  expect(onMentions).not.toHaveBeenCalled()
  expect(onDraft).not.toHaveBeenCalled()
})

it('does not apply a pending selection after Escape', async () => {
  let resolve!: (page: Partial<DirPage>) => void
  readDir.mockReturnValue(new Promise(done => { resolve = done }))
  const { input, onMentions, onDraft } = composer({ draft: '@src' })
  query(input, '@src')
  onDraft.mockClear()
  fireEvent.mouseDown(screen.getByText('src/'))
  fireEvent.keyDown(input, { key: 'Escape' })
  await act(async () => { resolve({ entries: [dirEntry('src')], hasMore: false }) })
  expect(onMentions).not.toHaveBeenCalled()
  expect(onDraft).not.toHaveBeenCalled()
})

it('discards a directory response after switching query directories', async () => {
  let resolve!: (page: Partial<DirPage>) => void
  readDir.mockReturnValueOnce(new Promise(done => { resolve = done }))
  const { input } = composer({ draft: '@' })
  query(input, '@')
  query(input, '@src/')
  await screen.findByText('src/empty/')
  await act(async () => { resolve({ entries: [dirEntry('obsolete')], hasMore: false }) })
  expect(screen.queryByText('obsolete/')).toBeNull()
})

it.each(['@src', '/', '$au'])('clamps %s suggestions below the chat title and remeasures on resize', value => {
  const boundary = document.createElement('div')
  Object.defineProperty(boundary, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn(() => new DOMRect(0, 400, 400, 300)),
  })
  const { input, container } = composer({ draft: value, popupBoundaryRef: { current: boundary } })
  query(input, value)
  const popup = container.querySelector<HTMLElement>('[data-agent-suggestions]')!
  expect(popup.style.maxHeight).toBe('92px')
  vi.mocked(boundary.getBoundingClientRect).mockReturnValue(new DOMRect(0, 100, 400, 600))
  fireEvent(window, new Event('resize'))
  expect(popup.style.maxHeight).toBe('260px')
  expect(container.querySelector('textarea')).toBe(input)
})
