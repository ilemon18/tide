// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentChat as Chat, AgentMessage as Message, AgentQueuedMessage } from '../store/agent'
import type { AgentDraft } from '../lib/agentCommand'
import type { AgentChatPage } from '../lib/ipc'
const { state, initialChat, actions, settings } = vi.hoisted(() => {
  const initialChat: Chat = { v: 1, id: 'chat', title: 'Example', root: '/repo', provider: 'codex', model: '', effort: '',
    status: 'running', sessionId: null, error: null, createdAt: 0, updatedAt: 0,
    messages: [{ id: 'reply', role: 'assistant', at: 0, items: [{ id: 'text', type: 'text', text: 'Latest output' }] }],
  }
  const actions = { stop: vi.fn(), markChatFocused: vi.fn(), loadProviders: vi.fn(), loadCatalog: vi.fn(), loadPage: vi.fn(), loadHistory: vi.fn(), clearHistory: vi.fn(), deleteChat: vi.fn().mockResolvedValue(true), resumeChat: vi.fn().mockResolvedValue(true), loadChat: vi.fn().mockResolvedValue(undefined), openChatTab: vi.fn(), sendMessage: vi.fn(), interjectQueued: vi.fn(), removeQueued: vi.fn(), editQueued: vi.fn().mockReturnValue(true) }
  const settings = { agentEnabled: true, agentHistoryEnabled: true, shortcutOverrides: {} }
  return { initialChat, actions, settings, state: {
    chats: { chat: initialChat }, pages: {} as Record<string, Partial<AgentChatPage>>,
    pageLoading: {} as Record<string, boolean>, loadingChats: {} as Record<string, boolean>, deletingChats: {} as Record<string, boolean>,
    running: { chat: Date.now() } as Record<string, number>, chatDrafts: {} as Record<string, AgentDraft>,
    queues: {} as Record<string, AgentQueuedMessage[]>, interjecting: {} as Record<string, string>,
    focusRequests: {}, localPicker: null, historyByRoot: {} as Record<string, import('../store/agent').AgentHistory>,
    providers: [{ id: 'codex', installed: true, supported: true }] as Array<{ id: string; name?: string; installed: boolean; supported: boolean }> | null,
  } }
})
const { ui, tabs, frames, observers, platform } = vi.hoisted(() => ({
  ui: { historyOpen: false, openHistory: vi.fn(), closeHistory: vi.fn(), overlay: false, confirmReq: null as object | null, confirm: vi.fn<(options: unknown) => Promise<boolean>>(), toast: vi.fn() }, tabs: { activeId: 'chat:chat' }, platform: { mac: false },
  frames: new Map<number, FrameRequestCallback>(), observers: [] as Array<{ callback: () => void; targets: Element[] }>,
}))
const { composerBoundary, replyRendering } = vi.hoisted(() => ({
  composerBoundary: { value: undefined as React.RefObject<HTMLDivElement | null> | undefined },
  replyRendering: { markdown: false },
}))
vi.mock('../store/agent', () => ({
  useAgent: Object.assign((select: (state: unknown) => unknown) => select(state), { getState: () => ({ ...state, ...actions }) }),
  chatTabId: (id: string) => `chat:${id}`, findPendingQuestion: () => null, findPendingPlanAction: () => null,
}))
vi.mock('../store/tabs', () => ({ useTabs: (select: (state: unknown) => unknown) => select(tabs) }))
vi.mock('../store/settings', () => ({ useSettings: Object.assign((select: (state: unknown) => unknown) => select(settings), { getState: () => settings }) }))
vi.mock('../store/ui', () => ({ useUi: Object.assign((select: (state: typeof ui) => unknown) => select(ui), { getState: () => ui }) }))
vi.mock('../store/workspace', () => ({ useWorkspace: { getState: () => ({ setActiveRoot: vi.fn() }) } }))
vi.mock('../lib/paths', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/paths')>(), isMac: () => platform.mac,
}))
vi.mock('../lib/actions', () => ({ openSettings: vi.fn() }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./AgentComposer', () => ({ AgentComposer: ({ outlined, draft, onSend, popupBoundaryRef }: {
  outlined: boolean; draft: string; onSend: () => void; popupBoundaryRef: React.RefObject<HTMLDivElement | null>
}) => {
  composerBoundary.value = popupBoundaryRef
  return <>
    <input aria-label="composer" value={draft} readOnly data-outlined={outlined} onKeyDown={event => { if (event.key === 'Enter') onSend() }} />
    <button aria-label="agent.send" onClick={onSend}>Send</button>
  </>
} }))
vi.mock('./AgentMessage', async () => {
  const { AgentStreamText } = await import('./AgentStreamText')
  return {
    AssistantMessage: ({ root, message, running, providerLabel }: { root: string; message: Message; running: boolean; providerLabel: string }) =>
      replyRendering.markdown
        ? <AgentStreamText root={root} text={message.items?.find(item => item.type === 'text')?.text ?? ''} live={running} />
        : <div data-root={root} data-provider={providerLabel}>Latest output</div>,
    UserMessage: () => null,
  }
})
vi.mock('./AgentContextUsage', () => ({ AgentContextUsage: () => null }))
vi.mock('./AgentPickers', () => ({ ModelPicker: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentChat } from './AgentChat'
beforeEach(() => {
  vi.clearAllMocks()
  replyRendering.markdown = false
  frames.clear()
  observers.length = 0
  let frameId = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.stubGlobal('ResizeObserver', class {
    entry: { callback: () => void; targets: Element[] }
    constructor(callback: () => void) { this.entry = { callback, targets: [] }; observers.push(this.entry) }
    observe(target: Element) { this.entry.targets.push(target) }
    disconnect() {}
  })
  tabs.activeId = 'chat:chat'
  ui.historyOpen = false
  ui.overlay = false
  ui.confirmReq = null
  ui.confirm.mockReset().mockResolvedValue(false)
  platform.mac = false
  state.chats.chat = structuredClone(initialChat)
  state.running = { chat: Date.now() }
  state.pages = {}
  state.pageLoading = {}
  state.loadingChats = {}
  state.deletingChats = {}
  state.chatDrafts = {}
  state.queues = {}
  state.interjecting = {}
  state.historyByRoot = {}
  state.providers = [{ id: 'codex', installed: true, supported: true }]
  settings.agentEnabled = true
  settings.agentHistoryEnabled = true
  actions.loadHistory.mockClear()
  actions.clearHistory.mockClear()
  actions.resumeChat.mockClear()
  actions.loadChat.mockClear()
  actions.openChatTab.mockClear()
  actions.editQueued.mockClear()
  actions.sendMessage.mockReset()
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('opens the history drawer without opening a dialog or loading history in the chat', () => {
  const { rerender } = render(<AgentChat chatId="chat" />)
  fireEvent.click(screen.getByRole('button', { name: 'agent.history.title' }))
  expect(ui.openHistory).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(actions.loadHistory).not.toHaveBeenCalled()
  settings.agentHistoryEnabled = false
  rerender(<AgentChat chatId="chat" />)
  expect(screen.queryByRole('button', { name: 'agent.history.title' })).toBeNull()
})

it.each([
  { stored: 'codex', current: 'claude', catalogName: undefined, expected: 'Codex' },
  { stored: 'claude', current: 'codex', catalogName: undefined, expected: 'Claude Code' },
  { stored: undefined, current: 'claude', catalogName: undefined, expected: 'Claude Code' },
  { stored: 'custom', current: 'codex', catalogName: undefined, expected: 'custom' },
  { stored: 'codex', current: 'claude', catalogName: 'Installed Codex', expected: 'Installed Codex' },
])('passes the saved or legacy provider name to replies: $expected', ({ stored, current, catalogName, expected }) => {
  state.chats.chat = { ...initialChat, provider: current,
    messages: [{ ...initialChat.messages[0], provider: stored }] }
  state.providers = catalogName ? [{ id: 'codex', name: catalogName, installed: true, supported: true }] : []
  const { rerender } = render(<AgentChat chatId="chat" />)
  expect(screen.getByText('Latest output').getAttribute('data-provider')).toBe(expected)
  state.providers = null
  rerender(<AgentChat chatId="chat" />)
  expect(screen.getByText('Latest output').getAttribute('data-provider'))
    .toBe(stored === 'codex' ? 'Codex' : expected)
})

it.each(['Enter', 'click'])('keeps an empty composer mounted after the first send by %s', inputMethod => {
  emptyChat()
  const draft = { text: 'First message', mentions: [] }
  state.chatDrafts.chat = draft
  const { rerender } = render(<AgentChat chatId="chat" />)
  const input = screen.getByRole('textbox') as HTMLInputElement
  expect(input.value).toBe('First message')
  actions.sendMessage.mockImplementation(() => {
    state.chatDrafts.chat = { text: '', mentions: [] }
    state.chats.chat = { ...state.chats.chat, status: 'running', messages: [
      { id: 'user', role: 'user', at: 1, text: draft.text },
      { id: 'reply', role: 'assistant', at: 1, provider: 'codex', items: [] },
    ] }
    rerender(<AgentChat chatId="chat" />)
  })
  if (inputMethod === 'Enter') fireEvent.keyDown(input, { key: 'Enter' })
  else fireEvent.click(screen.getByRole('button', { name: 'agent.send' }))
  expect(actions.sendMessage).toHaveBeenCalledExactlyOnceWith('chat', draft)
  expect(screen.getByRole('textbox')).toBe(input)
  expect(input.value).toBe('')
  expect(input.getAttribute('data-outlined')).toBe('false')
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
})

it('keeps chat Escape available while the history drawer is open and focus is outside it', () => {
  render(<AgentChat chatId="chat" />)
  ui.historyOpen = true
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(actions.stop).toHaveBeenCalledExactlyOnceWith('chat')
})

it('pauses follow observers, focus and Escape while hidden and resumes them on reveal', () => {
  const { rerender } = render(<AgentChat chatId="chat" visible={false} />)
  expect(observers).toHaveLength(0)
  expect(actions.markChatFocused).not.toHaveBeenCalled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(actions.stop).not.toHaveBeenCalled()

  rerender(<AgentChat chatId="chat" visible />)
  expect(observers.length).toBeGreaterThan(0)
  expect(actions.markChatFocused).toHaveBeenCalledWith('chat')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(actions.stop).toHaveBeenCalledExactlyOnceWith('chat')
})

it('leaves Escape to the history drawer when its search field has focus', () => {
  render(<AgentChat chatId="chat" />)
  const drawer = document.createElement('div')
  drawer.setAttribute('data-history-drawer', '')
  const input = document.createElement('input')
  drawer.append(input)
  document.body.append(drawer)
  input.focus()
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(actions.stop).not.toHaveBeenCalled()
  drawer.remove()
})

it('keeps the transcript before the composer without a separate running strip', () => {
  const { container } = render(<AgentChat chatId="chat" />)
  const output = screen.getByText('Latest output')
  expect(screen.queryByText('agent.status.running')).toBeNull()
  expect(output.compareDocumentPosition(screen.getByRole('textbox')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(container.querySelector('.overflow-y-auto')?.contains(output)).toBe(true)
  expect(output.getAttribute('data-root')).toBe('/repo')
})

it('bounds composer suggestions to the content below the conversation header', () => {
  const { container } = render(<AgentChat chatId="chat" />)
  const content = container.querySelector('[data-agent-content]')!
  expect(composerBoundary.value?.current).toBe(content)
  expect(content.contains(screen.getByText('Example'))).toBe(false)
  expect(content.contains(screen.getByRole('textbox'))).toBe(true)
})

it('keeps the growing live reply visible and restores skipped-content rendering after completion', () => {
  state.chats.chat.messages.unshift({ id: 'previous', role: 'assistant', at: 0, completion: 'completed' })
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const previous = container.querySelector<HTMLElement>('[data-agent-message="previous"]')!
  const live = container.querySelector<HTMLElement>('[data-agent-message="reply"]')!
  expect(previous.style.contentVisibility).toBe('auto')
  expect(live.style.contentVisibility).toBe('visible')
  expect(live.style.containIntrinsicSize).toBe('')
  state.chats.chat.messages = state.chats.chat.messages.map<Chat['messages'][number]>(message => message.id === 'reply'
    ? { ...message, items: [...message.items!, { id: 'tool', type: 'tool', text: '', status: 'running' }] }
    : message)
  rerender(<AgentChat chatId="chat" />)
  expect(container.querySelector('[data-agent-message="reply"]')).toBe(live)
  expect(live.style.contentVisibility).toBe('visible')
  state.chats.chat.status = 'idle'
  rerender(<AgentChat chatId="chat" />)
  expect(live.style.contentVisibility).toBe('auto')
  expect(live.style.containIntrinsicSize).toBe('auto 120px')
})

it('keeps the conversation title and provider without a duplicate result label', () => {
  state.chats.chat.status = 'error'
  render(<AgentChat chatId="chat" />)
  expect(screen.getByText('Example')).toBeTruthy()
  expect(screen.getByText('Codex')).toBeTruthy()
  expect(document.querySelector('[style*="mask-image"]')).toBeTruthy()
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
  state.providers = [{ id: 'codex', installed: false, supported: true }]
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

it('keeps following after a shrink and regrowth deliver an upward layout scroll after Enter', () => {
  state.chatDrafts.chat = { text: 'Next message', mentions: [] }
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 100
  fireEvent.scroll(el)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  flushFrames()
  expect(metrics.top).toBe(800)

  // The browser clamps the old offset, but delivers its scroll event after content grows again.
  metrics.height = 600
  el.scrollTop = metrics.top
  expect(metrics.top).toBe(400)
  metrics.height = 1400
  fireEvent.scroll(el)
  expect(screen.queryByText('agent.jumpToLatest')).toBeNull()
  flushFrames()
  expect(metrics.top).toBe(1200)

  metrics.height = 1800
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(1600)
})

it('anchors the first send after the hidden transcript becomes visible and its layout settles', () => {
  emptyChat()
  state.chatDrafts.chat = { text: 'First message', mentions: [] }
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  metrics.height = 0
  metrics.viewport = 0
  metrics.top = 0
  flushFrames()
  const input = screen.getByRole('textbox')
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(actions.sendMessage).toHaveBeenCalledWith('chat', state.chatDrafts.chat)

  state.chats.chat = structuredClone(initialChat)
  metrics.height = 1400
  metrics.viewport = 200
  rerender(<AgentChat chatId="chat" />)
  expect(screen.getByRole('textbox')).toBe(input)
  expect(screen.queryByRole('heading', { name: 'agent.empty' })).toBeNull()
  expect(metrics.top).toBe(1200)

  metrics.height = 1800
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(1600)
})

it('follows the resized transcript when another send adds a queued card during a running turn', () => {
  state.chatDrafts.chat = { text: 'Queued work', mentions: [] }
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 100
  fireEvent.scroll(el)
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(metrics.top).toBe(800)
  expect(actions.sendMessage).toHaveBeenCalledWith('chat', state.chatDrafts.chat)

  state.queues.chat = [{ id: 'queued', ...state.chatDrafts.chat }]
  metrics.viewport = 120
  rerender(<AgentChat chatId="chat" />)
  expect(screen.getByText('Queued work')).toBeTruthy()
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(880)

  metrics.height = 1600
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  expect(metrics.top).toBe(1480)
})

it('pauses for scrollbar dragging, keeps the reading position during output and resumes after Enter', () => {
  state.chatDrafts.chat = { text: 'Next message', mentions: [] }
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.pointerDown(el, { button: 0 })
  metrics.top = 200
  fireEvent.scroll(el)
  fireEvent.pointerUp(el)
  metrics.height = 1400
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(200)
  expect(screen.getByText('agent.jumpToLatest')).toBeTruthy()

  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' })
  expect(metrics.top).toBe(1200)
  expect(screen.queryByText('agent.jumpToLatest')).toBeNull()
})

it('keeps following when message content is pressed', () => {
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.pointerDown(screen.getByText('Latest output'), { button: 0 })
  metrics.height = 1400
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  expect(metrics.top).toBe(1200)
  expect(screen.queryByText('agent.jumpToLatest')).toBeNull()
})

it.each([
  { format: 'code block', prefix: '`', text: '```ts\nconst value = 1\n```\n\nMore', selector: 'pre code' },
  { format: 'table', prefix: '|', text: '| Name | Value |\n| --- | --- |\n| answer | 42 |\n\nMore', selector: 'table' },
])('follows a deferred Markdown $format commit without another store update or resize notification', async ({ prefix, text, selector }) => {
  vi.useFakeTimers()
  replyRendering.markdown = true
  const message = state.chats.chat.messages[0]
  message.items = [{ id: 'text', type: 'text', text: prefix }]
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  expect(el.querySelector(selector)).toBeNull()

  message.items = [{ id: 'text', type: 'text', text }]
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  expect(metrics.top).toBe(800)
  expect(el.querySelector(selector)).toBeNull()

  // Only the child stream renderer commits now; no parent rerender or ResizeObserver callback follows.
  await act(async () => {
    metrics.height = 1800
    vi.advanceTimersByTime(1000)
  })
  expect(el.querySelector(selector)).toBeTruthy()
  flushFrames()
  expect(metrics.top).toBe(1600)
  expect(screen.queryByText('agent.jumpToLatest')).toBeNull()

  // Further tokens update the existing formatted text node, rather than replacing the Markdown tree.
  message.items = [{ id: 'text', type: 'text', text: text + ' output' }]
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  flushFrames()
  await act(async () => {
    metrics.height = 2200
    vi.advanceTimersByTime(1000)
  })
  flushFrames()
  expect(el.textContent).toContain('More output')
  expect(metrics.top).toBe(2000)
})

it('keeps the reading position when deferred code formatting commits after following was paused', async () => {
  vi.useFakeTimers()
  replyRendering.markdown = true
  const message = state.chats.chat.messages[0]
  message.items = [{ id: 'text', type: 'text', text: '`' }]
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  message.items = [{ id: 'text', type: 'text', text: '```ts\nconst value = 1\n```' }]
  updateOutput()
  rerender(<AgentChat chatId="chat" />)
  flushFrames()

  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 200
  fireEvent.scroll(el)
  await act(async () => {
    metrics.height = 1800
    vi.advanceTimersByTime(1000)
  })
  expect(el.querySelector('pre code')?.textContent).toBe('const value = 1')
  flushFrames()
  expect(metrics.top).toBe(200)
  expect(screen.getByText('agent.jumpToLatest')).toBeTruthy()
})

it('keeps the completed reply at the bottom after its final layout settles', () => {
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  metrics.height = 1400
  state.chats.chat = { ...state.chats.chat, status: 'idle' }
  rerender(<AgentChat chatId="chat" />)
  expect(metrics.top).toBe(1200)
  metrics.height = 1800
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(1600)
})

it('resumes following when a paused turn completes', () => {
  const { container, rerender } = render(<AgentChat chatId="chat" />)
  const { el, metrics } = scrollMetrics(container)
  flushFrames()
  fireEvent.wheel(el, { deltaY: -100 })
  metrics.top = 100
  fireEvent.scroll(el)
  metrics.height = 1400
  state.chats.chat = { ...state.chats.chat, status: 'idle' }
  rerender(<AgentChat chatId="chat" />)
  expect(metrics.top).toBe(1200)
  metrics.height = 1800
  act(() => observers.find(entry => entry.targets.includes(el))!.callback())
  flushFrames()
  expect(metrics.top).toBe(1600)
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
  const copy = screen.getByRole('button', { name: 'agent.copy.queued' })
  const edit = screen.getByRole('button', { name: 'agent.queue.edit' })
  expect(copy.className).not.toContain('opacity-0')
  expect(edit.className).not.toContain('opacity-0')
  fireEvent.click(edit)
  expect(actions.editQueued).toHaveBeenCalledWith('chat', 'queued')
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
  expect((screen.getByRole('button', { name: 'agent.queue.edit' }) as HTMLButtonElement).disabled).toBe(true)
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
