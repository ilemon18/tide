import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { api, type AgentPlanAction } from '../lib/ipc'
vi.mock('../lib/ipc', () => ({ api: { agentChatOpen: vi.fn(), agentChatApply: vi.fn(), agentSend: vi.fn(),
  agentChatPage: vi.fn(), agentChatList: vi.fn(), agentChatClone: vi.fn(), agentCancel: vi.fn(), agentPermissionRespond: vi.fn() }, errorText: (error: unknown) => error instanceof Error ? error.message : String(error) }))
vi.mock('../i18n', () => ({ t: (key: string) => key }))
vi.mock('./settings', () => ({ useSettings: { getState: () => ({ agentEnabled: true, flush: vi.fn() }) } }))
const { setTabName } = vi.hoisted(() => ({ setTabName: vi.fn() }))
vi.mock('./tabs', () => ({ useTabs: { getState: () => ({ setTabName, openChat: vi.fn(), openChatInRight: vi.fn() }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('./workspace', () => ({ activeRoot: () => null }))
import { findPendingPlanAction, useAgent, type AgentChat } from './agent'

const chat = (): AgentChat => ({ v: 1, id: 'chat-test', root: '/tmp/project', title: 'test', provider: 'codex',
  model: '', effort: '', sessionId: 'session-1', messages: [{ id: 'a1', role: 'assistant', at: 1, items: [] }],
  status: 'idle', error: null, createdAt: 1, updatedAt: 1 })
const page = () => ({ header: chat(), messages: chat().messages, hasEarlier: false, hasLater: false,
  total: 1, hasPendingQuestion: false, hasUnhandledPlanAction: false, pendingMessageId: null })
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useAgent.setState({ chats: { 'chat-test': chat() }, pages: {}, pageLoading: {}, queues: {}, running: {}, chatDrafts: {}, focusRequests: {}, localPicker: null,
    providers: [{ id: 'codex', name: 'Codex', installed: true, supported: true, command: 'codex', version: '1', supportsFork: true }] })
  vi.mocked(api.agentChatApply).mockResolvedValue(page())
  vi.mocked(api.agentChatOpen).mockResolvedValue(page())
  vi.mocked(api.agentSend).mockResolvedValue(undefined)
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

describe('chat protocol state', () => {
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
    finishTurn()
    expect(pendingPlan()).toBeNull()
    expect(useAgent.getState().answerQuestion('chat-test', 'question', 'Small')).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
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
    vi.mocked(api.agentChatList).mockResolvedValueOnce([])
    for (const kind of ['resume', 'model', 'permissions'] as const) {
      await useAgent.getState().sendMessage('chat-test', { text: `/${kind}`, mentions: [] })
      expect(useAgent.getState().localPicker?.kind).toBe(kind)
    }
    expect(api.agentChatList).toHaveBeenCalledWith('/tmp/project')
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
    useAgent.setState({ chats: { 'chat-test': { ...chat(), permissionMode: 'full-access' } } })
    await startPlanning()
    const current = useAgent.getState().chats['chat-test']
    useAgent.getState().applyEvent({ chatId: current.id, runId: current.activeRunId!, sequence: 1,
      event: { kind: 'question', itemId: 'q', header: 'Scope', question: 'Which?', multiSelect: false,
        options: [{ label: 'A', description: 'A' }, { label: 'B', description: 'B' }] } })
    finishTurn()
    vi.mocked(api.agentSend).mockRejectedValueOnce(new Error('offline'))
    expect(useAgent.getState().answerQuestion('chat-test', 'q', 'A')).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(useAgent.getState().chats['chat-test'].messages.flatMap(message => message.items ?? []).find(item => item.id === 'q')?.answer).toBeUndefined()
    expect(api.agentSend).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true, permissionMode: 'read-only' }))
    expect(useAgent.getState().chats['chat-test'].permissionMode).toBe('full-access')
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
