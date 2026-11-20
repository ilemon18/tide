import { create } from 'zustand'
import {
  api,
  errorText,
  type AgentCatalog,
  type AgentChatPage,
  type AgentChatApply,
  type AgentEventPayload,
  type AgentMention,
  type AgentProviderInfo,
  type AgentQuestionOption,
  type AgentUsage,
  type TokenEstimate,
} from '../lib/ipc'
import {
  buildAgentPrompt,
  isAgentPromptCommandId,
  parseAgentLocalCommand,
  isAgentSkillRef,
  normalizeAgentDraft,
  type AgentDraft,
  type AgentSkillInfo,
} from '../lib/agentCommand'
import { t } from '../i18n'
import { useSettings } from './settings'
import { useTabs } from './tabs'
import { useUi } from './ui'
import { activeRoot } from './workspace'
import { normalizeAgentUsage } from '../lib/agentUsage'

/**
 * One chat tab = one local CLI conversation.
 *
 * Transcripts live here, not in localStorage: they can be large, they must survive a window
 * close, and the Rust store already owns atomic config writes. Only chats with an open tab
 * are kept in memory; closing a tab drops the record after its last write.
 */

export type AgentItemType =
  | 'text'
  | 'thinking'
  | 'tool'
  | 'question'
  | 'error'
  | 'notice'
  | 'log'

export type AgentItem = {
  id: string
  type: AgentItemType
  text: string
  /** Tool card heading; command, path or MCP tool name */
  title?: string
  /** Tool input / argument summary (JSON text, or a command) */
  detail?: string
  status?: 'running' | 'ok' | 'error'
  /** Tool output (stdout, diff, error) */
  output?: string
  /** Structured question metadata; pending while `answer` is blank or absent */
  header?: string
  question?: string
  multiSelect?: boolean
  options?: AgentQuestionOption[]
  answer?: string
}

export type AgentMessage = {
  id: string
  role: 'user' | 'assistant'
  at: number
  text?: string
  mentions?: AgentMention[]
  /** Tag sent around the text, e.g. plan → <plan>…</plan> */
  command?: AgentDraft['command']
  skills?: AgentDraft['skills']
  items?: AgentItem[]
  /** Provider-reported usage snapshot for this assistant turn */
  usage?: AgentUsage
  /** `/plan` and plan follow-up turns stay read-only until the next ordinary message */
  readOnly?: boolean
}

export type AgentChatStatus = 'idle' | 'running' | 'error' | 'cancelled'

export type AgentChat = {
  /** Transcript format; bump only on an incompatible change */
  v: 1
  id: string
  root: string
  title: string
  provider: string
  model: string
  effort: string
  activeRunId?: string | null
  eventSequence?: number
  sessionUsage?: AgentUsage
  sessionAction?: 'fork' | null
  sessionId: string | null
  messages: AgentMessage[]
  status: AgentChatStatus
  error: string | null
  createdAt: number
  updatedAt: number
}

/** Provider / model / reasoning level the next chat tab starts with. */
export type ChatDefaults = { provider: string; model: string; effort: string }

const emptyDefaults: ChatDefaults = { provider: '', model: '', effort: '' }

/** Typed while a turn was running; sent as the next turn in the same chat */
export type AgentQueuedMessage = { id: string } & AgentDraft

/** Keep the tab title readable; the transcript keeps the full prompt. */
export function titleFromPrompt(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  if (!line) return ''
  const chars = Array.from(line)
  return chars.length > 48 ? `${chars.slice(0, 48).join('')}…` : line
}

let localSeq = 0
export function agentUid(prefix: string): string {
  localSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${localSeq.toString(36)}`
}

export function chatTabId(chatId: string): string {
  return `chat:${chatId}`
}

function newChatId(): string {
  return `chat-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
}

const MAX_LOG = 4_000

function clipTail(value: string, limit: number): string {
  if (value.length <= limit) return value
  return '…' + value.slice(value.length - limit)
}

type Running = Record<string, number>

type AgentStore = {
  providers: AgentProviderInfo[] | null
  providersLoading: boolean
  catalogs: Record<string, AgentCatalog>
  catalogLoading: Record<string, boolean>

  chats: Record<string, AgentChat>
  running: Running
  loadingChats: Record<string, boolean>
  /** Per-chat composer text: switching tabs must not throw a half-written prompt away */
  chatDrafts: Record<string, AgentDraft>
  /** Skill picker source, scanned once per root; missing = not scanned yet */
  skillsByRoot: Record<string, AgentSkillInfo[]>
  skillsLoading: Record<string, boolean>
  /** Messages queued behind the running turn, in send order */
  queues: Record<string, AgentQueuedMessage[]>

  chatDefaults: ChatDefaults

  /** Token estimates per chat */
  tokenEstimates: Record<string, TokenEstimate>

  loadProviders: (force?: boolean) => Promise<void>
  loadCatalog: (provider: string, force?: boolean) => Promise<void>
  resolveDefaults: () => void

  pages: Record<string, AgentChatPage>
  pageLoading: Record<string, boolean>
  loadPage: (id: string, direction: 'earlier' | 'later' | 'latest' | 'pending') => Promise<void>
  loadChat: (id: string) => Promise<void>
  forgetChat: (id: string) => void
  openChatTab: (id: string) => void
  /** Open a chat tab; mentions seed the composer with @file / @folder chips */
  newChat: (root?: string, mentions?: AgentMention[]) => string | null
  loadSkills: (root: string) => Promise<void>
  sendMessage: (chatId: string, draft: AgentDraft) => Promise<void>
  answerQuestion: (chatId: string, itemId: string, answer: string) => boolean
  removeQueued: (chatId: string, id: string) => void
  stop: (chatId: string) => Promise<void>
  applyEvent: (payload: AgentEventPayload) => void
  setChatProvider: (chatId: string, provider: string) => void
  setChatOptions: (chatId: string, patch: { model?: string; effort?: string }) => void
  setChatDraft: (chatId: string, patch: Partial<AgentDraft>) => void
  newChatFrom: (chatId: string) => void
  flushChats: () => void

  updateTokenEstimate: (chatId: string) => Promise<void>
}

/** Chat records waiting for the debounced write */
const dirty = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** One write chain per chat: two atomic renames of the same file must finish in order */
const writeQueues = new Map<string, Promise<void>>()
/** Catalog requests can overlap on a forced rescan: only the newest response may win */
const catalogTickets = new Map<string, number>()
/** Identifies the active provider scan so only its response may finish the loading state */
let providerTicket = 0
/** Retain failed closing-tab writes for explicit flush/reopen retries. */
const unsavedClosedChats = new Map<string, AgentChat>()

function queueChatSave(chatId: string, chat: AgentChat): Promise<void> {
  const { messages, ...header } = chat
  const patch: AgentChatApply = { header, upserts: messages, removeMessageIds: [] }
  const previous = writeQueues.get(chatId) ?? Promise.resolve()
  // A failed earlier write must not poison the chain for every later transcript
  const next = previous.then(
    () => api.agentChatApply(chatId, patch).then(() => {}),
    () => api.agentChatApply(chatId, patch).then(() => {}),
  )
  writeQueues.set(chatId, next)
  const cleanup = () => {
    if (writeQueues.get(chatId) === next) writeQueues.delete(chatId)
  }
  next.then(cleanup, cleanup)
  return next
}

function schedulePersist(chatId: string) {
  dirty.add(chatId)
  const existing = timers.get(chatId)
  if (existing) clearTimeout(existing)
  timers.set(
    chatId,
    setTimeout(() => {
      timers.delete(chatId)
      void persistChat(chatId)
    }, 700),
  )
}

async function persistChat(chatId: string) {
  const chat = useAgent.getState().chats[chatId]
  if (!chat || !dirty.has(chatId)) return
  dirty.delete(chatId)
  try {
    await queueChatSave(chatId, chat)
    if (useAgent.getState().chats[chatId] === chat && chat.status !== 'running') {
      const page = await api.agentChatOpen(chatId, 80)
      if (page && useAgent.getState().chats[chatId] === chat) {
        const state = useAgent.getState()
        const viewingHistory = state.pages[chatId]?.hasLater
        const normalized = !viewingHistory ? normalizeChat({ ...page.header, messages: page.messages }) : null
        useAgent.setState({
          chats: normalized ? { ...state.chats, [chatId]: normalized } : state.chats,
          pages: { ...state.pages, [chatId]: viewingHistory ? { ...state.pages[chatId],
            hasPendingQuestion: page.hasPendingQuestion, hasUnhandledPlanAction: page.hasUnhandledPlanAction,
            pendingMessageId: page.pendingMessageId, total: page.total } : page },
        })
      }
    }
  } catch (error) {
    dirty.add(chatId)
    const current = useAgent.getState().chats[chatId]
    if (current) useAgent.setState({ chats: { ...useAgent.getState().chats,
      [chatId]: { ...current, error: errorText(error) } } })
  }
}

/** Write a chat that is leaving memory; `persistChat` reads the store, which no longer has it. */
function persistLeavingChat(chatId: string, chat: AgentChat) {
  if (!dirty.has(chatId)) return
  dirty.delete(chatId)
  unsavedClosedChats.set(chatId, chat)
  void queueChatSave(chatId, chat).then(() => {
    if (unsavedClosedChats.get(chatId) === chat) unsavedClosedChats.delete(chatId)
  }).catch(error => {
    dirty.add(chatId)
    useUi.getState().toast(errorText(error), 'error')
  })
}

function normalizeChat(raw: unknown): AgentChat | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<AgentChat>
  if (typeof value.id !== 'string' || typeof value.root !== 'string') return null
  if (!Array.isArray(value.messages)) return null
  const messages = value.messages
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) => {
      if (message.role !== 'user') {
        const usage = normalizeAgentUsage(message.usage)
        const readOnly = message.readOnly === true ? true : undefined
        return usage ? { ...message, usage, readOnly } : { ...message, usage: undefined, readOnly }
      }
      const command = isAgentPromptCommandId(message.command) ? message.command : undefined
      const rawSkills = Array.isArray(message.skills) ? message.skills : []
      const skills = rawSkills.filter(isAgentSkillRef)
      return {
        ...message,
        command,
        skills: skills.length > 0 ? skills : undefined,
        readOnly: undefined,
      }
    })
  return {
    v: 1,
    id: value.id,
    root: value.root,
    title: typeof value.title === 'string' ? value.title : '',
    provider: typeof value.provider === 'string' ? value.provider : '',
    model: typeof value.model === 'string' ? value.model : '',
    effort: typeof value.effort === 'string' ? value.effort : '',
    sessionUsage: normalizeAgentUsage(value.sessionUsage),
    sessionAction: value.sessionAction === 'fork' ? 'fork' : null,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : null,
    messages,
    // A process cannot survive a restart: show the old turn as finished, not spinning forever
    status: value.status === 'error' ? 'error' : value.status === 'cancelled' ? 'cancelled' : 'idle',
    error: typeof value.error === 'string' ? value.error : null,
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : Date.now(),
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : Date.now(),
  }
}

export type PendingQuestion = { message: AgentMessage; item: AgentItem }

/** Scan the whole transcript: a notice or later assistant item must not hide an unanswered question. */
export function findPendingQuestion(messages: AgentMessage[]): PendingQuestion | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue
    const items = message.items ?? []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]
      if (item.type === 'question' && !item.answer?.trim()) return { message, item }
    }
  }
  return null
}

export const useAgent = create<AgentStore>((set, get) => {
  const runTurn = async (
    chatId: string,
    draft: AgentDraft,
    appendUser: boolean,
    clearDraft = appendUser,
    readOnlyOverride?: boolean,
  ) => {
    if (get().pages[chatId]?.hasLater) await get().loadPage(chatId, 'latest')
    const chat = get().chats[chatId]
    if (get().pages[chatId]?.hasLater) return
    if (!chat || chat.status === 'running') return
    // The backend re-checks the toggle: make sure its 400ms debounced write has landed first
    useSettings.getState().flush()
    const sentDraft = get().chatDrafts[chatId]
    const now = Date.now()
    const messages = chat.messages.slice()
    if (appendUser) {
      messages.push({
        id: agentUid('u'),
        role: 'user',
        at: now,
        text: draft.text,
        mentions: draft.mentions,
        command: draft.command,
        skills: draft.skills,
      })
    }
    const readOnly = readOnlyOverride ?? draft.command === 'plan'
    const assistantId = agentUid('a')
    const runId = agentUid('run')
    messages.push({
      id: assistantId,
      role: 'assistant',
      at: now,
      items: [],
      readOnly: readOnly || undefined,
    })
    const title =
      chat.title || titleFromPrompt(draft.text || (draft.skills?.[0]?.name ?? ''))
    set({
      chats: {
        ...get().chats,
        [chatId]: {
          ...chat,
          title,
          messages,
          status: 'running',
          activeRunId: runId,
          eventSequence: 0,
          error: null,
          updatedAt: now,
        },
      },
      running: { ...get().running, [chatId]: now },
    })
    if (title) useTabs.getState().setTabName(chatTabId(chatId), title)
    schedulePersist(chatId)

    try {
      await api.agentSend({
        chatId,
        runId,
        root: chat.root,
        provider: chat.provider,
        sessionAction: chat.sessionAction ?? (chat.sessionId ? 'resume' : 'new'),
        sessionId: chat.sessionId,
        model: chat.model || null,
        effort: chat.effort || null,
        prompt: buildAgentPrompt(draft, readOnly),
        mentions: draft.mentions,
        readOnly,
      })
      if (clearDraft && get().chatDrafts[chatId] === sentDraft) {
        set({ chatDrafts: Object.fromEntries(Object.entries(get().chatDrafts).filter(([id]) => id !== chatId)) })
      }
    } catch (e) {
      const current = get().chats[chatId]
      if (!current) return
      const text = errorText(e)
      const nextMessages = current.messages.slice()
      const last = nextMessages[nextMessages.length - 1]
      if (last && last.role === 'assistant' && last.id === assistantId) {
        nextMessages[nextMessages.length - 1] = {
          ...last,
          items: [
            ...(last.items ?? []),
            { id: agentUid('e'), type: 'error' as const, text },
          ],
        }
      }
      const running = { ...get().running }
      delete running[chatId]
      set({
        chats: {
          ...get().chats,
          [chatId]: {
            ...current,
            messages: nextMessages,
            status: 'error',
            error: text,
            updatedAt: Date.now(),
          },
        },
        running,
      })
      schedulePersist(chatId)
    }
  }

  /** Keep a message typed during a turn; it starts the next turn once the current one ends */
  const enqueueMessage = (chatId: string, draft: AgentDraft) => {
    if (!draft.text.trim() && !(draft.skills ?? []).length) return
    const queue = get().queues[chatId] ?? []
    set({
      queues: {
        ...get().queues,
        [chatId]: [...queue, { id: agentUid('q'), ...draft }],
      },
      // The message left the composer; a new draft typed meanwhile stays untouched
      chatDrafts: Object.fromEntries(
        Object.entries(get().chatDrafts).filter(([id]) => id !== chatId),
      ),
    })
  }

  /** Start the oldest queued message after a successful turn. Stop retains the queue. */
  const drainQueue = (chatId: string) => {
    if (!useSettings.getState().agentEnabled) return
    const chat = get().chats[chatId]
    if (!chat || findPendingQuestion(chat.messages) || get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
    const queue = get().queues[chatId] ?? []
    if (queue.length === 0) return
    const [head, ...rest] = queue
    const queues = { ...get().queues }
    if (rest.length > 0) queues[chatId] = rest
    else delete queues[chatId]
    set({ queues })
    void runTurn(
      chatId,
      { text: head.text, mentions: head.mentions, command: head.command, skills: head.skills },
      true,
      false,
    )
  }

  const patchLastAssistant = (
    chat: AgentChat,
    fn: (message: AgentMessage) => AgentItem[],
  ): AgentChat => {
    const messages = chat.messages.slice()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return chat
    messages[messages.length - 1] = { ...last, items: fn(last) }
    return { ...chat, messages, updatedAt: Date.now() }
  }

  const patchLastAssistantUsage = (chat: AgentChat, usage: AgentUsage): AgentChat => {
    const messages = chat.messages.slice()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return chat
    messages[messages.length - 1] = { ...last, usage }
    return { ...chat, messages, updatedAt: Date.now() }
  }

  const upsert = (
    message: AgentMessage,
    itemId: string,
    create: () => AgentItem,
    patch: (item: AgentItem) => AgentItem,
  ): AgentItem[] => {
    const items = (message.items ?? []).slice()
    const index = items.findIndex((item) => item.id === itemId)
    if (index < 0) {
      items.push(patch(create()))
    } else {
      items[index] = patch(items[index])
    }
    return items
  }

  return {
    pages: {},
    pageLoading: {},
    providers: null,
    providersLoading: false,
    catalogs: {},
    catalogLoading: {},

    chats: {},
    running: {},
    loadingChats: {},
    chatDrafts: {},
    queues: {},
    skillsByRoot: {},
    skillsLoading: {},

    chatDefaults: emptyDefaults,

    tokenEstimates: {},

    loadProviders: async (force = false) => {
      // A scan is global work: forced rescans leave the in-flight request untouched rather than race it.
      if (get().providersLoading) return
      providerTicket += 1
      const ticket = providerTicket
      set({ providersLoading: true })
      try {
        const providers = await api.agentProviders(force)
        if (ticket !== providerTicket) return
        set({ providers, providersLoading: false })
        get().resolveDefaults()
      } catch {
        if (ticket !== providerTicket) return
        // Keep the last successful list visible when a refresh fails. Only the initial scan starts empty.
        set({ providers: get().providers ?? [], providersLoading: false })
      }
    },

    loadCatalog: async (provider, force = false) => {
      if (!provider) return
      if (!force && (get().catalogs[provider] || get().catalogLoading[provider])) return
      const ticket = (catalogTickets.get(provider) ?? 0) + 1
      catalogTickets.set(provider, ticket)
      set({ catalogLoading: { ...get().catalogLoading, [provider]: true } })
      try {
        const catalog = await api.agentModels(provider, force)
        if (catalogTickets.get(provider) !== ticket) return
        set({
          catalogs: { ...get().catalogs, [provider]: catalog },
          catalogLoading: { ...get().catalogLoading, [provider]: false },
        })
      } catch {
        if (catalogTickets.get(provider) !== ticket) return
        set({
          catalogs: {
            ...get().catalogs,
            [provider]: {
              provider,
              models: [],
              efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
              defaultModel: '',
            },
          },
          catalogLoading: { ...get().catalogLoading, [provider]: false },
        })
      }
    },

    /**
     * Pick the agent a new chat starts with: the saved default when it is installed and
     * supported, otherwise the first supported provider that is installed.
     */
    resolveDefaults: () => {
      const defaults = get().chatDefaults
      const providers = get().providers ?? []
      const usable = providers.filter((provider) => provider.installed && provider.supported)
      const saved = useSettings.getState().agentDefaultProvider
      const current = providers.find((provider) => provider.id === defaults.provider)
      const provider =
        (usable.some((item) => item.id === saved) ? saved : '') ||
        // The saved default wins; the current provider only survives when the saved one was
        // uninstalled / unsupported meanwhile.
        (current?.installed && current.supported ? current.id : '') ||
        usable[0]?.id ||
        ''
      const settings = useSettings.getState()
      const model = provider === settings.agentDefaultProvider ? settings.agentDefaultModel : ''
      const effort = provider === settings.agentDefaultProvider ? settings.agentDefaultEffort : ''
      if (provider) void get().loadCatalog(provider)
      if (provider !== defaults.provider || model !== defaults.model || effort !== defaults.effort) {
        set({ chatDefaults: { provider, model, effort } })
      }
    },

    loadChat: async (id) => {
      const unsaved = unsavedClosedChats.get(id)
      if (unsaved) {
        unsavedClosedChats.delete(id)
        set({ chats: { ...get().chats, [id]: unsaved } })
        schedulePersist(id)
        return
      }
      if (get().chats[id] || get().loadingChats[id]) return
      set({ loadingChats: { ...get().loadingChats, [id]: true } })
      try {
        const page = await api.agentChatOpen(id, 80)
        const chat = page ? normalizeChat({ ...page.header, messages: page.messages }) : null
        if (chat) {
          set({
            pages: { ...get().pages, ...(page ? { [id]: page } : {}) },
            chats: { ...get().chats, [id]: chat },
            loadingChats: { ...get().loadingChats, [id]: false },
          })
          useTabs.getState().setTabName(chatTabId(id), chat.title)
          return
        }
      } catch (error) {
        useUi.getState().toast(errorText(error), 'error')
      }
      set({ loadingChats: { ...get().loadingChats, [id]: false } })
    },

    loadPage: async (id, direction) => {
      const chat = get().chats[id]
      if (!chat || chat.status === 'running' || get().pageLoading[id]) return
      set({ pageLoading: { ...get().pageLoading, [id]: true } })
      try {
        await persistChat(id)
        await writeQueues.get(id)
        if (dirty.has(id)) return
        let page: AgentChatPage | null
        if (direction === 'latest') page = await api.agentChatOpen(id, 80)
        else if (direction === 'pending') {
          const pending = get().pages[id]?.pendingMessageId
          if (!pending) return
          const before = await api.agentChatPage(id, { beforeId: pending, limit: 1 })
          const predecessor = before?.messages[0]?.id
          if (typeof predecessor === 'string') {
            page = await api.agentChatPage(id, { afterId: predecessor, limit: 80 })
          } else {
            const after = await api.agentChatPage(id, { afterId: pending, limit: 1 })
            const successor = after?.messages[0]?.id
            page = typeof successor === 'string'
              ? await api.agentChatPage(id, { beforeId: successor, limit: 1 })
              : await api.agentChatOpen(id, 80)
          }
        } else {
          const cursor = direction === 'earlier' ? chat.messages[0]?.id : chat.messages.at(-1)?.id
          if (!cursor) return
          page = await api.agentChatPage(id, {
            ...(direction === 'earlier' ? { beforeId: cursor } : { afterId: cursor }), limit: 80,
          })
        }
        if (!page || !get().chats[id]) return
        const normalized = normalizeChat({ ...page.header, messages: page.messages })
        if (!normalized) return
        set({ chats: { ...get().chats, [id]: normalized }, pages: { ...get().pages, [id]: page } })
      } catch (error) {
        const current = get().chats[id]
        if (current) set({ chats: { ...get().chats, [id]: { ...current, error: errorText(error) } } })
      } finally {
        set({ pageLoading: { ...get().pageLoading, [id]: false } })
      }
    },

    forgetChat: (id) => {
      const leaving = get().chats[id]
      const chats = { ...get().chats }
      delete chats[id]
      const running = { ...get().running }
      delete running[id]
      const chatDrafts = { ...get().chatDrafts }
      delete chatDrafts[id]
      const queues = { ...get().queues }
      delete queues[id]
      const timer = timers.get(id)
      if (timer) clearTimeout(timer)
      timers.delete(id)
      // Capture the last transcript before the record leaves memory
      if (leaving) persistLeavingChat(id, leaving)
      const tokenEstimates = { ...get().tokenEstimates }
      delete tokenEstimates[id]
      const pages = { ...get().pages }
      delete pages[id]
      const pageLoading = { ...get().pageLoading }
      delete pageLoading[id]
      set({ chats, running, chatDrafts, queues, tokenEstimates, pages, pageLoading })
    },

    openChatTab: (id) => {
      const chat = get().chats[id]
      if (!chat) return
      useTabs.getState().openChat(id, chat.root, chat.title || '')
    },

    newChat: (root, mentions) => {
      if (!useSettings.getState().agentEnabled) return null
      const targetRoot = root || activeRoot()?.id || ''
      if (!targetRoot) return null
      // The tab opens immediately; if the scan is still running, AgentChat fills the first
      // supported provider as soon as the list arrives.
      if (get().providers === null) void get().loadProviders()
      get().resolveDefaults()
      const defaults = get().chatDefaults
      const now = Date.now()
      const chatId = newChatId()
      const seeded = (mentions ?? []).filter((mention) => mention.rel)
      const unique = seeded.filter(
        (mention, index) => seeded.findIndex((item) => item.rel === mention.rel) === index,
      )
      const chat: AgentChat = {
        v: 1,
        id: chatId,
        root: targetRoot,
        title: '',
        provider: defaults.provider,
        model: defaults.model,
        effort: defaults.effort,
        sessionId: null,
        messages: [],
        status: 'idle',
        error: null,
        createdAt: now,
        updatedAt: now,
      }
      set({
        chats: { ...get().chats, [chatId]: chat },
        ...(unique.length > 0
          ? { chatDrafts: { ...get().chatDrafts, [chatId]: { text: '', mentions: unique } } }
          : {}),
      })
      useTabs.getState().openChatInRight(chatId, targetRoot, '')
      if (defaults.provider) void get().loadCatalog(defaults.provider)
      return chatId
    },

    sendMessage: async (chatId, draft) => {
      const chat = get().chats[chatId]
      if (!chat) return
      if (!useSettings.getState().agentEnabled) return
      const local = parseAgentLocalCommand(draft.text)
      if (local) {
        if (chat.status === 'running') return
        try {
          if (local.id === 'new') { get().newChat(chat.root); return }
          if (local.id === 'model' && local.args) {
            get().setChatOptions(chatId, { model: local.args }); return
          }
          if (local.id === 'resume' && local.args) {
            const matches = await api.agentChatList(chat.root)
            if (!matches.some(item => item.id === local.args)) throw new Error(t('agent.missingChat'))
            await get().loadChat(local.args)
            get().openChatTab(local.args)
            return
          }
          if (local.id === 'fork' && chat.provider === 'claude' && chat.sessionId) {
            await persistChat(chatId)
            await writeQueues.get(chatId)
            if (dirty.has(chatId)) return
            const id = newChatId()
            const page = await api.agentChatClone(chatId, { id, sessionAction: 'fork', createdAt: Date.now() })
            const cloned = normalizeChat({ ...page.header, messages: page.messages })
            if (cloned) {
              set({ chats: { ...get().chats, [id]: cloned }, pages: { ...get().pages, [id]: page } })
              get().openChatTab(id)
            }
            return
          }
          const text = local.id === 'status'
            ? [chat.provider, chat.model, chat.status, chat.sessionId].filter(Boolean).join(' · ')
            : local.id === 'help' ? t('agent.local.helpText')
            : t('agent.local.unavailable')
          set({ chats: { ...get().chats, [chatId]: { ...chat,
            messages: [...chat.messages, { id: agentUid('n'), role: 'assistant', at: Date.now(),
              items: [{ id: agentUid('n'), type: 'notice', text }] }],
          } } })
          schedulePersist(chatId)
        } catch (error) {
          set({ chats: { ...get().chats, [chatId]: { ...chat, error: errorText(error) } } })
        }
        return
      }
      if (get().pages[chatId]?.hasLater) await get().loadPage(chatId, 'latest')
      if (get().pages[chatId]?.hasLater || get().pageLoading[chatId]) return
      const next = normalizeAgentDraft(draft)
      if (!next.text.trim() && !(next.skills ?? []).length) return
      // A structured question owns the next turn. The answer must go through answerQuestion so
      // it carries the source question and the planning read-only boundary.
      if (findPendingQuestion(get().chats[chatId].messages) || get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
      const queue = get().queues[chatId] ?? []
      // Running turn, or a queue left over from a stopped / disabled turn: keep FIFO order
      if (chat.status === 'running' || queue.length > 0) {
        enqueueMessage(chatId, next)
        if (chat.status !== 'running') drainQueue(chatId)
        return
      }
      await runTurn(chatId, next, true)
    },

    answerQuestion: (chatId, itemId, answer) => {
      const chat = get().chats[chatId]
      if (!chat || chat.status === 'running') return false
      const pending = findPendingQuestion(chat.messages)
      if (!pending || pending.item.id !== itemId) return false
      const trimmed = answer.trim()
      if (!trimmed) return false
      const readOnly = pending.message.readOnly === true
      const messages = chat.messages.map((message) => {
        if (message.id !== pending.message.id) return message
        return {
          ...message,
          items: (message.items ?? []).map((item) =>
            item.id === itemId ? { ...item, answer: trimmed } : item,
          ),
        }
      })
      set({
        chats: {
          ...get().chats,
          [chatId]: { ...chat, messages, updatedAt: Date.now() },
        },
      })
      const page = get().pages[chatId]
      if (page) set({ pages: { ...get().pages, [chatId]: { ...page,
        hasPendingQuestion: !!findPendingQuestion(messages) } } })
      schedulePersist(chatId)
      const question = pending.item.question ?? ''
      const prompt = t('agent.question.answerPrompt', { question, answer: trimmed })
      void runTurn(chatId, { text: prompt, mentions: [] }, true, false, readOnly)
      return true
    },

    removeQueued: (chatId, id) => {
      const queue = (get().queues[chatId] ?? []).filter((item) => item.id !== id)
      const queues = { ...get().queues }
      if (queue.length > 0) queues[chatId] = queue
      else delete queues[chatId]
      set({ queues })
    },

    stop: async (chatId) => {
      try {
        await api.agentCancel(chatId)
      } catch {
        // The turn may have finished between the click and the IPC; nothing to do
      }
    },

    applyEvent: ({ chatId, runId, sequence, event }) => {
      const current = get().chats[chatId]
      if (!current || current.status !== 'running' || current.activeRunId !== runId || sequence <= (current.eventSequence ?? 0)) return
      const chat = { ...current, eventSequence: sequence }
      set({ chats: { ...get().chats, [chatId]: chat } })

      if (event.kind === 'session') {
        if (chat.sessionId === event.sessionId) return
        set({
          chats: {
            ...get().chats,
            [chatId]: { ...chat, sessionId: event.sessionId, sessionAction: null, updatedAt: Date.now() },
          },
        })
        schedulePersist(chatId)
        return
      }

      if (event.kind === 'usage') {
        const usage = normalizeAgentUsage(event.usage)
        if (!usage) return
        const next = patchLastAssistantUsage(chat, usage)
        next.sessionUsage = normalizeAgentUsage(event.sessionUsage) ?? chat.sessionUsage
        if (next === chat) return
        set({ chats: { ...get().chats, [chatId]: next } })
        schedulePersist(chatId)
        return
      }

      if (event.kind === 'done') {
        const running = { ...get().running }
        delete running[chatId]
        const status: AgentChatStatus = event.cancelled
          ? 'cancelled'
          : event.ok
            ? 'idle'
            : 'error'
        const failure =
          event.ok || event.cancelled
            ? null
            : event.code != null
              ? t('agent.exitCode', { code: event.code })
              : t('agent.turnFailed')
        let next = patchLastAssistant(chat, (message) => {
          const items = (message.items ?? []).slice()
          if (!event.ok && !event.cancelled) {
            const hasError = items.some((item) => item.type === 'error')
            if (!hasError) {
              // The CLI's last stderr line is usually the real reason (auth, unknown flag)
              const logLine = [...items]
                .reverse()
                .find((item) => item.type === 'log')
                ?.text.split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .slice(-1)[0]
              items.push({
                id: agentUid('e'),
                type: 'error',
                text: [failure ?? t('agent.turnFailed'), logLine]
                  .filter(Boolean)
                  .join('\n'),
              })
            }
          }
          return items
        })
        next = { ...next, status, error: failure, updatedAt: Date.now() }
        set({ chats: { ...get().chats, [chatId]: next }, running })
        schedulePersist(chatId)

        if (event.ok) drainQueue(chatId)
        return
      }

      const next = patchLastAssistant(chat, (message) => {
        switch (event.kind) {
          case 'textDelta':
            return upsert(
              message,
              event.itemId,
              () => ({ id: event.itemId, type: 'text', text: '' }),
              (item) => ({ ...item, text: item.text + event.text }),
            )
          case 'thinking':
            return upsert(
              message,
              event.itemId,
              () => ({ id: event.itemId, type: 'thinking', text: '' }),
              (item) => ({ ...item, text: item.text + event.text }),
            )
          case 'toolStart':
            return upsert(
              message,
              event.itemId,
              () => ({
                id: event.itemId,
                type: 'tool',
                text: '',
                title: event.title,
                status: 'running',
              }),
              (item) => ({ ...item, title: event.title, status: item.status ?? 'running' }),
            )
          case 'toolDetail':
            return upsert(
              message,
              event.itemId,
              () => ({
                id: event.itemId,
                type: 'tool',
                text: '',
                detail: event.detail,
                status: 'running',
              }),
              (item) => ({ ...item, detail: event.detail }),
            )
          case 'toolEnd':
            return upsert(
              message,
              event.itemId,
              () => ({
                id: event.itemId,
                type: 'tool',
                text: '',
                status: event.ok ? 'ok' : 'error',
                output: event.output ?? undefined,
              }),
              (item) => ({
                ...item,
                status: event.ok ? 'ok' : 'error',
                output: event.output ?? item.output,
              }),
            )
          case 'question':
            return upsert(
              message,
              event.itemId,
              () => ({
                id: event.itemId,
                type: 'question',
                text: '',
                header: event.header,
                question: event.question,
                multiSelect: event.multiSelect,
                options: event.options,
              }),
              (item) => ({
                ...item,
                header: event.header,
                question: event.question,
                multiSelect: event.multiSelect,
                options: event.options,
              }),
            )
          case 'questionInvalid':
            return [
              ...(message.items ?? []),
              { id: agentUid('n'), type: 'notice', text: t('agent.question.invalid') },
            ]
          case 'notice':
            return [
              ...(message.items ?? []),
              { id: agentUid('n'), type: 'notice', text: event.text },
            ]
          case 'stderr': {
            const items = (message.items ?? []).slice()
            const index = items.findIndex((item) => item.type === 'log')
            const text = clipTail(
              `${index >= 0 ? items[index].text : ''}${index >= 0 ? '\n' : ''}${event.text}`,
              MAX_LOG,
            )
            if (index >= 0) items[index] = { ...items[index], text }
            else items.push({ id: 'log', type: 'log', text })
            return items
          }
          default:
            return message.items ?? []
        }
      })
      set({ chats: { ...get().chats, [chatId]: next } })
      schedulePersist(chatId)
    },

    setChatProvider: (chatId, provider) => {
      const chat = get().chats[chatId]
      if (!chat || !provider || chat.provider === provider || chat.status === 'running') return
      const settings = useSettings.getState()
      const model = provider === settings.agentDefaultProvider ? settings.agentDefaultModel : ''
      const effort = provider === settings.agentDefaultProvider ? settings.agentDefaultEffort : ''
      const name = get().providers?.find((item) => item.id === provider)?.name ?? provider
      const now = Date.now()
      const messages =
        chat.messages.length > 0
          ? [
              ...chat.messages,
              {
                id: agentUid('n'),
                role: 'assistant' as const,
                at: now,
                items: [
                  {
                    id: agentUid('n'),
                    type: 'notice' as const,
                    text: t('agent.switched', { name }),
                  },
                ],
              },
            ]
          : chat.messages
      set({
        chats: {
          ...get().chats,
          [chatId]: {
            ...chat,
            provider,
            model,
            effort,
            // A CLI session belongs to one provider: never resume it with another binary
            sessionId: null,
            messages,
            status: chat.status === 'error' || chat.status === 'cancelled' ? 'idle' : chat.status,
            error: null,
            updatedAt: now,
          },
        },
      })
      schedulePersist(chatId)
      void get().loadCatalog(provider)
      if (provider !== settings.agentDefaultProvider) {
        useSettings.getState().patch({
          agentDefaultProvider: provider,
          agentDefaultModel: model,
          agentDefaultEffort: effort,
        })
      }
    },

    setChatOptions: (chatId, patch) => {
      const chat = get().chats[chatId]
      if (!chat || chat.status === 'running') return
      const catalog = get().catalogs[chat.provider]
      let effort = patch.effort ?? chat.effort
      if (patch.model !== undefined) {
        const model = catalog?.models.find((item) => item.id === patch.model)
        const allowed =
          model && model.efforts.length > 0 ? model.efforts : (catalog?.efforts ?? [])
        if (effort && allowed.length > 0 && !allowed.includes(effort)) {
          effort = model?.defaultEffort ?? ''
        }
      }
      set({
        chats: {
          ...get().chats,
          [chatId]: {
            ...chat,
            model: patch.model ?? chat.model,
            effort,
            updatedAt: Date.now(),
          },
        },
      })
      schedulePersist(chatId)
    },

    loadSkills: async (root) => {
      if (!root) return
      if (get().skillsByRoot[root] || get().skillsLoading[root]) return
      set({ skillsLoading: { ...get().skillsLoading, [root]: true } })
      try {
        const skills = await api.agentSkills(root)
        set({
          skillsByRoot: { ...get().skillsByRoot, [root]: skills },
          skillsLoading: { ...get().skillsLoading, [root]: false },
        })
      } catch {
        // Leave it unscanned so the next `$` retries
        set({ skillsLoading: { ...get().skillsLoading, [root]: false } })
      }
    },

    setChatDraft: (chatId, patch) => {
      const current: AgentDraft = get().chatDrafts[chatId] ?? { text: '', mentions: [] }
      set({
        chatDrafts: { ...get().chatDrafts, [chatId]: { ...current, ...patch } },
      })
    },

    newChatFrom: (chatId) => {
      const chat = get().chats[chatId]
      if (!chat) return
      get().newChat(chat.root)
    },

    flushChats: () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const chatId of [...dirty]) {
        const closed = unsavedClosedChats.get(chatId)
        if (closed) persistLeavingChat(chatId, closed)
        else void persistChat(chatId)
      }
    },

    updateTokenEstimate: async (chatId) => {
      const chat = get().chats[chatId]
      const draft = get().chatDrafts[chatId]
      if (!chat) return

      const mentions = draft?.mentions || []
      const text = buildAgentPrompt(normalizeAgentDraft(draft ?? { text: '', mentions: [] }))

      try {
        const estimate = await api.agentEstimateTokens(chat.root, mentions, text)
        if (!get().chats[chatId] || get().chatDrafts[chatId] !== draft) return
        set({
          tokenEstimates: { ...get().tokenEstimates, [chatId]: estimate }
        })
      } catch {
        if (!get().chats[chatId] || get().chatDrafts[chatId] !== draft) return
        const tokenEstimates = { ...get().tokenEstimates }
        delete tokenEstimates[chatId]
        set({ tokenEstimates })
      }
    },
  }
})
