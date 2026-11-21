// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentChat as Chat, AgentQueuedMessage } from '../store/agent'
import type { AgentDraft } from '../lib/agentCommand'
import type { AgentChatPage } from '../lib/ipc'
const { state, initialChat } = vi.hoisted(() => {
  const initialChat: Chat = { v: 1, id: 'chat', title: 'Example', root: '/repo', provider: 'codex', model: '', effort: '',
    status: 'running', sessionId: null, error: null, createdAt: 0, updatedAt: 0,
    messages: [{ id: 'reply', role: 'assistant', at: 0, items: [{ id: 'text', type: 'text', text: 'Latest output' }] }],
  }
  return { initialChat, state: {
    chats: { chat: initialChat }, pages: {} as Record<string, Partial<AgentChatPage>>,
    pageLoading: {} as Record<string, boolean>, loadingChats: {} as Record<string, boolean>,
    running: { chat: Date.now() }, chatDrafts: {} as Record<string, AgentDraft>,
    queues: {} as Record<string, AgentQueuedMessage[]>, interjecting: {} as Record<string, string>,
    focusRequests: {}, localPicker: null,
    providers: [{ id: 'codex', installed: true, supported: true }],
  } }
})
const { actions, ui, tabs, frames, observers, platform } = vi.hoisted(() => ({
  actions: { loadCatalog: vi.fn(), loadPage: vi.fn(), sendMessage: vi.fn(), interjectQueued: vi.fn(), removeQueued: vi.fn() },
  ui: { overlay: false }, tabs: { activeId: 'chat:chat' }, platform: { mac: false },
  frames: new Map<number, FrameRequestCallback>(), observers: [] as Array<{ callback: () => void; targets: Element[] }>,
}))
vi.mock('../store/agent', () => ({
  useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), { getState: () => ({ ...state, ...actions }) }),
  chatTabId: (id: string) => `chat:${id}`, findPendingQuestion: () => null, findPendingPlanAction: () => null,
}))
vi.mock('../store/tabs', () => ({ useTabs: (select: (state: unknown) => unknown) => select(tabs) }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select({ agentEnabled: true }) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../lib/paths', () => ({ isMac: () => platform.mac }))
vi.mock('../lib/actions', () => ({ openSettings: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentComposer', () => ({ AgentComposer: ({ outlined, onSend }: { outlined: boolean; onSend: () => void }) =>
  <input aria-label="composer" data-outlined={outlined} onKeyDown={event => { if (event.key === 'Enter') onSend() }} /> }))
vi.mock('./AgentMessage', () => ({ AssistantMessage: ({ root }: { root: string }) => <div data-root={root}>Latest output</div>, UserMessage: () => null }))
vi.mock('./AgentContextUsage', () => ({ AgentContextUsage: () => null }))
vi.mock('./AgentPickers', () => ({ ModelPicker: () => null }))
vi.mock('./CopyButton', () => ({ CopyButton: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentChat } from './AgentChat'
beforeEach(() => {
  vi.clearAllMocks()
  frames.clear()
  observers.length = 0
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class {
    entry: { callback: () => void; targets: Element[] }
    constructor(callback: () => void) { this.entry = { callback, targets: [] }; observers.push(this.entry) }
    observe(target: Element) { this.entry.targets.push(target) }
    disconnect() {}
  })
  tabs.activeId = 'chat:chat'
  ui.overlay = false
  platform.mac = false
  state.chats.chat = structuredClone(initialChat)
  state.pages = {}
  state.pageLoading = {}
  state.loadingChats = {}
  state.chatDrafts = {}
  state.queues = {}
  state.interjecting = {}
  state.providers = [{ id: 'codex', installed: true, supported: true }]
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
it('keeps the transcript before the composer without a separate running strip', () => {
  const { container } = render(<AgentChat chatId="chat" />)
  const output = screen.getByText('Latest output')
  expect(screen.queryByText('agent.status.running')).toBeNull()
  expect(output.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('.overflow-y-auto')?.contains(output)).toBe(true)
  expect(output.getAttribute('data-root')).toBe('/repo')
})

it('keeps the conversation title and provider without a duplicate result label', () => {
  state.chats.chat.status = 'error'
  render(<AgentChat chatId="chat" />)
  expect(screen.getByText('Example')).toBeTruthy()
  expect(screen.getByText('codex')).toBeTruthy()
  expect(screen.queryByText('agent.status.failed')).toBeNull()
})

function emptyChat() {
  state.chats.chat = { ...state.chats.chat, status: 'idle', messages: [] }
}

it('centers the welcome title above the framed composer and reuses its input after the first message', () => {
  emptyChat()
  const { rerender } = render(<AgentChat chatId="chat" />)
  const title = screen.getByRole('heading', { name: 'agent.empty' })
  const input = screen.getByRole('textbox')
  expect(title.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(input.getAttribute('data-outlined')).toBe('true')
  expect(input.closest('.my-auto')).toBeTruthy()
  expect(input.closest('.border-t')).toBeNull()
  input.focus()
  state.chats.chat = structuredClone(initialChat)
  rerender(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
  expect(screen.getByRole('textbox')).toBe(input)
  expect(document.activeElement).toBe(input)
  expect(input.getAttribute('data-outlined')).toBe('false')
  expect(input.closest('.border-t')).toBeTruthy()
})

it.each([
  { total: 10 }, { hasEarlier: true }, { hasLater: true },
  { hasPendingQuestion: true }, { hasUnhandledPlanAction: true },
])('does not show a new conversation for unloaded history: %j', page => {
  emptyChat()
  state.pages.chat = page
  render(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
  expect(screen.getByRole('textbox').getAttribute('data-outlined')).toBe('false')
})

it.each(['loading', 'paging', 'running', 'session'] as const)('does not show a new conversation during %s', phase => {
  emptyChat()
  if (phase === 'loading') state.loadingChats.chat = true
  if (phase === 'paging') state.pageLoading.chat = true
  if (phase === 'running') state.chats.chat.status = 'running'
  if (phase === 'session') state.chats.chat.sessionId = 'existing-session'
  render(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
})

it('keeps errors and missing-provider guidance visible in the centered layout', () => {
  emptyChat()
  state.chats.chat.error = 'Launch failed'
  state.providers[0].installed = false
  render(<AgentChat chatId="chat" />)
  expect(screen.getByRole('alert').textContent).toBe('Launch failed')
  expect(screen.getByText('agent.providerMissing')).toBeTruthy()
  expect(screen.getByRole('textbox').getAttribute('data-outlined')).toBe('true')
})

function scrollMetrics(container: HTMLElement) {
  const el = container.querySelector<HTMLDivElement>('.h-full.overflow-y-auto')!
  const metrics = { height: 1000, viewport: 200, top: 800 }
  Object.defineProperties(el, {
    scrollHeight: { configurable: true, get: () => metrics.height },
    clientHeight: { configurable: true, get: () => metrics.viewport },
    scrollTop: { configurable: true, get: () => metrics.top,
      set: (value: number) => { metrics.top = Math.max(0, Math.min(value, metrics.height - metrics.viewport)) } },
  })
  return { el, metrics }
}
function flushFrames() {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  })
}
function updateOutput() {
  state.chats.chat = { ...state.chats.chat, messages: [...state.chats.chat.messages] }
}

it.each([false, true])('uses the active chat modifier+Down shortcut without Shift (mac=%s)', mac => {
  platform.mac = mac
  const { container } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 200
  fireEvent.scroll(el)
  expect(screen.getByText(mac ? '⌘↓' : 'Ctrl+↓')).toBeTruthy()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowDown', ctrlKey: !mac, metaKey: mac })
  expect(metrics.top).toBe(800)
  expect(screen.queryByText('agent.jumpToLatest')).toBeNull()
})

it.each(['inactive', 'overlay', 'composition', 'prevented', 'shift', 'alt', 'repeat', 'ime229'])(
  'does not jump for %s keyboard events', reason => {
    const { container, rerender } = render(<AgentChat chatId="chat" />)
    const { el, metrics } = scrollMetrics(container)
    flushFrames()
    fireEvent.wheel(el, { deltaY: -100 })
    metrics.top = 200
    fireEvent.scroll(el)
    if (reason === 'inactive') { tabs.activeId = 'other'; rerender(<AgentChat chatId="chat" />) }
    if (reason === 'overlay') ui.overlay = true
    const event = new KeyboardEvent('keydown', { key: 'ArrowDown', ctrlKey: true, bubbles: true, cancelable: true,
      isComposing: reason === 'composition', shiftKey: reason === 'shift', altKey: reason === 'alt',
      repeat: reason === 'repeat', keyCode: reason === 'ime229' ? 229 : 0 })
    if (reason === 'prevented') event.preventDefault()
    fireEvent(screen.getByRole('textbox'), event)
    expect(metrics.top).toBe(200)
  },
)

it('follows committed output, deferred content, viewport resizing and final output after Enter', () => {
  state.chatDrafts.chat = { text: 'Next message', mentions: [] }
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 100
  fireEvent.scroll(el)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(actions.sendMessage).toHaveBeenCalledWith('chat', state.chatDrafts.chat)
  expect(metrics.top).toBe(800)
  metrics.height = 1400
  // A growth-generated scroll event must not clear following intent.
  fireEvent.scroll(el)
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  expect(metrics.top).toBe(1200)
  metrics.height = 1800
  const observer = observers.find(entry => entry.targets.includes(el))!
  expect(observer.targets).toContain(el.firstElementChild)
  act(() => observer.callback())
  flushFrames()
  expect(metrics.top).toBe(1600)
  metrics.viewport = 100
  act(() => observer.callback())
  flushFrames()
  expect(metrics.top).toBe(1700)
  metrics.height = 2000
  state.chats.chat = { ...state.chats.chat, status: 'idle' }
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  expect(metrics.top).toBe(1900)
})

it('pauses on upward scrolling, preserves history during output and resumes on the latest button', () => {
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -20 })
  metrics.top = 780
  fireEvent.scroll(el)
  metrics.height = 1500
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(780)
  fireEvent.click(screen.getByText('agent.jumpToLatest'))
  expect(metrics.top).toBe(1300)
})

it('loads the latest page before completing a jump from old history', async () => {
  state.pages.chat = { hasLater: true }
  actions.loadPage.mockImplementationOnce(async () => { state.pages.chat = { hasLater: false }; updateOutput() })
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { metrics } = scrollMetrics(container)
  await act(async () => { fireEvent.click(screen.getByText('agent.jumpToLatest')) })
  expect(actions.loadPage).toHaveBeenCalledWith('chat', 'latest')
  metrics.height = 1600
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  expect(metrics.top).toBe(1400)
})

it('shows a lighter queued card and interjects its selected message before resuming following', async () => {
  state.queues.chat = [{ id: 'queued', text: 'Queued work', mentions: [] }]
  actions.interjectQueued.mockResolvedValueOnce(true)
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const card = screen.getByText('Queued work').parentElement!
  expect(card.classList.contains('bg-panel')).toBe(true)
  expect(card.classList.contains('bg-panel-alt')).toBe(false)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 100
  fireEvent.scroll(el)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'agent.queue.send' })) })
  expect(actions.interjectQueued).toHaveBeenCalledWith('chat', 'queued')
  expect(metrics.top).toBe(800)
  state.interjecting.chat = 'queued'
  rerender(<AgentChat chatId="chat" />)
  expect((screen.getByRole('button', { name: 'agent.queue.send' }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: 'agent.queue.remove' }) as HTMLButtonElement).disabled).toBe(true)
})

it.each(['expansion', 'touch', 'keyboard'])('pauses following for %s reading gestures', gesture => {
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  if (gesture === 'expansion') {
    const button = document.createElement('button')
    button.setAttribute('aria-expanded', 'false')
    el.firstElementChild!.appendChild(button)
    fireEvent.click(button)
  } else if (gesture === 'touch') {
    fireEvent.touchStart(el, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(el, { touches: [{ clientY: 150 }] })
  } else if (gesture === 'keyboard') {
    fireEvent.keyDown(el, { key: 'PageUp' })
  }
  const top = metrics.top
  fireEvent.scroll(el)
  metrics.height = 1600
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(top)
  expect(screen.getByText('agent.jumpToLatest')).toBeTruthy()
})
