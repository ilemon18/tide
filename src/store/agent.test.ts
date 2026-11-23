import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { api, type AgentContextAttachment, type AgentPlanAction, type AgentPermissionMode } from '../lib/ipc'
vi.mock('../lib/ipc', () => ({ api: { agentChatOpen: vi.fn(), agentChatApply: vi.fn(), agentSend: vi.fn(),
  agentChatPage: vi.fn(), agentChatList: vi.fn(), agentChatClone: vi.fn(), agentChatReset: vi.fn(), agentCancel: vi.fn(), agentPermissionRespond: vi.fn(), agentModels: vi.fn() }, errorText: (error: unknown) => error instanceof Error ? error.message : String(error) }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
const { settings, patchSettings } = vi.hoisted(() => {
  const settings = { agentEnabled: true, agentHistoryEnabled: true, agentDefaultProvider: '', agentDefaultModel: '', agentDefaultEffort: '',
    agentDefaultPermissionMode: 'workspace-write' as AgentPermissionMode, flush: vi.fn() }
  const patchSettings = vi.fn((patch: Partial<typeof settings>) => Object.assign(settings, patch))
  return { settings, patchSettings }
})
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ ...settings, patch: patchSettings }) } }))
const { setTabName, contextTabs } = vi.hoisted(() => ({ setTabName: vi.fn(), contextTabs: { tabs: [] as Array<{ id: string; kind: string; root: string }>, groups: [] as Array<{ activeId: string }> } }))
vi.mock('./tabs', () => ({ useTabs: { getState: () => ({ ...contextTabs, setTabName, openChat: vi.fn(), openChatInRight: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('./workspace', () => ({ activeRoot: () => null }))
import { findPendingPlanAction, findPendingQuestion, useAgent, type AgentChat } from './agent'
import { en } from '../i18n/messages/en'
import { es } from '../i18n/messages/es'
import { ja } from '../i18n/messages/ja'
import { ko } from '../i18n/messages/ko'
import { zhCN } from '../i18n/messages/zh-CN'
import { zhTW } from '../i18n/messages/zh-TW'
import { setMemoryProfile } from '../lib/memoryBudget'

const chat = (): AgentChat => ({ v: 1, id: 'chat-test', root: '/tmp/project', title: 'test', provider: 'codex',
  model: '', effort: '', sessionId: 'session-1', messages: [{ id: 'a1', role: 'assistant', at: 1, items: [] }],
  status: 'idle', error: null, createdAt: 1, updatedAt: 1 })
const page = () => ({ header: chat(), messages: chat().messages, hasEarlier: false, hasLater: false,
  total: 1, hasPendingQuestion: false, hasUnhandledPlanAction: false, pendingMessageId: null })
const contextAttachment = (id = 'context-1'): AgentContextAttachment => ({ id, kind: 'terminal-selection',
  sourceRoot: '/tmp/project', capturedAt: 1, text: 'captured error', label: 'Terminal', startupRel: '' })

describe('context attachment flow', () => {
  it('prefers a visible same-root chat, appends instructions, and preserves draft metadata and permissions', () => {
    const current = { ...chat(), planning: true, permissionMode: 'read-only' as const }
    useAgent.setState({ chats: { 'chat-test': current, hidden: { ...chat(), id: 'hidden' } },
      chatFocusOrder: { hidden: 1000 },
      chatDrafts: { 'chat-test': { text: 'Keep this', mentions: [{ rel: 'a.ts', isDir: false }], command: 'plan' } } })
    contextTabs.tabs = [{ id: 'chat:hidden', kind: 'chat', root: '/tmp/project' },
      { id: 'chat:chat-test', kind: 'chat', root: '/tmp/project' }]
    contextTabs.groups = [{ activeId: 'chat:chat-test' }]
    expect(useAgent.getState().addContext('/tmp/project', [contextAttachment()], 'explain')).toBe(true)
    expect(useAgent.getState().chatDrafts['chat-test']).toMatchObject({ text: 'Keep this\n\nagent.context.explainPrompt',
      mentions: [{ rel: 'a.ts', isDir: false }], command: 'plan', attachments: [contextAttachment()] })
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ planning: true, permissionMode: 'read-only' })
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(useAgent.getState().focusRequests['chat-test']).toBe(1)
  })

  it('creates a source-root chat and rejects mismatches and oversized additions atomically', () => {
    expect(useAgent.getState().addContext('/tmp/project', [contextAttachment()])).toBe(true)
    const id = Object.keys(useAgent.getState().chatDrafts)[0]
    const before = useAgent.getState().chatDrafts[id]
    expect(before.attachments?.[0].text).toBe('captured error')
    expect(useAgent.getState().addContext('/other', [contextAttachment('other')])).toBe(false)
    expect(useAgent.getState().addContext('/tmp/project', [{ ...contextAttachment('large'), text: 'x'.repeat(32769) }])).toBe(false)
    expect(useAgent.getState().chatDrafts[id]).toBe(before)
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it('keeps snapshots through queue drain and preserves a newer draft', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'first', mentions: [] })
    const attachment = contextAttachment()
    await useAgent.getState().sendMessage('chat-test', { text: 'second', mentions: [], attachments: [attachment] })
    attachment.text = 'later mutation'
    useAgent.getState().setChatDraft('chat-test', { text: 'newer', attachments: [contextAttachment('new')] })
    const running = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: running.id, runId: running.activeRunId!, sequence: 1,
      event: { kind: 'done', ok: true, cancelled: false, code: 0 } })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ attachments: [contextAttachment()] }))
    expect(useAgent.getState().chatDrafts['chat-test'].text).toBe('newer')
    expect(useAgent.getState().chats['chat-test'].messages.find(message => message.text === 'second')?.attachments).toEqual([contextAttachment()])
  })

  it('retains attachments after launch failure and persists them with the user turn', async () => {
    const draft = { text: 'Analyze', mentions: [], attachments: [contextAttachment()] }
    useAgent.getState().setChatDraft('chat-test', draft)
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('launch failed'))
    await useAgent.getState().sendMessage('chat-test', draft)
    expect(useAgent.getState().chatDrafts['chat-test'].attachments).toEqual(draft.attachments)
    expect(api.agentChatApply).toHaveBeenCalledWith('chat-test', expect.objectContaining({
      upserts: expect.arrayContaining([expect.objectContaining({ role: 'user', attachments: draft.attachments })]),
    }))
  })

  it('recovers captured text from old compatible history without reading its source', async () => {
    useAgent.setState({ chats: {} })
    vi.mocked(api.agentChatOpen).mockResolvedValueOnce({ ...page(), messages: [
      { id: 'old', role: 'user', at: 1, text: 'legacy' },
      { id: 'new', role: 'user', at: 2, text: 'Analyze', attachments: [contextAttachment()] },
    ] })
    await useAgent.getState().loadChat('chat-test', '/tmp/project')
    expect(useAgent.getState().chats['chat-test'].messages[0].attachments).toBeUndefined()
    expect(useAgent.getState().chats['chat-test'].messages[1].attachments).toEqual([contextAttachment()])
  })

  it('enforces the shared light-mode draft and queue budget without consuming an addition', () => {
    setMemoryProfile('light')
    try {
      useAgent.setState({ queues: { other: Array.from({ length: 4 }, (_, index) => ({ id: String(index), text: 'queued', mentions: [],
        attachments: Array.from({ length: 4 }, (_, part) => ({ ...contextAttachment(index + '-' + part), text: 'x'.repeat(32768) })),
      })) } })
      const before = useAgent.getState().chatDrafts
      expect(useAgent.getState().addContext('/tmp/project', [contextAttachment()])).toBe(false)
      expect(useAgent.getState().chatDrafts).toBe(before)
      expect(useAgent.getState().queues.other).toHaveLength(4)
    } finally { setMemoryProfile('normal') }
  })

  it.each(['question', 'plan'] as const)('allows draft attachments while the %s gate continues blocking sends', async gate => {
    contextTabs.tabs = [{ id: 'chat:chat-test', kind: 'chat', root: '/tmp/project' }]
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasPendingQuestion: gate === 'question', hasUnhandledPlanAction: gate === 'plan' } } })
    expect(useAgent.getState().addContext('/tmp/project', [contextAttachment()], 'explain')).toBe(true)
    await useAgent.getState().sendMessage('chat-test', useAgent.getState().chatDrafts['chat-test'])
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(useAgent.getState().chatDrafts['chat-test'].attachments).toEqual([contextAttachment()])
  })
})
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  contextTabs.tabs = []
  contextTabs.groups = []
  Object.assign(settings, { agentEnabled: true, agentHistoryEnabled: true, agentDefaultProvider: '', agentDefaultModel: '', agentDefaultEffort: '',
    agentDefaultPermissionMode: 'workspace-write' })
  useAgent.setState({ chatFocusOrder: {}, chats: { 'chat-test': chat() }, pages: {}, pageLoading: {}, historyByRoot: {}, queues: {}, interjecting: {}, running: {}, chatDrafts: {}, focusRequests: {}, localPicker: null,
    catalogs: {}, catalogLoading: {}, chatDefaults: { provider: '', model: '', effort: '' },
    providers: [{ id: 'codex', name: 'Codex', installed: true, supported: true, command: 'codex', version: '1', supportsFork: true }] })
  vi.mocked(api.agentModels).mockResolvedValue({ provider: 'codex', models: [], efforts: ['low', 'medium', 'high'], defaultModel: '' })
  vi.mocked(api.agentChatApply).mockResolvedValue(page())
  vi.mocked(api.agentChatReset).mockResolvedValue({ ...page(), header: { ...chat(), title: '', sessionId: null, messages: [] }, messages: [], total: 0 })
  vi.mocked(api.agentChatOpen).mockResolvedValue(page())
  vi.mocked(api.agentChatList).mockResolvedValue({ chats: [], nextOffset: null })
  vi.mocked(api.agentSend).mockResolvedValue(undefined)
  vi.mocked(api.agentCancel).mockResolvedValue(undefined)
})

describe('project chat history', () => {
  it('loads five chats lazily per root and appends the next page', async () => {
    const chats = Array.from({ length: 5 }, (_, i) => ({ id: `chat-${i}`, root: '/tmp/project', title: `Chat ${i}`, provider: 'codex', model: '', updatedAt: i, messageCount: 2 }))
    vi.mocked(api.agentChatList).mockResolvedValueOnce({ chats, nextOffset: 5 }).mockResolvedValueOnce({ chats: [{ ...chats[0], id: 'chat-5' }], nextOffset: null })
    await useAgent.getState().loadHistory('/tmp/project')
    expect(api.agentChatList).toHaveBeenLastCalledWith('/tmp/project', 0, 5)
    expect(useAgent.getState().historyByRoot['/tmp/project'].chats).toHaveLength(5)
    await useAgent.getState().loadHistory('/tmp/project')
    expect(api.agentChatList).toHaveBeenLastCalledWith('/tmp/project', 5, 5)
    expect(useAgent.getState().historyByRoot['/tmp/project'].chats).toHaveLength(6)
    expect(api.agentChatList).not.toHaveBeenCalledWith('/another/project', expect.anything(), expect.anything())
  })

  it('does not request history while the preference is disabled', async () => {
    settings.agentHistoryEnabled = false
    await useAgent.getState().loadHistory('/tmp/project')
    expect(api.agentChatList).not.toHaveBeenCalled()
  })

  it('restores a history entry only when its stored project root matches', async () => {
    useAgent.setState({ chats: {} })
    vi.mocked(api.agentChatOpen).mockResolvedValueOnce({ ...page(), header: { ...chat(), root: '/other/project' } })
    expect(await useAgent.getState().resumeChat('chat-test', '/tmp/project')).toBe(false)
    expect(api.agentChatOpen).toHaveBeenCalledWith('chat-test', 80, '/tmp/project')
    expect(useAgent.getState().chats['chat-test']).toBeUndefined()

    vi.mocked(api.agentChatOpen).mockResolvedValueOnce(page())
    expect(await useAgent.getState().resumeChat('chat-test', '/tmp/project')).toBe(true)
    expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
    expect(useAgent.getState().chats['chat-test'].title).toBe('test')
    expect(setTabName).toHaveBeenCalledWith('chat:chat-test', 'test')
  })
})
afterEach(async () => {
  for (const current of Object.values(useAgent.getState().chats)) {
    if (current.status === 'running') {
      useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!,
        sequence: (current.eventSequence ?? 0) + 1,
        event: { kind: 'done', ok: false, cancelled: true, code: null } })
    }
  }
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('remembered Agent choices', () => {
  it('starts new chats with the last selected model, effort and permissions', () => {
    useAgent.getState().setChatOptions('chat-test', { model: 'custom-model' })
    useAgent.getState().setChatOptions('chat-test', { effort: 'high' })
    useAgent.getState().setPermissionMode('chat-test', 'full-access')
    expect(patchSettings).toHaveBeenCalledWith({ agentDefaultProvider: 'codex', agentDefaultModel: 'custom-model', agentDefaultEffort: 'high' })
    expect(patchSettings).toHaveBeenCalledWith({ agentDefaultPermissionMode: 'full-access' })
    const id = useAgent.getState().newChat('/tmp/project')!
    expect(useAgent.getState().chats[id]).toMatchObject({ provider: 'codex', model: 'custom-model', effort: 'high', permissionMode: 'full-access' })
  })

  it('persists empty model and effort when the user selects Default', () => {
    useAgent.getState().setChatOptions('chat-test', { model: 'custom-model', effort: 'high' })
    useAgent.getState().setChatOptions('chat-test', { model: '', effort: '' })
    expect(patchSettings).toHaveBeenLastCalledWith({ agentDefaultProvider: 'codex', agentDefaultModel: '', agentDefaultEffort: '' })
    const id = useAgent.getState().newChat('/tmp/project')!
    expect(useAgent.getState().chats[id]).toMatchObject({ provider: 'codex', model: '', effort: '' })
  })

  it('remembers the corrected effort after switching to an incompatible model', () => {
    useAgent.setState({ catalogs: { codex: { provider: 'codex', defaultModel: '', efforts: ['high', 'low'],
      models: [{ id: 'small', label: 'Small', efforts: ['low'], defaultEffort: 'low' }] } },
      chats: { 'chat-test': { ...chat(), effort: 'high' } } })
    useAgent.getState().setChatOptions('chat-test', { model: 'small' })
    expect(settings).toMatchObject({ agentDefaultProvider: 'codex', agentDefaultModel: 'small', agentDefaultEffort: 'low' })
    expect(useAgent.getState().chats['chat-test'].effort).toBe('low')
  })

  it('resets model and effort when the user switches providers', () => {
    Object.assign(settings, { agentDefaultProvider: 'codex', agentDefaultModel: 'codex-model', agentDefaultEffort: 'high', agentDefaultPermissionMode: 'full-access' })
    useAgent.getState().setChatProvider('chat-test', 'claude')
    expect(patchSettings).toHaveBeenLastCalledWith({ agentDefaultProvider: 'claude', agentDefaultModel: '', agentDefaultEffort: '' })
    expect(settings.agentDefaultPermissionMode).toBe('full-access')
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ provider: 'claude', model: '', effort: '', sessionId: null })
  })

  it('applies automatic provider fallback without overwriting the saved choice', () => {
    Object.assign(settings, { agentDefaultProvider: 'claude', agentDefaultModel: 'claude-model', agentDefaultEffort: 'high' })
    useAgent.setState({ chats: { 'chat-test': { ...chat(), provider: '' } } })
    useAgent.getState().resolveDefaults()
    useAgent.getState().setChatProvider('chat-test', useAgent.getState().chatDefaults.provider, { remember: false })
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ provider: 'codex', model: '', effort: '' })
    expect(patchSettings).not.toHaveBeenCalled()
    expect(settings.agentDefaultProvider).toBe('claude')
  })

  it('restores historical chat options without changing saved defaults', async () => {
    Object.assign(settings, { agentDefaultProvider: 'codex', agentDefaultModel: 'new-model', agentDefaultEffort: 'high', agentDefaultPermissionMode: 'full-access' })
    useAgent.setState({ chats: {} })
    vi.mocked(api.agentChatOpen).mockResolvedValueOnce({ ...page(),
      header: { ...chat(), model: 'old-model', effort: 'low', permissionMode: 'read-only' } })
    await useAgent.getState().loadChat('chat-test')
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ model: 'old-model', effort: 'low', permissionMode: 'read-only' })
    expect(patchSettings).not.toHaveBeenCalled()
    const id = useAgent.getState().newChat('/tmp/project')!
    expect(useAgent.getState().chats[id]).toMatchObject({ model: 'new-model', effort: 'high', permissionMode: 'full-access' })
  })

  it('uses the same persistence for local model and permissions commands', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/model custom-model', mentions: [] })
    expect(settings).toMatchObject({ agentDefaultProvider: 'codex', agentDefaultModel: 'custom-model' })
    await useAgent.getState().sendMessage('chat-test', { text: '/model default', mentions: [] })
    expect(settings.agentDefaultModel).toBe('')
    await useAgent.getState().sendMessage('chat-test', { text: '/permissions read-only', mentions: [] })
    expect(settings.agentDefaultPermissionMode).toBe('read-only')
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it('keeps temporary Plan permissions out of saved preferences', async () => {
    useAgent.getState().setPermissionMode('chat-test', 'full-access')
    patchSettings.mockClear()
    await useAgent.getState().sendMessage('chat-test', { text: '', command: 'plan', mentions: [] })
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ permissionMode: 'read-only', planning: true })
    await useAgent.getState().sendMessage('chat-test', { text: '', command: 'plan', mentions: [] })
    expect(settings.agentDefaultPermissionMode).toBe('full-access')
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it('does not save rejected picker changes during a running turn', () => {
    useAgent.setState({ chats: { 'chat-test': { ...chat(), status: 'running', activeRunId: 'run-test' } } })
    useAgent.getState().setChatOptions('chat-test', { model: 'custom-model', effort: 'high' })
    useAgent.getState().setPermissionMode('chat-test', 'full-access')
    useAgent.getState().setChatProvider('chat-test', 'claude')
    expect(patchSettings).not.toHaveBeenCalled()
  })
})

describe('chat protocol state', () => {
  it.each([
    { name: 'trimmed first line', text: '  \n  Fix login failure  \nMore details here  ', title: 'Fix login failure' },
    { name: 'exactly 48 characters', text: 'x'.repeat(48), title: 'x'.repeat(48) },
    { name: 'over 48 characters', text: 'x'.repeat(49), title: `${'x'.repeat(48)}…` },
    { name: 'Unicode code points', text: '\u{1f680}'.repeat(49), title: `${'\u{1f680}'.repeat(48)}…` },
  ])('uses the first prompt for the conversation and tab title: $name', async ({ text, title }) => {
    useAgent.setState({ chats: { 'chat-test': { ...chat(), title: '', sessionId: null, messages: [] } } })

    await useAgent.getState().sendMessage('chat-test', { text, mentions: [] })

    expect(useAgent.getState().chats['chat-test'].title).toBe(title)
    expect(setTabName).toHaveBeenCalledWith('chat:chat-test', title)
    expect(api.agentChatApply).toHaveBeenCalledWith('chat-test', expect.objectContaining({
      header: expect.objectContaining({ title }),
    }))
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })

  it.each([
    { name: 'successful', ok: true, cancelled: false },
    { name: 'failed', ok: false, cancelled: false },
    { name: 'cancelled', ok: false, cancelled: true },
  ])('keeps the chat tab title stable during and after a $name turn', async ({ ok, cancelled }) => {
    await useAgent.getState().sendMessage('chat-test', { text: 'Continue work', mentions: [] })
    expect(setTabName).toHaveBeenCalledTimes(1)
    expect(setTabName).toHaveBeenCalledWith('chat:chat-test', 'test')
    setTabName.mockClear()

    await vi.advanceTimersByTimeAsync(65_000)
    expect(useAgent.getState().chats['chat-test'].status).toBe('running')
    expect(setTabName).not.toHaveBeenCalled()

    finishTurn(ok, cancelled)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(setTabName).not.toHaveBeenCalled()
    expect(useAgent.getState().chats['chat-test'].title).toBe('test')
  })

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
    expect(setTabName).toHaveBeenCalledTimes(1)
    expect(setTabName).toHaveBeenCalledWith('chat:chat-test', 'test')
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
    const commands = ['/new', '/resume', '/fork', '/compact', '/status', '/model', '/permissions', '/plan', '/goal', '/review', '/test', '/explain', '/help']
    for (const catalog of [en, es, ja, ko, zhCN, zhTW]) {
      for (const command of commands) expect(catalog['agent.local.helpText']).toContain(command)
    }
  })
  it('resets /new in the current chat and keeps the selected agent options', async () => {
    const current = useAgent.getState().chats['chat-test']
    useAgent.setState({
      chats: { 'chat-test': { ...current, title: 'Keep provider', model: 'custom', effort: 'high', permissionMode: 'full-access', sessionUsage: { inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0, totalTokens: 3, costUsd: null }, messages: [{ id: 'old', role: 'user', at: 1, text: 'old' }] } },
      chatDrafts: { 'chat-test': { text: 'draft', mentions: [{ rel: 'src', isDir: true }], skills: [{ name: 'audit', path: 'audit', source: 'project' }] } },
      queues: { 'chat-test': [{ id: 'queued', text: 'later', mentions: [] }] },
    })
    vi.mocked(api.agentChatReset).mockResolvedValueOnce({
      ...page(),
      header: { ...current, title: '', model: 'custom', effort: 'high', permissionMode: 'full-access', sessionId: null, sessionUsage: null, messages: [] },
      messages: [],
      total: 0,
    })
    await useAgent.getState().sendMessage('chat-test', { text: '/new', mentions: [] })
    const next = useAgent.getState().chats['chat-test']
    expect(api.agentChatReset).toHaveBeenCalledWith('chat-test', expect.objectContaining({ messages: [] }))
    expect(next.id).toBe('chat-test')
    expect(next.messages).toEqual([])
    expect(next.sessionId).toBeNull()
    expect(next.sessionUsage).toBeUndefined()
    expect(next.provider).toBe('codex')
    expect(next.model).toBe('custom')
    expect(next.effort).toBe('high')
    expect(next.permissionMode).toBe('full-access')
    expect(useAgent.getState().chatDrafts['chat-test']).toBeUndefined()
    expect(useAgent.getState().queues['chat-test']).toBeUndefined()
  })
  it('clears the tab title on /new and names it from the next prompt', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/new', mentions: [] })

    expect(useAgent.getState().chats['chat-test'].title).toBe('')
    expect(setTabName).toHaveBeenLastCalledWith('chat:chat-test', '')
    expect(api.agentSend).not.toHaveBeenCalled()
    setTabName.mockClear()

    await useAgent.getState().sendMessage('chat-test', { text: 'Investigate a new issue\nSteps to reproduce', mentions: [] })

    expect(useAgent.getState().chats['chat-test'].title).toBe('Investigate a new issue')
    expect(setTabName).toHaveBeenCalledWith('chat:chat-test', 'Investigate a new issue')
    expect(api.agentSend).toHaveBeenCalledTimes(1)

    finishTurn()
    await useAgent.getState().sendMessage('chat-test', { text: 'Continue investigating', mentions: [] })

    expect(useAgent.getState().chats['chat-test'].title).toBe('Investigate a new issue')
    expect(setTabName).toHaveBeenLastCalledWith('chat:chat-test', 'Investigate a new issue')
    expect(api.agentSend).toHaveBeenCalledTimes(2)
  })
  it('keeps the transcript, draft and queue when cancelling /new fails', async () => {
    const current = useAgent.getState().chats['chat-test']
    const running = { ...current, status: 'running' as const, activeRunId: 'run-1', eventSequence: 1,
      messages: [{ id: 'old', role: 'assistant' as const, at: 1, items: [{ id: 'text', type: 'text' as const, text: 'still working' }] }] }
    useAgent.setState({
      chats: { 'chat-test': running },
      chatDrafts: { 'chat-test': { text: '/new', mentions: [] } },
      queues: { 'chat-test': [{ id: 'queued', text: 'later', mentions: [] }] },
    })
    vi.mocked(api.agentCancel).mockRejectedValueOnce(new Error('cancel failed'))

    await useAgent.getState().sendMessage('chat-test', { text: '/new', mentions: [] })

    expect(api.agentChatReset).not.toHaveBeenCalled()
    expect(useAgent.getState().chats['chat-test'].messages[0].id).toBe('old')
    expect(useAgent.getState().chatDrafts['chat-test']).toMatchObject({ text: '/new' })
    expect(useAgent.getState().queues['chat-test']).toEqual([{ id: 'queued', text: 'later', mentions: [] }])
    expect(useAgent.getState().chats['chat-test'].error).toBe('cancel failed')
  })
  it('does not start a new turn while the in-place reset is pending', async () => {
    let finishReset!: (value: ReturnType<typeof page>) => void
    vi.mocked(api.agentChatReset).mockReturnValueOnce(new Promise(resolve => { finishReset = resolve }))

    const reset = useAgent.getState().resetChat('chat-test')
    await Promise.resolve()
    await useAgent.getState().sendMessage('chat-test', { text: 'must wait', mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()

    finishReset({ ...page(), header: { ...chat(), title: '', sessionId: null, messages: [] }, messages: [], total: 0 })
    expect(await reset).toBe(true)
  })
  it('merges a history page without saving it over unloaded messages', async () => {
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasEarlier: true } } })
    vi.mocked(api.agentChatPage).mockResolvedValueOnce({ ...page(), hasLater: true,
      messages: [{ id: 'older', role: 'user', at: 0, text: 'old message' }] })
    await useAgent.getState().loadPage('chat-test', 'earlier')
    expect(api.agentChatPage).toHaveBeenCalledWith('chat-test', { beforeId: 'a1', limit: 40 })
    expect(useAgent.getState().chats['chat-test'].messages.map(message => message.id)).toEqual(['older', 'a1'])
    expect(useAgent.getState().pages['chat-test'].hasLater).toBe(false)
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

async function startPlanning() {
  await useAgent.getState().sendMessage('chat-test', { text: 'Plan a fix', command: 'plan', mentions: [] })
}

function finishTurn(ok = true, cancelled = false) {
  const current = useAgent.getState().chats['chat-test']
  useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!,
    sequence: (current.eventSequence ?? 0) + 1,
    event: { kind: 'done', ok, cancelled, code: ok ? 0 : 1 } })
}

function streamPlan(text = 'Update the handler and cover retries.') {
  const current = useAgent.getState().chats['chat-test']
  useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!,
    sequence: (current.eventSequence ?? 0) + 1,
    event: { kind: 'textDelta', itemId: 'plan-text', text } })
}

function pendingPlan() {
  return findPendingPlanAction(useAgent.getState().chats['chat-test'].messages)
}

describe('plan completion and actions', () => {
  it('does not gate sends while a structured question is still streaming', async () => {
    await startPlanning()
    const current = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 1,
      event: { kind: 'question', itemId: 'question', header: 'Scope', question: 'Which scope?',
        multiSelect: false, options: [{ label: 'Small', description: 'One module' }, { label: 'Large', description: 'All modules' }] } })
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)).toBeNull()
    expect(useAgent.getState().chats['chat-test'].messages.at(-1)?.items?.at(-1)).toMatchObject({ type: 'question', complete: false })
    await useAgent.getState().sendMessage('chat-test', { text: 'continue after output', mentions: [] })
    expect(useAgent.getState().queues['chat-test']).toHaveLength(1)
    finishTurn(true, true)
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)).toBeNull()
    expect(useAgent.getState().queues['chat-test']).toHaveLength(1)
  })

  it('adds one choice card, keeps the plan text, and blocks queued and direct sends immediately', async () => {
    await startPlanning()
    streamPlan()
    await useAgent.getState().sendMessage('chat-test', { text: 'queued work', mentions: [] })
    const running = useAgent.getState().chats['chat-test']
    finishTurn()
    expect(pendingPlan()?.item).toMatchObject({ type: 'plan', text: '', resolved: false })
    expect(pendingPlan()?.message.items?.filter(item => item.type === 'text')).toHaveLength(1)
    await useAgent.getState().sendMessage('chat-test', { text: 'bypass choice', mentions: [] })
    useAgent.getState().applyEvent({ chatId: running.id, runId: running.activeRunId!, sequence: 99,
      event: { kind: 'done', ok: true, cancelled: false, code: 0 } })
    expect(pendingPlan()?.message.items?.filter(item => item.type === 'plan')).toHaveLength(1)
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().queues['chat-test']).toHaveLength(1)
  })

  it.each([
    { name: 'failed', ok: false, cancelled: false, readOnly: true, text: 'Partial plan' },
    { name: 'cancelled', ok: true, cancelled: true, readOnly: true, text: 'Partial plan' },
    { name: 'empty', ok: true, cancelled: false, readOnly: true, text: ' ' },
    { name: 'ordinary', ok: true, cancelled: false, readOnly: false, text: 'Normal reply' },
  ])('does not offer execution after a $name turn', async ({ ok, cancelled, readOnly, text }) => {
    await useAgent.getState().sendMessage('chat-test', {
      text: 'task', command: readOnly ? 'plan' : undefined, mentions: [],
    })
    streamPlan(text)
    finishTurn(ok, cancelled)
    expect(pendingPlan()).toBeNull()
  })

  it('waits for a clarification answer and offers execution after the read-only follow-up', async () => {
    await startPlanning()
    streamPlan('Need a decision first.')
    const current = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 2,
      event: { kind: 'question', itemId: 'question', header: 'Scope', question: 'Which scope?',
        multiSelect: false, options: [{ label: 'Small', description: 'One module' }, { label: 'Large', description: 'All modules' }] } })
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)).toBeNull()
    finishTurn()
    expect(useAgent.getState().chats['chat-test'].messages.at(-1)?.items?.find(item => item.id === 'question')).toMatchObject({ complete: true })
    expect(pendingPlan()).toBeNull()
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'Small')).toBe(true)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }))
    streamPlan()
    finishTurn()
    expect(pendingPlan()).not.toBeNull()
  })

  it.each(['read-only', 'workspace-write', 'full-access', undefined] as const)(
    'executes in the current session once and preserves or promotes permission mode %s', async permissionMode => {
    useAgent.setState({ chats: { 'chat-test': { ...chat(), permissionMode } } })
    await startPlanning(); streamPlan(); finishTurn()
    const id = pendingPlan()!.item.id
    const selected = useAgent.getState().resolvePlanAction('chat-test', id, 'implement-current', 'Keep the public API')
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-current')).toBe(false)
    expect(await selected).toBe(true)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: false, sessionAction: 'resume',
      permissionMode: permissionMode === 'full-access' ? 'full-access' : 'workspace-write',
      sessionId: 'session-1', prompt: expect.stringContaining('Keep the public API') }))
    expect(pendingPlan()).toBeNull()
    expect(useAgent.getState().chats['chat-test'].permissionMode).toBe(
      permissionMode === 'read-only' ? 'workspace-write' : permissionMode)
  })

  it('hands only the approved plan to an isolated chat in the same project', async () => {
    await startPlanning(); streamPlan(); finishTurn()
    const id = pendingPlan()!.item.id
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-fresh', 'Keep the public API')).toBe(true)
    const request = vi.mocked(api.agentSend).mock.calls.at(-1)![0]
    expect(request).toMatchObject({ root: '/tmp/project', sessionAction: 'new', sessionId: null, readOnly: false })
    expect(request.chatId).not.toBe('chat-test')
    expect(request.prompt).toContain('Update the handler and cover retries.')
    expect(request.prompt).toContain('Keep the public API')
    const target = useAgent.getState().chats[request.chatId]
    expect(target.messages).toHaveLength(2)
    expect(target.messages[0].text).not.toContain('Plan a fix')
    const card = useAgent.getState().chats['chat-test'].messages.flatMap(message => message.items ?? []).find(item => item.id === id)
    expect(card).toMatchObject({ action: 'implement-fresh', targetChatId: request.chatId, actionState: 'completed', resolved: true })
    expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
  })

  it('continues planning by focusing a draft without launching another turn', async () => {
    await startPlanning(); streamPlan(); finishTurn()
    const id = pendingPlan()!.item.id
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'continue-planning', 'Cover failures')).toBe(true)
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().chatDrafts['chat-test'].text).toBe('Cover failures')
    expect(useAgent.getState().focusRequests['chat-test']).toBe(1)
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ permissionMode: 'read-only', planning: true })
  })

  it('restores the pending card and queue guard when launching execution fails, then permits retry', async () => {
    await startPlanning()
    streamPlan()
    finishTurn()
    const id = pendingPlan()!.item.id
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasUnhandledPlanAction: true, pendingMessageId: pendingPlan()!.message.id } } })
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('resume failed'))
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-current')).toBe(false)
    expect(pendingPlan()?.item.id).toBe(id)
    expect(useAgent.getState().pages['chat-test'].hasUnhandledPlanAction).toBe(true)
    expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
    await useAgent.getState().sendMessage('chat-test', { text: 'cannot bypass', mentions: [] })
    expect(api.agentSend).toHaveBeenCalledTimes(2)
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-current')).toBe(true)
    expect(useAgent.getState().pages['chat-test'].hasUnhandledPlanAction).toBe(false)
    expect(api.agentSend).toHaveBeenCalledTimes(3)
  })

  it('rejects unknown actions without resolving the card or starting a turn', async () => {
    await startPlanning()
    streamPlan()
    finishTurn()
    const id = pendingPlan()!.item.id
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'unknown' as AgentPlanAction)).toBe(false)
    expect(pendingPlan()?.item.id).toBe(id)
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })

  it('offers a new choice after refinement while keeping the previous card resolved', async () => {
    await startPlanning()
    streamPlan()
    finishTurn()
    const oldId = pendingPlan()!.item.id
    await useAgent.getState().resolvePlanAction('chat-test', oldId, 'continue-planning', 'Cover failures')
    await useAgent.getState().sendMessage('chat-test', useAgent.getState().chatDrafts['chat-test'])
    streamPlan('Updated plan covering failures.')
    finishTurn()
    expect(pendingPlan()?.item.id).not.toBe(oldId)
    const oldCard = useAgent.getState().chats['chat-test'].messages.flatMap(message => message.items ?? [])
      .find(item => item.id === oldId)
    expect(oldCard?.resolved).toBe(true)
  })

  it('blocks sends when an unresolved plan is outside the loaded page', async () => {
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasUnhandledPlanAction: true, pendingMessageId: 'old-plan' } } })
    await useAgent.getState().sendMessage('chat-test', { text: 'wait', mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it('preserves unresolved plan choices through persistence and reopening', async () => {
    let saved = page()
    vi.mocked(api.agentChatApply).mockImplementation(async (_id, patch) => {
      saved = { ...page(), header: patch.header as AgentChat,
        messages: patch.upserts as AgentChat['messages'], hasUnhandledPlanAction: true, pendingMessageId: null }
      return saved
    })
    vi.mocked(api.agentChatOpen).mockImplementation(async () => saved)
    await startPlanning()
    streamPlan()
    finishTurn()
    const id = pendingPlan()!.item.id
    await vi.runAllTimersAsync()
    useAgent.setState({ chats: {}, pages: {} })
    await useAgent.getState().loadChat('chat-test')
    expect(pendingPlan()?.item.id).toBe(id)
    expect(pendingPlan()?.message.readOnly).toBe(true)
  })
})

describe('persistent modes, local commands and usage', () => {
  it('toggles /plan without a provider turn and keeps ordinary follow-ups read-only', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/plan', mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ planning: true, permissionMode: 'read-only' })
    await useAgent.getState().sendMessage('chat-test', { text: 'Inspect the handler', mentions: [] })
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }))
    finishTurn(false)
    expect(useAgent.getState().chats['chat-test'].planning).toBe(true)
  })

  it('does not turn an ordinary permissions read-only query into a plan card', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/permissions read-only', mentions: [] })
    await useAgent.getState().sendMessage('chat-test', { text: 'What does this function do?', mentions: [] })
    streamPlan('It handles events.'); finishTurn()
    expect(pendingPlan()).toBeNull()
    expect(useAgent.getState().chats['chat-test'].permissionMode).toBe('read-only')
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }))
  })

  it('opens project-local resume, model and permissions selectors without provider prompts', async () => {
    for (const kind of ['resume', 'model', 'permissions'] as const) {
      await useAgent.getState().sendMessage('chat-test', { text: `/${kind}`, mentions: [] })
      expect(useAgent.getState().localPicker?.kind).toBe(kind)
    }
    expect(api.agentChatList).not.toHaveBeenCalled()
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it.each(['/new extra', '/fork extra', '/permissions unsafe', '/unknown'])('rejects invalid local input %s', async text => {
    await useAgent.getState().sendMessage('chat-test', { text, mentions: [] })
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(useAgent.getState().chats['chat-test'].error).toBe('agent.local.invalidArgs')
  })

  it('replaces repeated turn usage and retains the current context when a history page loads', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'hello', mentions: [] })
    const current = useAgent.getState().chats['chat-test']
    const usage = { inputTokens: 100, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 10,
      reasoningOutputTokens: 0, totalTokens: 110, costUsd: 0.01, contextTokens: 20, contextWindow: 100 }
    for (let sequence = 1; sequence <= 3; sequence++) useAgent.getState().applyEvent({ chatId: current.id,
      runId: current.activeRunId!, sequence, event: { kind: 'usage', usage } })
    expect(useAgent.getState().chats['chat-test'].sessionUsage?.totalTokens).toBe(110)
    expect(useAgent.getState().chats['chat-test'].currentContext?.contextTokens).toBe(20)
    finishTurn()
    const saved = useAgent.getState().chats['chat-test']
    vi.mocked(api.agentChatOpen).mockResolvedValue({ ...page(), header: saved, messages: saved.messages })
    vi.mocked(api.agentChatPage).mockResolvedValueOnce({ ...page(), header: saved, hasLater: true,
      messages: [{ id: 'old', role: 'assistant', at: 0, usage: { ...usage, contextTokens: 90 } }] })
    await useAgent.getState().loadPage('chat-test', 'earlier')
    expect(useAgent.getState().chats['chat-test'].currentContext?.contextTokens).toBe(20)
    useAgent.getState().restartSession('chat-test')
    expect(useAgent.getState().chats['chat-test'].sessionUsage).toBeUndefined()
    expect(useAgent.getState().chats['chat-test'].currentContext).toBeUndefined()
  })

  it('forks Codex only when the installed CLI advertises native fork support', async () => {
    vi.mocked(api.agentChatClone).mockResolvedValueOnce({ ...page(), header: { ...chat(), id: 'forked', sessionAction: 'fork' } })
    await useAgent.getState().sendMessage('chat-test', { text: '/fork', mentions: [] })
    expect(api.agentChatClone).toHaveBeenCalledWith('chat-test', expect.objectContaining({ sessionAction: 'fork' }))
    useAgent.setState({ providers: [] })
    await useAgent.getState().sendMessage('chat-test', { text: '/fork', mentions: [] })
    expect(useAgent.getState().chats['chat-test'].error).toBe('agent.local.forkUnsupported')
    expect(api.agentChatClone).toHaveBeenCalledTimes(1)
  })

  it('compacts read-only, persists the summary before resetting the session, and uses it next turn', async () => {
    settings.agentDefaultPermissionMode = 'full-access'
    await useAgent.getState().sendMessage('chat-test', { text: '/compact', mentions: [] })
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, sessionAction: 'resume' }))
    streamPlan('Task summary with remaining steps.'); finishTurn()
    await vi.advanceTimersByTimeAsync(0)
    expect(pendingPlan()).toBeNull()
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ sessionId: null, compactSummary: 'Task summary with remaining steps.' })
    await useAgent.getState().sendMessage('chat-test', { text: 'continue', mentions: [] })
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ sessionAction: 'new', sessionId: null,
      prompt: expect.stringContaining('Previous conversation summary:') }))
    expect(useAgent.getState().chats['chat-test'].messages.some(message => message.items?.some(item => item.text === 'Task summary with remaining steps.'))).toBe(true)
    expect(settings.agentDefaultPermissionMode).toBe('full-access')
    expect(patchSettings).not.toHaveBeenCalled()
  })

  it('retains the original session if compact summary persistence fails', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: '/compact', mentions: [] })
    streamPlan('Summary')
    vi.mocked(api.agentChatApply).mockRejectedValueOnce(new Error('disk full'))
    finishTurn()
    await vi.advanceTimersByTimeAsync(0)
    expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
    expect(useAgent.getState().chats['chat-test'].compactSummary).toBeUndefined()
  })
})

describe('bounded history windows', () => {
  it('persists the complete prefix before keeping only the latest 160 records', async () => {
    const messages = Array.from({ length: 159 }, (_, i) => ({ id: `old-${i}`, role: 'user' as const, at: i, text: 'saved history' }))
    useAgent.setState({ chats: { 'chat-test': { ...chat(), messages } } })
    await useAgent.getState().sendMessage('chat-test', { text: 'new work', mentions: [] })
    await vi.advanceTimersByTimeAsync(0)
    const current = useAgent.getState().chats['chat-test']
    expect(current.messages.length).toBeLessThanOrEqual(160)
    expect(useAgent.getState().pages['chat-test'].hasEarlier).toBe(true)
    expect(vi.mocked(api.agentChatApply).mock.calls.some(([, patch]) => patch.upserts.some(message => message.id === 'old-0'))).toBe(true)
  })

  it('displays an oversized active message alone after persisting the preceding transcript', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'large response', mentions: [] })
    streamPlan('x'.repeat(1024 * 1024 + 10))
    await vi.advanceTimersByTimeAsync(0)
    const current = useAgent.getState().chats['chat-test']
    expect(current.messages).toHaveLength(1)
    expect(current.messages[0].items?.[0].text.length).toBeGreaterThan(1024 * 1024)
    expect(vi.mocked(api.agentChatApply).mock.calls.some(([, patch]) => patch.upserts.some(message => message.id === 'a1'))).toBe(true)
  })
})

describe('action recovery and durable session resets', () => {
  it('retries a failed fresh-context launch in the same target without inheriting parent history', async () => {
    await startPlanning(); streamPlan(); finishTurn()
    const id = pendingPlan()!.item.id
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('start failed'))
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-fresh')).toBe(false)
    const target = pendingPlan()!.item.targetChatId
    expect(target).toBeTruthy()
    expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-fresh')).toBe(true)
    expect(vi.mocked(api.agentSend).mock.calls.at(-1)![0]).toMatchObject({ chatId: target, sessionId: null, sessionAction: 'new' })
    expect(Object.keys(useAgent.getState().chats)).toHaveLength(2)
  })

  it('does not relaunch a recovered card when its accepted destination already exists', async () => {
    const source = chat()
    source.messages = [{ id: 'plan', role: 'assistant', at: 0, items: [{ id: 'choice', type: 'plan', text: 'approved',
      resolved: false, action: 'implement-fresh', targetChatId: 'destination', actionState: 'failed' }] }]
    useAgent.setState({ chats: { 'chat-test': source, destination: { ...chat(), id: 'destination', sessionId: null,
      messages: [{ id: 'accepted', role: 'assistant', at: 1, planActionId: 'choice', launchAccepted: true, items: [] }] } } })
    expect(await useAgent.getState().resolvePlanAction('chat-test', 'choice', 'implement-fresh')).toBe(true)
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it('replaces unavailable streaming cost when the final priced snapshot arrives', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'work', mentions: [] })
    const current = useAgent.getState().chats['chat-test']
    const usage = { inputTokens: 10, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 1,
      reasoningOutputTokens: 0, totalTokens: 11, costUsd: null }
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 1, event: { kind: 'usage', usage } })
    expect(useAgent.getState().chats['chat-test'].sessionUsage?.costUsd).toBeNull()
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 2,
      event: { kind: 'usage', usage: { ...usage, costUsd: 0.02 } } })
    expect(useAgent.getState().chats['chat-test'].sessionUsage?.costUsd).toBe(0.02)
  })

  it('serializes explicit nulls so Rust merge persistence clears reset session statistics', async () => {
    useAgent.getState().restartSession('chat-test')
    await vi.advanceTimersByTimeAsync(700)
    expect(api.agentChatApply).toHaveBeenCalledWith('chat-test', expect.objectContaining({
      header: expect.objectContaining({ sessionId: null, sessionUsage: null, currentContext: null, compactSummary: null }),
    }))
  })

  it('keeps a restored pending question when its read-only answer cannot launch', async () => {
    settings.agentDefaultPermissionMode = 'full-access'
    useAgent.setState({ chats: { 'chat-test': { ...chat(), permissionMode: 'full-access' } } })
    await startPlanning()
    const current = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 1,
      event: { kind: 'question', itemId: 'q', header: 'Scope', question: 'Which?', multiSelect: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] } })
    finishTurn()
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('offline'))
    expect(await useAgent.getState().answerQuestion('chat-test', 'q', 'A')).toBe(false)
    expect(useAgent.getState().chats['chat-test'].messages.flatMap(message => message.items ?? []).find(item => item.id === 'q')?.answer).toBeUndefined()
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, permissionMode: 'read-only' }))
    expect(useAgent.getState().chats['chat-test'].permissionMode).toBe('full-access')
    expect(settings.agentDefaultPermissionMode).toBe('full-access')
    expect(patchSettings).not.toHaveBeenCalled()
    expect(await useAgent.getState().answerQuestion('chat-test', 'q', 'A')).toBe(true)
    expect(api.agentSend).toHaveBeenCalledTimes(3)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, permissionMode: 'read-only' }))
  })
})

describe('question answer transactions', () => {
  beforeEach(() => {
    const source: AgentChat = { ...chat(), permissionMode: 'full-access', planning: true, messages: [
      { id: 'source', role: 'assistant', at: 1, readOnly: true, planning: true, items: [
        { id: 'question', type: 'question', text: '', header: 'Scope', question: 'Which scope?',
          options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] },
      ] },
    ] }
    useAgent.setState({ chats: { 'chat-test': source }, pages: { 'chat-test': { ...page(),
      header: source, messages: source.messages, hasPendingQuestion: true, pendingMessageId: 'source' } } })
  })

  it('waits for the launch result, claims the answer immediately, and rejects duplicates', async () => {
    let finish!: () => void
    vi.mocked(api.agentSend).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve }))
    let settled = false
    const submission = useAgent.getState().answerQuestion('chat-test', 'question', ' A ').then(result => { settled = true; return result })
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)).toBeNull()
    expect(useAgent.getState().chats['chat-test'].messages[0].items![0].answer).toBe('A')
    expect(useAgent.getState().pages['chat-test'].hasPendingQuestion).toBe(false)
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'B')).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    finish()
    expect(await submission).toBe(true)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, permissionMode: 'read-only' }))
  })

  it('restores just the failed answer and pending page gates, preserves newer edits, and retries once', async () => {
    let fail!: (error: Error) => void
    vi.mocked(api.agentSend).mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject }))
    useAgent.setState({ queues: { 'chat-test': [{ id: 'queued', text: 'Later work', mentions: [] }] } })
    const submission = useAgent.getState().answerQuestion('chat-test', 'question', 'A')
    await vi.advanceTimersByTimeAsync(0)
    const current = useAgent.getState().chats['chat-test']
    useAgent.setState({ chats: { 'chat-test': { ...current, messages: current.messages.map(message => message.id === 'source' ? {
      ...message, durationMs: 77, items: [
        ...message.items!.map(item => ({ ...item, header: 'Updated scope', complete: true })),
        { id: 'new-notice', type: 'notice' as const, text: 'Newer detail' },
      ],
    } : message) } } })
    fail(new Error('offline'))
    expect(await submission).toBe(false)
    const restored = useAgent.getState().chats['chat-test']
    expect(restored.status).toBe('error')
    expect(restored.error).toBe('offline')
    expect(restored.messages[0].durationMs).toBe(77)
    expect(restored.messages[0].items).toEqual([
      expect.objectContaining({ id: 'question', header: 'Updated scope', complete: true, answer: undefined }),
      { id: 'new-notice', type: 'notice', text: 'Newer detail' },
    ])
    expect(findPendingQuestion(restored.messages)?.item.id).toBe('question')
    expect(useAgent.getState().pages['chat-test']).toMatchObject({ hasPendingQuestion: true, pendingMessageId: 'source' })
    await useAgent.getState().sendMessage('chat-test', { text: 'Cannot bypass the question', mentions: [] })
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().queues['chat-test']?.map(item => item.id)).toEqual(['queued'])
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'B')).toBe(true)
    expect(api.agentSend).toHaveBeenCalledTimes(2)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, permissionMode: 'read-only' }))
  })

  it('restores the question when launch setup throws before starting a run', async () => {
    settings.flush.mockImplementationOnce(() => { throw new Error('settings unavailable') })
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'A')).toBe(false)
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)?.item.id).toBe('question')
    expect(useAgent.getState().chats['chat-test']).toMatchObject({ status: 'idle', error: 'settings unavailable' })
    expect(useAgent.getState().pages['chat-test']).toMatchObject({ hasPendingQuestion: true, pendingMessageId: 'source' })
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'A')).toBe(true)
  })

  it('rolls back when navigating to recent history leaves the launch blocked', async () => {
    useAgent.setState({ pages: { 'chat-test': { ...useAgent.getState().pages['chat-test'], hasLater: true } } })
    vi.mocked(api.agentChatApply).mockRejectedValueOnce(new Error('save unavailable'))
    expect(await useAgent.getState().answerQuestion('chat-test', 'question', 'A')).toBe(false)
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)?.item.id).toBe('question')
    expect(useAgent.getState().pages['chat-test']).toMatchObject({ hasPendingQuestion: true, pendingMessageId: 'source' })
    expect(api.agentSend).not.toHaveBeenCalled()
  })

  it('persists the restored source question after it leaves the loaded history window', async () => {
    const source = useAgent.getState().chats['chat-test'].messages[0]
    let fail!: (error: Error) => void
    vi.mocked(api.agentSend).mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject }))
    const submission = useAgent.getState().answerQuestion('chat-test', 'question', 'A')
    await vi.advanceTimersByTimeAsync(0)
    const current = useAgent.getState().chats['chat-test']
    useAgent.setState({ chats: { 'chat-test': { ...current, messages: current.messages.filter(message => message.id !== 'source') } } })
    fail(new Error('offline'))
    expect(await submission).toBe(false)
    expect(api.agentChatApply).toHaveBeenLastCalledWith('chat-test', expect.objectContaining({ upserts: [source] }))
    expect(useAgent.getState().chats['chat-test'].messages.some(message => message.id === 'source')).toBe(false)
    expect(useAgent.getState().pages['chat-test']).toMatchObject({ hasPendingQuestion: true, pendingMessageId: 'source' })
    await useAgent.getState().sendMessage('chat-test', { text: 'Cannot bypass unloaded question', mentions: [] })
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })

  it.each(['running', 'disabled', 'paging', 'blank', 'wrong-question'] as const)('rejects a %s answer without claiming it', async gate => {
    if (gate === 'running') useAgent.setState({ chats: { 'chat-test': { ...useAgent.getState().chats['chat-test'], status: 'running', activeRunId: 'existing-run' } } })
    if (gate === 'disabled') settings.agentEnabled = false
    if (gate === 'paging') useAgent.setState({ pageLoading: { 'chat-test': true } })
    expect(await useAgent.getState().answerQuestion('chat-test', gate === 'wrong-question' ? 'other' : 'question', gate === 'blank' ? ' ' : 'A')).toBe(false)
    expect(findPendingQuestion(useAgent.getState().chats['chat-test'].messages)?.item.answer).toBeUndefined()
    expect(useAgent.getState().pages['chat-test'].hasPendingQuestion).toBe(true)
    expect(api.agentSend).not.toHaveBeenCalled()
  })
})

it('handles status locally during streaming without diverting subsequent output to a notice', async () => {
  await useAgent.getState().sendMessage('chat-test', { text: 'work', mentions: [] })
  const assistantId = useAgent.getState().chats['chat-test'].messages.at(-1)!.id
  await useAgent.getState().sendMessage('chat-test', { text: '/status', mentions: [] })
  streamPlan('Still writing')
  expect(useAgent.getState().chats['chat-test'].messages.at(-1)).toMatchObject({ id: assistantId,
    items: [{ id: 'plan-text', type: 'text', text: 'Still writing' }] })
  expect(api.agentSend).toHaveBeenCalledTimes(1)
})

it('rejects a fork that reports the parent session instead of silently resuming it', () => {
  useAgent.setState({ chats: { 'chat-test': { ...chat(), sessionAction: 'fork', status: 'running', activeRunId: 'fork-run' } } })
  useAgent.getState().applyEvent({ chatId: 'chat-test', runId: 'fork-run', sequence: 1,
    event: { kind: 'session', sessionId: 'session-1' } })
  expect(useAgent.getState().chats['chat-test']).toMatchObject({ status: 'error', sessionAction: 'fork', sessionId: 'session-1' })
  expect(api.agentCancel).toHaveBeenCalledWith('chat-test')
})

it('persists the action result even when starting from a plan on an older page', async () => {
  await startPlanning(); streamPlan(); finishTurn()
  const source = pendingPlan()!.message
  const id = pendingPlan()!.item.id
  useAgent.setState({ pages: { 'chat-test': { ...page(), hasLater: true, hasUnhandledPlanAction: true, pendingMessageId: source.id } } })
  vi.mocked(api.agentChatOpen).mockImplementation(async () => ({ ...page(), header: useAgent.getState().chats['chat-test'],
    messages: [{ id: 'recent', role: 'user', at: 20, text: 'recent history' }], hasEarlier: true }))
  expect(await useAgent.getState().resolvePlanAction('chat-test', id, 'implement-current')).toBe(true)
  expect(useAgent.getState().chats['chat-test'].messages.some(message => message.id === source.id)).toBe(false)
  expect(vi.mocked(api.agentChatApply).mock.calls.some(([, patch]) => patch.upserts.some(message => message.id === source.id &&
    (message.items as Array<{ id: string; actionState: string }>).some(item => item.id === id && item.actionState === 'completed')))).toBe(true)
})

it('restores a dequeued prompt after a failed provider resume without consuming later entries', async () => {
  useAgent.setState({ queues: { 'chat-test': [{ id: 'first', text: 'queued first', mentions: [] }] } })
  vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('resume unavailable'))
  await useAgent.getState().sendMessage('chat-test', { text: 'queued second', mentions: [] })
  await vi.advanceTimersByTimeAsync(0)
  expect(useAgent.getState().queues['chat-test'].map(item => item.text)).toEqual(['queued first', 'queued second'])
  expect(useAgent.getState().chats['chat-test'].sessionId).toBe('session-1')
})

describe('queued message interjection', () => {
  const first = { id: 'first', text: 'First queued', mentions: [] }
  const selected = { id: 'selected', text: '  Selected work\nKeep whitespace  ',
    mentions: [{ rel: 'src/a.ts', isDir: false }],
    attachments: [contextAttachment()],
    skills: [{ name: 'audit', path: 'skills/audit', source: 'project' as const }], command: 'plan' as const }
  const last = { id: 'last', text: 'Last queued', mentions: [] }
  const queue = () => useAgent.setState({ queues: { 'chat-test': [first, selected, last] } })

  it.each([true, false])('waits for Done and prioritizes the selection when the old turn succeeds=%s', async ok => {
    await useAgent.getState().sendMessage('chat-test', { text: 'Original work', mentions: [] })
    queue()
    const newDraft = { text: 'Still typing', mentions: [] }
    useAgent.setState({ chatDrafts: { 'chat-test': newDraft } })
    const pending = useAgent.getState().interjectQueued('chat-test', selected.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.agentCancel).toHaveBeenCalledWith('chat-test')
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().interjecting['chat-test']).toBe(selected.id)
    expect(await useAgent.getState().interjectQueued('chat-test', first.id)).toBe(false)
    useAgent.getState().removeQueued('chat-test', selected.id)
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected, last])
    finishTurn(ok, !ok)
    expect(await pending).toBe(true)
    expect(api.agentSend).toHaveBeenCalledTimes(2)
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ mentions: selected.mentions, attachments: selected.attachments, readOnly: true }))
    expect(useAgent.getState().chats['chat-test'].messages.at(-2)).toMatchObject({ role: 'user',
      text: selected.text, mentions: selected.mentions, attachments: selected.attachments, command: selected.command, skills: selected.skills })
    expect(useAgent.getState().queues['chat-test']).toEqual([first, last])
    expect(useAgent.getState().chatDrafts['chat-test']).toBe(newDraft)
    expect(useAgent.getState().interjecting['chat-test']).toBeUndefined()
  })

  it('starts an idle selection immediately and resumes the remaining FIFO queue after success', async () => {
    queue()
    expect(await useAgent.getState().interjectQueued('chat-test', last.id)).toBe(true)
    expect(api.agentCancel).not.toHaveBeenCalled()
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected])
    finishTurn()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.agentSend).toHaveBeenCalledTimes(2)
    expect(useAgent.getState().chats['chat-test'].messages.at(-2)?.text).toBe(first.text)
  })

  it('retains all messages and reports a cancellation error', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'Original work', mentions: [] })
    queue()
    vi.mocked(api.agentCancel).mockRejectedValueOnce(new Error('Cannot stop the turn'))
    expect(await useAgent.getState().interjectQueued('chat-test', selected.id)).toBe(false)
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected, last])
    expect(useAgent.getState().chats['chat-test'].error).toBe('Cannot stop the turn')
    expect(useAgent.getState().interjecting['chat-test']).toBeUndefined()
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })

  it('restores a failed launch in its original queue position and keeps the composer draft', async () => {
    queue()
    const draft = { text: 'New draft', mentions: [] }
    useAgent.setState({ chatDrafts: { 'chat-test': draft } })
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('Provider unavailable'))
    expect(await useAgent.getState().interjectQueued('chat-test', selected.id)).toBe(false)
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected, last])
    expect(useAgent.getState().chatDrafts['chat-test']).toBe(draft)
    expect(useAgent.getState().chats['chat-test'].error).toBe('Provider unavailable')
    expect(useAgent.getState().interjecting['chat-test']).toBeUndefined()
  })

  it.each(['question', 'plan', 'disabled', 'paging', 'missing'] as const)('respects the %s gate', async gate => {
    queue()
    if (gate === 'question') useAgent.setState({ pages: { 'chat-test': { ...page(), hasPendingQuestion: true } } })
    if (gate === 'plan') useAgent.setState({ pages: { 'chat-test': { ...page(), hasUnhandledPlanAction: true } } })
    if (gate === 'disabled') settings.agentEnabled = false
    if (gate === 'paging') useAgent.setState({ pageLoading: { 'chat-test': true } })
    expect(await useAgent.getState().interjectQueued('chat-test', gate === 'missing' ? 'missing' : selected.id)).toBe(false)
    expect(api.agentSend).not.toHaveBeenCalled()
    expect(api.agentCancel).not.toHaveBeenCalled()
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected, last])
  })

  it('rechecks question gates that arrive while cancellation is pending', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'Original work', mentions: [] })
    queue()
    const pending = useAgent.getState().interjectQueued('chat-test', selected.id)
    await vi.advanceTimersByTimeAsync(0)
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasPendingQuestion: true } } })
    finishTurn(false, true)
    expect(await pending).toBe(false)
    expect(api.agentSend).toHaveBeenCalledTimes(1)
    expect(useAgent.getState().queues['chat-test']).toEqual([first, selected, last])
  })

  it('loads the latest history page before sending an idle selection', async () => {
    queue()
    useAgent.setState({ pages: { 'chat-test': { ...page(), hasLater: true } } })
    expect(await useAgent.getState().interjectQueued('chat-test', selected.id)).toBe(true)
    expect(api.agentChatOpen).toHaveBeenCalledWith('chat-test', 80)
    expect(useAgent.getState().pages['chat-test'].hasLater).toBe(false)
  })

  it('waits for the original launch before cancelling and accepts Done before the cancel response', async () => {
    let launch!: () => void
    vi.mocked(api.agentSend).mockReturnValueOnce(new Promise<void>(resolve => { launch = resolve }))
    const original = useAgent.getState().sendMessage('chat-test', { text: 'Original work', mentions: [] })
    await vi.advanceTimersByTimeAsync(0)
    queue()
    const pending = useAgent.getState().interjectQueued('chat-test', last.id)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.agentCancel).not.toHaveBeenCalled()
    vi.mocked(api.agentCancel).mockImplementationOnce(async () => { finishTurn(false, true) })
    launch()
    await original
    expect(await pending).toBe(true)
    expect(api.agentSend).toHaveBeenCalledTimes(2)
  })

  it('releases the pending interjection when its chat closes', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'Original work', mentions: [] })
    queue()
    const pending = useAgent.getState().interjectQueued('chat-test', selected.id)
    await vi.advanceTimersByTimeAsync(0)
    useAgent.getState().forgetChat('chat-test')
    expect(await pending).toBe(false)
    expect(useAgent.getState().interjecting['chat-test']).toBeUndefined()
    expect(api.agentSend).toHaveBeenCalledTimes(1)
  })
})

describe('streaming permissions and completion records', () => {
  it('persists full access explicitly while planning sends a read-only override', async () => {
    useAgent.getState().setPermissionMode('chat-test', 'full-access')
    await useAgent.getState().sendMessage('chat-test', { text: 'run', mentions: [] })
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: 'full-access', readOnly: false }))
    const active = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: active.id, runId: active.activeRunId!, sequence: 1,
      event: { kind: 'done', ok: true, cancelled: false, code: null, durationMs: 1200, completedAt: 9000 } })
    const completed = useAgent.getState().chats['chat-test'].messages.at(-1)!
    expect(completed).toMatchObject({ completion: 'completed', durationMs: 1200, completedAt: 9000 })
    await useAgent.getState().sendMessage('chat-test', { text: '/plan propose changes', mentions: [] })
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ permissionMode: 'read-only', readOnly: true }))
    expect(useAgent.getState().chats['chat-test'].permissionMode).toBe('full-access')
  })

  it('persists a permission decision before IPC and blocks duplicate clicks and stale runs', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'run', mentions: [] })
    const active = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: active.id, runId: active.activeRunId!, sequence: 1,
      event: { kind: 'permissionRequest', itemId: 'p', requestId: 'native-1', operation: 'Write', detail: '/outside', reason: 'Need access' } })
    const first = useAgent.getState().respondPermission(active.id, 'native-1', true)
    const second = useAgent.getState().respondPermission(active.id, 'native-1', true)
    await Promise.all([first, second])
    expect(api.agentPermissionRespond).toHaveBeenCalledTimes(1)
    expect(api.agentPermissionRespond).toHaveBeenCalledWith(active.id, active.activeRunId, 'native-1', true)
    expect(vi.mocked(api.agentChatApply).mock.calls.some(([, patch]) => patch.upserts.some(message =>
      Array.isArray(message.items) && message.items.some((item: { permissionState?: string }) => item.permissionState === 'submitting')))).toBe(true)
    useAgent.getState().applyEvent({ chatId: active.id, runId: active.activeRunId!, sequence: 2,
      event: { kind: 'done', ok: false, cancelled: true, code: null } })
    expect(useAgent.getState().chats[active.id].messages.at(-1)?.items?.find(item => item.id === 'p')?.permissionState).toBe('expired')
    await useAgent.getState().respondPermission(active.id, 'native-1', true)
    expect(api.agentPermissionRespond).toHaveBeenCalledTimes(1)
  })

  it('replaces final snapshots without appending them and keeps tool/text ordering', async () => {
    await useAgent.getState().sendMessage('chat-test', { text: 'run', mentions: [] })
    const active = useAgent.getState().chats['chat-test']
    const events = [
      { kind: 'textDelta', itemId: 'a', text: 'Before' },
      { kind: 'toolStart', itemId: 'cmd', title: 'pwd' },
      { kind: 'toolOutputDelta', itemId: 'cmd', text: '中文🙂' },
      { kind: 'toolEnd', itemId: 'cmd', ok: true, output: '中文🙂 complete' },
      { kind: 'textDelta', itemId: 'b', text: 'Aft' },
      { kind: 'itemComplete', itemId: 'b', text: 'After' },
    ] as const
    events.forEach((event, index) => useAgent.getState().applyEvent({ chatId: active.id, runId: active.activeRunId!, sequence: index + 1, event }))
    const items = useAgent.getState().chats[active.id].messages.at(-1)!.items!
    expect(items.map(item => item.id)).toEqual(['a', 'cmd', 'cmd-output-3', 'b'])
    expect(items[1].output).toBe('中文🙂 complete')
    expect(items[2].text).toBe('中文🙂 complete')
    expect(items[3].text).toBe('After')
  })

  it('hydrates old permissions conservatively and invalidates unfinished authorizations', async () => {
    vi.mocked(api.agentChatOpen).mockResolvedValueOnce({ ...page(), header: { ...chat(), permissionMode: 'workspace-write' },
      messages: [{ id: 'a', role: 'assistant', at: 1, items: [{ id: 'p', type: 'permission', text: '', permissionState: 'pending' }] }] })
    useAgent.setState({ chats: {} })
    await useAgent.getState().loadChat('chat-test')
    const restored = useAgent.getState().chats['chat-test']
    expect(restored.permissionMode).toBe('workspace-write')
    expect(restored.messages[0].items![0].permissionState).toBe('expired')
    expect(restored.messages[0].durationMs).toBeUndefined()
  })
})

it('keeps tool results after an intervening permission card and later text in event order', async () => {
  await useAgent.getState().sendMessage('chat-test', { text: 'run', mentions: [] })
  const active = useAgent.getState().chats['chat-test']
  const events = [
    { kind: 'toolStart', itemId: 'cmd', title: 'pwd' },
    { kind: 'permissionRequest', itemId: 'p', requestId: 'p', operation: 'command', detail: 'pwd', reason: '' },
    { kind: 'toolOutputDelta', itemId: 'cmd', text: 'first' },
    { kind: 'textDelta', itemId: 'comment', text: 'Meanwhile' },
    { kind: 'toolOutputDelta', itemId: 'cmd', text: ' second' },
    { kind: 'toolEnd', itemId: 'cmd', ok: true, output: 'first second' },
  ] as const
  events.forEach((event, i) => useAgent.getState().applyEvent({ chatId: active.id, runId: active.activeRunId!, sequence: i + 1, event }))
  const items = useAgent.getState().chats[active.id].messages.at(-1)!.items!
  expect(items.map(item => item.id)).toEqual(['cmd', 'p', 'cmd-output-3', 'comment', 'cmd-output-5'])
  expect(items.filter(item => item.type === 'tool-output').map(item => item.text).join('')).toBe('first second')
})
