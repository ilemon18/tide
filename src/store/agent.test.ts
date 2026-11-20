import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../lib/ipc'
vi.mock('../lib/ipc', () => ({ api: { agentChatOpen: vi.fn(), agentChatApply: vi.fn(), agentSend: vi.fn(),
  agentChatPage: vi.fn(), agentChatList: vi.fn(), agentChatClone: vi.fn() }, errorText: String }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ agentEnabled: true, flush: vi.fn() }) } }))
vi.mock('./tabs', () => ({ useTabs: { getState: () => ({ setTabName: vi.fn(), openChat: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('./workspace', () => ({ activeRoot: () => null }))
import { useAgent, type AgentChat } from './agent'

const chat = (): AgentChat => ({ v: 1, id: 'chat-test', root: '/tmp/project', title: 'test', provider: 'codex',
  model: '', effort: '', sessionId: 'session-1', messages: [{ id: 'a1', role: 'assistant', at: 1, items: [] }],
  status: 'idle', error: null, createdAt: 1, updatedAt: 1 })
const page = () => ({ header: chat(), messages: chat().messages, hasEarlier: false, hasLater: false,
  total: 1, hasPendingQuestion: false, hasUnhandledPlanAction: false, pendingMessageId: null })
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAgent.setState({ chats: { 'chat-test': chat() }, pages: {}, pageLoading: {}, queues: {}, running: {}, chatDrafts: {} })
  vi.mocked(api.agentChatApply).mockResolvedValue(page())
  vi.mocked(api.agentChatOpen).mockResolvedValue(page())
  vi.mocked(api.agentSend).mockResolvedValue(undefined)
})
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers() })

describe('chat protocol state', () => {
  it('sends explicit resume and keeps a changed draft while starting', async () => {
    let finish!: () => void
    vi.mocked(api.agentSend).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    const draft = { text: 'continue', mentions: [] }
    useAgent.getState().setChatDraft('chat-test', draft)
    const pending = useAgent.getState().sendMessage('chat-test', draft)
    useAgent.getState().setChatDraft('chat-test', { text: 'next thought' })
    finish()
    await pending
    expect(api.agentSend).toHaveBeenCalledWith(expect.objectContaining({ sessionAction: 'resume', sessionId: 'session-1' }))
    expect(useAgent.getState().chatDrafts['chat-test'].text).toBe('next thought')
  })
  it('preserves the draft when launch fails', async () => {
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('resume failed'))
    const draft = { text: 'keep this', mentions: [] }
    useAgent.getState().setChatDraft('chat-test', draft)
    await useAgent.getState().sendMessage('chat-test', draft)
    expect(useAgent.getState().chatDrafts['chat-test'].text).toBe('keep this')
    expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })
  it('rejects duplicate and stale events and completion', () => {
    useAgent.setState({ chats: { 'chat-test': { ...chat(), status: 'running', activeRunId: 'run-1' } } })
    const event = { chatId: 'chat-test', runId: 'run-1', sequence: 1,
      event: { kind: 'textDelta' as const, itemId: 'text', text: 'one' } }
    useAgent.getState().applyEvent(event)
    useAgent.getState().applyEvent(event)
    useAgent.getState().applyEvent({ ...event, runId: 'old', sequence: 100 })
    expect(useAgent.getState().chats['chat-test'].messages[0].items?.[0].text).toBe('one')
    useAgent.getState().applyEvent({ ...event, sequence: 2, event: { kind: 'done', ok: false, cancelled: false, code: 1 } })
    useAgent.getState().applyEvent({ ...event, sequence: 3 })
    expect(useAgent.getState().chats['chat-test'].status).toBe('error')
    expect(api.agentSend).not.toHaveBeenCalled()
  })
  it('blocks sends for an unloaded pending question', async () => {
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasPendingQuestion: true, pendingMessageId: 'old' } } })
    await useAgent.getState().sendMessage('chat-test', { text: 'should wait', mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()
  })
  it('dispatches help locally without sending a prompt', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/help', mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(useAgent.getState().chats['chat-test'].messages.at(-1)?.items?.[0].text).toBe('agent.local.helpText')
  })
  it('replaces a history page without saving it over unloaded messages', async () => {
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasEarlier: true } } })
    vi.mocked(api.agentChatPage).mockResolvedValueOnce({ ...page(), hasLater: true,
      messages: [{ id: 'older', role: 'user', at: 0, text: 'old message' }] })
    await useAgent.getState().loadPage('chat-test', 'earlier')
    expect(api.agentChatPage).toHaveBeenCalledWith('chat-test', { beforeId: 'a1', limit: 80 })
    expect(useAgent.getState().chats['chat-test'].messages.map(message => message.id)).toEqual(['older'])
    expect(useAgent.getState().pages['chat-test'].hasLater).toBe(true)
    expect(api.agentChatApply).not.toHaveBeenCalled()
  })
  it('keeps the displayed page on a failed navigation', async () => {
    vi.mocked(api.agentChatPage).mockRejectedValueOnce(new Error('read failed'))
    await useAgent.getState().loadPage('chat-test', 'earlier')
    expect(useAgent.getState().chats['chat-test'].messages[0].id).toBe('a1')
    expect(useAgent.getState().chats['chat-test'].error).toContain('read failed')
    expect(useAgent.getState().pageLoading['chat-test']).toBe(false)
  })

})
