import { create } from 'zustand'
import {
  api,
  errorText,
  type AgentCatalog,
  type AgentChatPage,
  type AgentChatApply,
  type AgentEventPayload,
  type AgentMention,
  type AgentContextAttachment,
  type AgentPlanAction,
  type AgentPermissionMode,
  type AgentChatSummary,
  type AgentProviderInfo,
  type AgentQuestionOption,
  type AgentTurnChangeFile,
  type AgentTurnChanges,
  type AgentUsage,
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
import { attachmentBytes, isContextAttachment, snapshotAgentDraft, validateAttachments, type ContextIntent } from '../lib/agentContext'
import { budget } from '../lib/memoryBudget'
import { useSettings } from './settings'
import { useTabs } from './tabs'
import { useUi } from './ui'
import { activeRoot, useWorkspace } from './workspace'
import { normalizeAgentUsage, replaceTurnUsage } from '../lib/agentUsage'
import { agentBridge } from '../lib/agentBridge'

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
  | 'tool-output'
  | 'question'
  | 'error'
  | 'notice'
  | 'log'
  | 'plan'
  | 'permission'

export type AgentItem = {
  id: string
  type: AgentItemType
  text: string
  /** Tool card heading; command, path or MCP tool name */
  title?: string
  complete?: boolean
  requestId?: string
  toolId?: string
  runId?: string
  permissionState?: 'pending' | 'submitting' | 'allowed' | 'denied' | 'expired'
  /** Tool input / argument summary (JSON text, or a command) */
  detail?: string
  status?: 'running' | 'ok' | 'error'
  /** Tool output (stdout, diff, error) */
  output?: string
  /** Structured question metadata; streamed questions stay non-pending while `complete` is false. */
  header?: string
  question?: string
  multiSelect?: boolean
  options?: AgentQuestionOption[]
  answer?: string
  /** Plan action metadata: pending while `resolved` is false */
  resolved?: boolean
  action?: AgentPlanAction
  actionState?: 'launching' | 'completed' | 'failed'
  targetChatId?: string
  actionRunId?: string
  actions?: Array<{ id: string; label: string; description: string }>
}

export type AgentMessage = {
  id: string
  role: 'user' | 'assistant'
  at: number
  /** Provider that produced this reply; absent in older v:1 transcripts. */
  provider?: string
  text?: string
  mentions?: AgentMention[]
  attachments?: AgentContextAttachment[]
  /** Tag sent around the text, e.g. plan → <plan>…</plan> */
  command?: AgentDraft['command']
  skills?: AgentDraft['skills']
  items?: AgentItem[]
  /** Provider-reported usage snapshot for this assistant turn */
  usage?: AgentUsage
  /** Persistent planning and question-answer turns retain the read-only boundary. */
  readOnly?: boolean
  planning?: boolean
  compact?: boolean
  planActionId?: string
  launchAccepted?: boolean
  completion?: 'completed' | 'failed' | 'stopped'
  completedAt?: number
  durationMs?: number
  /** Net file changes of this turn; only the chat's latest reply may offer the undo */
  changes?: AgentTurnChanges
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
  sessionCost?: { knownUsd: number; unpricedTurns: number }
  currentContext?: AgentUsage
  permissionMode?: AgentPermissionMode
  planning?: boolean
  compactSummary?: string
  compactPending?: boolean
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
  let start = value.length - limit
  const code = value.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start += 1
  return '…' + value.slice(start)
}

/** Place result segments where output actually arrives, including after permission/question cards. */
export function applyToolOutput(items: AgentItem[], toolId: string, text: string, sequence: number, snapshot = false): AgentItem[] {
  const next = items.slice()
  const segments = next.filter(item => item.type === 'tool-output' && item.toolId === toolId)
  const received = segments.map(item => item.text).join('')
  let suffix = text
  if (snapshot) {
    if (!text.startsWith(received)) {
      // A provider may correct bytes in its final snapshot. Keep existing chronological slots.
      const points = Array.from(text)
      let offset = 0
      for (let i = 0; i < segments.length; i++) {
        const segment = segments[i]
        const end = i === segments.length - 1 ? points.length : offset + Array.from(segment.text).length
        const index = next.findIndex(item => item.id === segment.id)
        next[index] = { ...segment, text: points.slice(offset, end).join('') }
        offset = end
      }
      if (segments.length) return next
    } else suffix = text.slice(received.length)
  }
  if (!suffix) return next
  const tail = next.at(-1)
  if (tail?.type === 'tool-output' && tail.toolId === toolId) {
    next[next.length - 1] = { ...tail, text: tail.text + suffix }
  } else next.push({ id: `${toolId}-output-${sequence}`, type: 'tool-output', toolId, text: suffix })
  return next
}

type Running = Record<string, number>
export const AGENT_HISTORY_PAGE_SIZE = 15
const historySummaryOrder = (a: AgentChatSummary, b: AgentChatSummary) =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
export type AgentHistory = {
  chats: AgentChatSummary[]
  page: number
  query: string
  total: number
  loading: boolean
  loaded: boolean
  error: boolean
}

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
  chatFocusOrder: Record<string, number>
  markChatFocused: (chatId: string) => void
  addContext: (root: string, attachments: AgentContextAttachment[], intent?: ContextIntent) => boolean
  /** Skill picker source, scanned once per root; missing = not scanned yet */
  skillsByRoot: Record<string, AgentSkillInfo[]>
  skillsLoading: Record<string, boolean>
  /** Messages queued behind the running turn, in send order */
  queues: Record<string, AgentQueuedMessage[]>
  /** Selected queued message while stopping the old turn and launching its replacement. */
  interjecting: Record<string, string>

  chatDefaults: ChatDefaults
  historyByRoot: Record<string, AgentHistory>
  loadHistory: (root: string, options?: { page?: number; query?: string; silent?: boolean }) => Promise<void>
  clearHistory: () => void
  resumeChat: (id: string, root: string) => Promise<boolean>
  resumingChatId: string | null
  isBlankChat: (id: string, root: string) => boolean
  deletingChats: Record<string, boolean>
  deleteChat: (id: string, root: string) => Promise<boolean>

  loadProviders: (force?: boolean) => Promise<void>
  loadCatalog: (provider: string, force?: boolean) => Promise<void>
  resolveDefaults: () => void

  localPicker: { chatId: string; kind: 'model' | 'permissions' } | null
  focusRequests: Record<string, number>
  restartSession: (chatId: string) => void
  pages: Record<string, AgentChatPage>
  pageLoading: Record<string, boolean>
  loadPage: (id: string, direction: 'earlier' | 'later' | 'latest' | 'pending') => Promise<void>
  loadChat: (id: string, expectedRoot?: string) => Promise<void>
  forgetChat: (id: string) => void
  openChatTab: (id: string) => void
  /** Open a chat tab; mentions seed the composer with @file / @folder chips */
  newChat: (root?: string, mentions?: AgentMention[]) => string | null
  loadSkills: (root: string) => Promise<void>
  sendMessage: (chatId: string, draft: AgentDraft) => Promise<void>
  answerQuestion: (chatId: string, itemId: string, answer: string) => Promise<boolean>
  resolvePlanAction: (chatId: string, itemId: string, action: AgentPlanAction, instructions?: string) => Promise<boolean>
  removeQueued: (chatId: string, id: string) => void
  editQueued: (chatId: string, id: string) => boolean
  interjectQueued: (chatId: string, id: string) => Promise<boolean>
  stop: (chatId: string) => Promise<void>
  applyEvent: (payload: AgentEventPayload) => void
  /** Mark the turn's change card as undone so its undo action disappears */
  markTurnChangesReverted: (chatId: string, messageId: string) => void
  /** The baseline snapshot was pruned: keep the summary, drop the undo action */
  markTurnChangesStale: (chatId: string, messageId: string) => void
  setChatProvider: (chatId: string, provider: string, options?: { remember?: boolean }) => void
  setPermissionMode: (chatId: string, mode: AgentPermissionMode) => void
  respondPermission: (chatId: string, requestId: string, allow: boolean) => Promise<void>
  setChatOptions: (chatId: string, patch: { model?: string; effort?: string }) => void
  setChatDraft: (chatId: string, patch: Partial<AgentDraft>) => void
  resetChat: (chatId: string) => Promise<boolean>
  newChatFrom: (chatId: string) => void
  flushChats: () => void
}

/** Chat records waiting for the debounced write */
const dirty = new Set<string>()
const planActionLocks = new Set<string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
/** One write chain per chat: two atomic renames of the same file must finish in order */
const writeQueues = new Map<string, Promise<void>>()
/** Prevent a new turn from racing an in-place /new reset for the same chat. */
const resetLocks = new Map<string, Promise<boolean>>()
/** Catalog requests can overlap on a forced rescan: only the newest response may win */
const catalogTickets = new Map<string, number>()
/** A forced refresh requested while a load is in flight runs once after it settles. */
const catalogForceQueued = new Set<string>()
/** Identifies the active provider scan so only its response may finish the loading state */
let providerTicket = 0
let historyTicket = 0
/** Retain failed closing-tab writes for explicit flush/reopen retries. */
const unsavedClosedChats = new Map<string, AgentChat>()
/** Invalidate reads and save callbacks when a chat is deleted or leaves memory. */
const chatEpochs = new Map<string, { deleted: boolean }>()
function chatEpoch(id: string) {
  let epoch = chatEpochs.get(id)
  if (!epoch) { epoch = { deleted: false }; chatEpochs.set(id, epoch) }
  return epoch
}

function queueChatSave(chatId: string, chat: AgentChat): Promise<void> {
  if (useAgent.getState().deletingChats[chatId]) return Promise.resolve()
  const { messages, ...header } = chat
  // Undefined is omitted by JSON IPC; use null to clear known fields in Rust's merge store.
  const persistedHeader = { ...header, currentContext: header.currentContext ?? null,
    sessionUsage: header.sessionUsage ?? null, sessionCost: header.sessionCost ?? null, compactSummary: header.compactSummary ?? null }
  const patch: AgentChatApply = { header: persistedHeader, upserts: messages, removeMessageIds: [] }
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

const evictions = new Map<string, Promise<void>>()
function messageBytes(messages: AgentMessage[]) {
  return new TextEncoder().encode(JSON.stringify(messages)).byteLength
}

/** Only evict a prefix after its complete records have reached the atomic Rust merge store. */
function boundWorkingSet(chatId: string) {
  const chat = useAgent.getState().chats[chatId]
  if (!chat || evictions.has(chatId) || useAgent.getState().deletingChats[chatId]) return
  const epoch = chatEpoch(chatId)
  const sizes = chat.messages.map(message => messageBytes([message]))
  let count = 0
  let bytes = 0
  for (let index = sizes.length - 1; index >= 0; index--) {
    if (count && (count >= 160 || bytes + sizes[index] > 1024 * 1024)) break
    count++
    bytes += sizes[index]
  }
  const removed = chat.messages.slice(0, chat.messages.length - count)
  if (!removed.length) return
  const ids = new Set(removed.map(message => message.id))
  const work = queueChatSave(chatId, chat).then(() => {
    if (chatEpochs.get(chatId) !== epoch) return
    const state = useAgent.getState()
    const current = state.chats[chatId]
    if (!current || state.pages[chatId]?.hasLater) return
    // Do not evict any message edited after the snapshot was captured.
    const unchanged = removed.every(message => current.messages.find(item => item.id === message.id) === message)
    if (!unchanged) return
    const messages = current.messages.filter(message => !ids.has(message.id))
    const page = state.pages[chatId]
    const question = findPendingQuestion(current.messages)
    const plan = findPendingPlanAction(current.messages)
    useAgent.setState({ chats: { ...state.chats, [chatId]: { ...current, messages } },
      pages: { ...state.pages, [chatId]: { header: page?.header ?? {}, messages,
        hasEarlier: true, hasLater: false, total: page?.total ?? current.messages.length,
        hasPendingQuestion: !!question || !!page?.hasPendingQuestion,
        hasUnhandledPlanAction: !!plan || !!page?.hasUnhandledPlanAction,
        pendingMessageId: question?.message.id ?? plan?.message.id ?? page?.pendingMessageId ?? null } } })
  }).catch(error => {
    useUi.getState().toast(errorText(error), 'error')
  }).finally(() => { evictions.delete(chatId) })
  evictions.set(chatId, work)
}

function schedulePersist(chatId: string) {
  if (!useAgent.getState().chats[chatId] || useAgent.getState().deletingChats[chatId]) return
  dirty.add(chatId)
  boundWorkingSet(chatId)
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
  if (!chat || !dirty.has(chatId) || useAgent.getState().deletingChats[chatId]) return
  const epoch = chatEpoch(chatId)
  dirty.delete(chatId)
  try {
    await queueChatSave(chatId, chat)
    if (chatEpochs.get(chatId) !== epoch) return
    if (useAgent.getState().chats[chatId] === chat && chat.status !== 'running') {
      const page = await api.agentChatOpen(chatId, 80)
      if (page && chatEpochs.get(chatId) === epoch && useAgent.getState().chats[chatId] === chat) {
        const state = useAgent.getState()
        const visible = state.pages[chatId]
        useAgent.setState({
          pages: { ...state.pages, [chatId]: { ...page, messages: chat.messages,
            hasEarlier: visible?.hasEarlier ?? page.hasEarlier, hasLater: visible?.hasLater ?? false } },
        })
      }
    }
  } catch (error) {
    if (epoch.deleted || useAgent.getState().deletingChats[chatId]) return
    dirty.add(chatId)
    const current = useAgent.getState().chats[chatId]
    if (current) useAgent.setState({ chats: { ...useAgent.getState().chats,
      [chatId]: { ...current, error: errorText(error) } } })
  }
}

/** Write a chat that is leaving memory; `persistChat` reads the store, which no longer has it. */
function persistLeavingChat(chatId: string, chat: AgentChat) {
  if (!dirty.has(chatId) || useAgent.getState().deletingChats[chatId]) return
  const epoch = chatEpoch(chatId)
  dirty.delete(chatId)
  unsavedClosedChats.set(chatId, chat)
  void queueChatSave(chatId, chat).then(() => {
    if (unsavedClosedChats.get(chatId) === chat) unsavedClosedChats.delete(chatId)
    if (chatEpochs.get(chatId) === epoch && !useAgent.getState().chats[chatId]) chatEpochs.delete(chatId)
  }).catch(error => {
    if (epoch.deleted || useAgent.getState().deletingChats[chatId]) return
    dirty.add(chatId)
    useUi.getState().toast(errorText(error), 'error')
  })
}

const TURN_CHANGE_STATUSES = new Set(['A', 'M', 'D', 'R', 'T'])

/**
 * Stored summaries come back from disk; drop malformed rows instead of letting a hand-edited
 * transcript crash the reply UI. Unknown fields are ignored, never trusted.
 */
function normalizeTurnChanges(raw: unknown): AgentTurnChanges | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const value = raw as Partial<AgentTurnChanges>
  const snapshot = value.snapshot
  const worktree = snapshot && typeof snapshot === 'object' ? snapshot.worktree : undefined
  if (typeof worktree !== 'string' || !worktree || !Array.isArray(value.files)) return undefined
  const count = (input: unknown) => typeof input === 'number' && Number.isFinite(input) && input > 0 ? input : 0
  const files = value.files.flatMap((file): AgentTurnChangeFile[] => {
    if (!file || typeof file.path !== 'string' || !file.path) return []
    if (typeof file.status !== 'string' || !TURN_CHANGE_STATUSES.has(file.status)) return []
    return [{
      path: file.path,
      ...(typeof file.oldPath === 'string' && file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status as AgentTurnChangeFile['status'],
      additions: count(file.additions),
      deletions: count(file.deletions),
      binary: file.binary === true,
    }]
  })
  const index = typeof snapshot?.index === 'string' && snapshot.index ? snapshot.index : undefined
  return {
    snapshot: index ? { worktree, index } : { worktree },
    ...(typeof value.head === 'string' && value.head ? { head: value.head } : {}),
    ...(value.headChanged === true ? { headChanged: true } : {}),
    files,
    additions: count(value.additions) || files.reduce((sum, file) => sum + file.additions, 0),
    deletions: count(value.deletions) || files.reduce((sum, file) => sum + file.deletions, 0),
    truncated: value.truncated === true,
    ...(typeof value.revertedAt === 'number' && Number.isFinite(value.revertedAt) ? { revertedAt: value.revertedAt } : {}),
    ...(value.stale === true ? { stale: true } : {}),
  }
}

function normalizeChat(raw: unknown, recover = false): AgentChat | null {
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
        const provider = typeof message.provider === 'string' && message.provider.trim() ? message.provider : undefined
        const changes = normalizeTurnChanges(message.changes)
        message = { ...message, provider, changes, items: message.items?.map(item => recover && item.type === 'plan' && item.actionState === 'launching'
          ? { ...item, resolved: false, actionState: 'failed' as const } : recover && item.type === 'permission' && ['pending', 'submitting'].includes(item.permissionState ?? '') ? { ...item, permissionState: 'expired' as const } : item) }
        return usage ? { ...message, usage, readOnly } : { ...message, usage: undefined, readOnly }
      }
      const command = isAgentPromptCommandId(message.command) ? message.command : undefined
      const rawSkills = Array.isArray(message.skills) ? message.skills : []
      const skills = rawSkills.filter(isAgentSkillRef)
      return {
        ...message,
        command,
        skills: skills.length > 0 ? skills : undefined,
        attachments: Array.isArray(message.attachments) ? message.attachments.filter(isContextAttachment) : undefined,
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
    sessionCost: value.sessionCost && Number.isFinite(value.sessionCost.knownUsd) && value.sessionCost.knownUsd >= 0 &&
      Number.isInteger(value.sessionCost.unpricedTurns) && value.sessionCost.unpricedTurns >= 0 ? value.sessionCost : undefined,
    currentContext: normalizeAgentUsage(value.currentContext),
    permissionMode: value.permissionMode === 'read-only' || (value.permissionMode === undefined && messages.at(-1)?.readOnly) ? 'read-only' : value.permissionMode === 'full-access' ? 'full-access' : 'workspace-write',
    planning: value.planning === true || (value.planning === undefined && messages.at(-1)?.readOnly === true),
    compactSummary: typeof value.compactSummary === 'string' ? value.compactSummary : undefined,
    compactPending: false,
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
      // A question item is streamed before the provider's final turn event. Keep it out of
      // the pending gate until that turn completes; legacy records without `complete` remain
      // actionable for backwards compatibility.
      if (item.type === 'question' && item.complete !== false && !item.answer?.trim()) return { message, item }
    }
  }
  return null
}

export type PendingPlanAction = { message: AgentMessage; item: AgentItem }

/** Find unresolved plan action in the transcript. */
export function findPendingPlanAction(messages: AgentMessage[]): PendingPlanAction | null {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex]
    if (message.role !== 'assistant') continue
    const items = message.items ?? []
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex]
      if (item.type === 'plan' && (!item.resolved || item.actionState === 'launching')) return { message, item }
    }
  }
  return null
}

export const useAgent = create<AgentStore>((set, get) => {
  // Cancellation must wait until agentSend has actually registered the old run in Rust.
  const launches = new Map<string, Promise<void>>()
  const runTurn = async (
    chatId: string,
    draft: AgentDraft,
    appendUser: boolean,
    composerDraft?: AgentDraft,
    readOnlyOverride?: boolean,
    compact = false,
    actionItemId?: string,
  ) => {
    if (get().pages[chatId]?.hasLater) await get().loadPage(chatId, 'latest')
    const chat = get().chats[chatId]
    if (get().pages[chatId]?.hasLater) return false
    if (!chat || chat.status === 'running' || resetLocks.has(chatId) || get().deletingChats[chatId] || !useSettings.getState().agentEnabled) return false
    // The backend re-checks the toggle: make sure its 400ms debounced write has landed first
    useSettings.getState().flush()
    draft = snapshotAgentDraft(draft)
    const contextError = validateAttachments(chat.root, draft.attachments ?? [])
    if (contextError) { useUi.getState().toast(t(contextError), 'error'); return false }
    // Retain an empty draft identity so edits (including a later queued send) invalidate recovery.
    const clearedDraft: AgentDraft | undefined = composerDraft && get().chatDrafts[chatId] === composerDraft
      ? { text: '', mentions: [] } : undefined
    const recoverDraft = composerDraft && clearedDraft ? snapshotAgentDraft(composerDraft) : undefined
    const now = Date.now()
    const messages = chat.messages.slice()
    if (appendUser) {
      messages.push({
        id: agentUid('u'),
        role: 'user',
        at: now,
        text: draft.text,
        mentions: draft.mentions,
        attachments: draft.attachments,
        command: draft.command,
        skills: draft.skills,
      })
    }
    const planning = !compact && (draft.command === 'plan' || (readOnlyOverride !== false && chat.planning === true))
    const readOnly = planning || readOnlyOverride === true || (readOnlyOverride !== false && chat.permissionMode === 'read-only')
    const assistantId = agentUid('a')
    const runId = agentUid('run')
    let finishLaunch!: () => void
    launches.set(runId, new Promise<void>(resolve => { finishLaunch = resolve }))
    messages.push({
      id: assistantId,
      role: 'assistant',
      at: now,
      provider: chat.provider,
      items: [],
      readOnly: readOnly || undefined,
      planning,
      compact,
      ...(actionItemId ? { planActionId: actionItemId } : {}),
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
          planning: compact ? chat.planning : planning,
          permissionMode: readOnlyOverride === false && chat.permissionMode === 'read-only' ? 'workspace-write' : chat.permissionMode,
          compactPending: compact,
          activeRunId: runId,
          eventSequence: 0,
          error: null,
          updatedAt: now,
        },
      },
      running: { ...get().running, [chatId]: now },
      ...(clearedDraft ? { chatDrafts: { ...get().chatDrafts, [chatId]: clearedDraft } } : {}),
    })
    if (title) useTabs.getState().setTabName(chatTabId(chatId), title)
    schedulePersist(chatId)

    try {
      await queueChatSave(chatId, get().chats[chatId])
      await api.agentSend({
        chatId,
        runId,
        root: chat.root,
        provider: chat.provider,
        sessionAction: chat.sessionAction ?? (chat.sessionId ? 'resume' : 'new'),
        sessionId: chat.sessionId,
        model: chat.model || null,
        effort: chat.effort || null,
        prompt: [!chat.sessionId && chat.compactSummary ? `Previous conversation summary:\n${chat.compactSummary}` : '',
          compact ? draft.text : buildAgentPrompt(planning ? { ...draft, command: 'plan' } : draft, readOnly)].filter(Boolean).join('\n\n'),
        mentions: draft.mentions,
        attachments: draft.attachments,
        readOnly,
        permissionMode: readOnly ? 'read-only' : chat.permissionMode === 'full-access' ? 'full-access' : 'workspace-write',
      })
      if (actionItemId) {
        const current = get().chats[chatId]
        if (current) {
          const accepted = { ...current, messages: current.messages.map(message => message.id === assistantId ? { ...message, launchAccepted: true } : message) }
          set({ chats: { ...get().chats, [chatId]: accepted } })
          await queueChatSave(chatId, accepted)
        }
      }
      return true
    } catch (e) {
      const current = get().chats[chatId]
      if (!current || current.activeRunId !== runId || get().deletingChats[chatId]) return false
      const text = errorText(e)
      const nextMessages = current.messages.slice()
      const last = nextMessages[nextMessages.length - 1]
      if (last && last.role === 'assistant' && last.id === assistantId) {
        nextMessages[nextMessages.length - 1] = {
          ...last,
          completion: 'failed',
          completedAt: Date.now(),
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
            compactPending: false,
            error: text,
            updatedAt: Date.now(),
          },
        },
        running,
        ...(recoverDraft && get().chatDrafts[chatId] === clearedDraft && !resetLocks.has(chatId)
          ? { chatDrafts: { ...get().chatDrafts, [chatId]: recoverDraft } } : {}),
      })
      schedulePersist(chatId)
      return false
    } finally {
      launches.delete(runId)
      finishLaunch()
    }
  }

  /** Keep a message typed during a turn; it starts the next turn once the current one ends */
  const enqueueMessage = (chatId: string, draft: AgentDraft, composerDraft?: AgentDraft) => {
    if (!draft.text.trim() && !(draft.skills ?? []).length) return
    const queue = get().queues[chatId] ?? []
    set({
      queues: {
        ...get().queues,
        [chatId]: [...queue, { id: agentUid('q'), ...snapshotAgentDraft(draft) }],
      },
      // The message left the composer; a new draft typed meanwhile stays untouched
      ...(composerDraft && get().chatDrafts[chatId] === composerDraft ? {
        chatDrafts: Object.fromEntries(Object.entries(get().chatDrafts).filter(([id]) => id !== chatId)),
      } : {}),
    })
  }

  /** Start the oldest queued message after a successful turn. Stop retains the queue. */
  const drainQueue = (chatId: string) => {
    if (!useSettings.getState().agentEnabled || get().interjecting[chatId] || get().deletingChats[chatId]) return
    const chat = get().chats[chatId]
    if (!chat || findPendingQuestion(chat.messages) || findPendingPlanAction(chat.messages) || get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
    const queue = get().queues[chatId] ?? []
    if (queue.length === 0) return
    const [head, ...rest] = queue
    const queues = { ...get().queues }
    if (rest.length > 0) queues[chatId] = rest
    else delete queues[chatId]
    set({ queues })
    void runTurn(
      chatId,
      snapshotAgentDraft(head),
      true,
    ).then(accepted => {
      if (accepted || !get().chats[chatId]) return
      const remaining = get().queues[chatId] ?? []
      if (!remaining.some(item => item.id === head.id)) {
        set({ queues: { ...get().queues, [chatId]: [head, ...remaining] } })
      }
    })
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

  /** Same contract as `patchLastAssistant`, for fields that live on the message itself */
  const patchLastAssistantMessage = (
    chat: AgentChat,
    fn: (message: AgentMessage) => AgentMessage,
  ): AgentChat => {
    const messages = chat.messages.slice()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return chat
    messages[messages.length - 1] = fn(last)
    return { ...chat, messages, updatedAt: Date.now() }
  }

  const patchLastAssistantUsage = (chat: AgentChat, usage: AgentUsage): AgentChat => {
    const messages = chat.messages.slice()
    const last = messages[messages.length - 1]
    if (!last || last.role !== 'assistant') return chat
    messages[messages.length - 1] = { ...last, usage }
    return { ...chat, messages, updatedAt: Date.now() }
  }

  /** Patch the change summary of one message; no-op when it has none */
  const patchMessageChanges = (
    chatId: string,
    messageId: string,
    patch: Partial<AgentTurnChanges>,
  ): void => {
    const chat = get().chats[chatId]
    if (!chat) return
    let touched = false
    const messages = chat.messages.map(message => {
      if (message.id !== messageId || !message.changes) return message
      touched = true
      return { ...message, changes: { ...message.changes, ...patch } }
    })
    if (!touched) return
    set({ chats: { ...get().chats, [chatId]: { ...chat, messages, updatedAt: Date.now() } } })
    schedulePersist(chatId)
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
    localPicker: null,
    focusRequests: {},
    restartSession: (chatId) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running') return
      set({ chats: { ...get().chats, [chatId]: { ...chat, sessionId: null, sessionAction: null,
        sessionUsage: undefined, sessionCost: undefined, currentContext: undefined, compactSummary: undefined, error: null, status: 'idle' } } })
      schedulePersist(chatId)
    },
    pages: {},
    pageLoading: {},
    historyByRoot: {},
    clearHistory: () => {
      historyTicket++
      set({ historyByRoot: {} })
    },
    loadHistory: async (root, options = {}) => {
      if (!useSettings.getState().agentHistoryEnabled || !root) return
      const current = get().historyByRoot[root]
      const query = (options.query ?? current?.query ?? '').trim()
      const requestedPage = options.page ?? current?.page ?? 1
      const pageNumber = Number.isFinite(requestedPage) ? Math.max(1, Math.floor(requestedPage)) : 1
      const silent = options.silent === true
      const keepCurrent = silent && current?.query === query
      const ticket = ++historyTicket
      const isCurrent = () => ticket === historyTicket && useSettings.getState().agentHistoryEnabled
      // Keep only one page for the project currently being browsed. New requests supersede in-flight reads.
      set({ historyByRoot: { [root]: {
        chats: keepCurrent ? current!.chats : [], page: pageNumber, query,
        total: keepCurrent ? current!.total : 0,
        loaded: keepCurrent ? current!.loaded : false, loading: !silent, error: false,
      } } })
      try {
        const ids = Object.values(get().chats).filter(chat => chat.root === root && !get().deletingChats[chat.id]).map(chat => chat.id)
        // Closing a tab releases its in-memory record before its accepted write finishes.
        // Include these writes (and retry failed closing saves) before reading summaries.
        const closedWrites = [...unsavedClosedChats].filter(([id, chat]) => chat.root === root && !get().deletingChats[id])
          .map(([id, chat]) => {
            persistLeavingChat(id, chat)
            return writeQueues.get(id)
          })
        await Promise.all([...ids.map(id => persistChat(id)), ...closedWrites])
        await Promise.all(ids.map(id => writeQueues.get(id)))
        if (!isCurrent()) return
        let targetPage = pageNumber
        let result = await api.agentChatList(root, (targetPage - 1) * AGENT_HISTORY_PAGE_SIZE, AGENT_HISTORY_PAGE_SIZE, query)
        if (!isCurrent()) return
        // Deletion (including another window) may have removed the last page while it was being read.
        const lastPage = Math.max(1, Math.ceil(result.total / AGENT_HISTORY_PAGE_SIZE))
        if (targetPage > lastPage) {
          targetPage = lastPage
          result = await api.agentChatList(root, (targetPage - 1) * AGENT_HISTORY_PAGE_SIZE, AGENT_HISTORY_PAGE_SIZE, query)
          if (!isCurrent()) return
        }
        const rootChats = result.chats.filter(chat => chat.root === root)
        const chats = rootChats.filter(chat => !get().deletingChats[chat.id])
        const hiddenDeleting = rootChats.length - chats.length
        set({ historyByRoot: { [root]: {
          chats, page: targetPage, query, total: Math.max(0, result.total - hiddenDeleting),
          loading: false, loaded: true, error: false,
        } } })
      } catch (error) {
        if (!isCurrent()) return
        const latest = get().historyByRoot[root]
        if (latest) set({ historyByRoot: { [root]: { ...latest, loading: false, error: !(silent && latest.chats.length > 0) } } })
        useUi.getState().toast(errorText(error), 'error')
      }
    },
    resumingChatId: null,
    isBlankChat: (id, root) => {
      const state = get()
      const chat = state.chats[id]
      const page = state.pages[id]
      const draft = state.chatDrafts[id]
      return !!chat && chat.root === root && chat.status === 'idle' && !chat.title && !chat.error &&
        !chat.messages.length && !chat.sessionId && !chat.sessionAction && !chat.compactSummary && !chat.compactPending &&
        !chat.activeRunId && !chat.currentContext && !chat.sessionUsage && !chat.sessionCost &&
        !(page?.total || page?.hasEarlier || page?.hasLater || page?.hasPendingQuestion || page?.hasUnhandledPlanAction || page?.pendingMessageId) &&
        !draft?.text && !draft?.command && !draft?.attachments?.length && !draft?.mentions?.length && !draft?.skills?.length &&
        !state.queues[id]?.length && state.running[id] === undefined && !state.loadingChats[id] && !state.pageLoading[id] &&
        !state.deletingChats[id] && !state.interjecting[id] && !resetLocks.has(id) && !evictions.has(id) &&
        ![...planActionLocks].some(key => key.startsWith(`${id}:`)) && state.localPicker?.chatId !== id
    },
    resumeChat: async (id, root) => {
      if (get().resumingChatId || get().deletingChats[id]) return false
      const workspace = useWorkspace.getState()
      const owner = workspace.roots.find(node => node.id === root)
      if (!owner) return false
      const originHistoryOpen = useUi.getState().historyOpen
      const originHistoryEpoch = useUi.getState().historyEpoch
      const alreadyLoaded = !!get().chats[id]
      set({ resumingChatId: id })
      try {
        await get().loadChat(id, root)
        // An already-open tab may be hydrating the same chat. loadChat deduplicates that read;
        // wait for it to settle before validating and activating the target.
        if (get().loadingChats[id]) {
          await new Promise<void>(resolve => {
            const unsubscribe = useAgent.subscribe(state => {
              if (state.loadingChats[id]) return
              unsubscribe()
              resolve()
            })
          })
        }
        const chat = get().chats[id]
        const currentRoot = useWorkspace.getState().roots.find(node => node.id === root)
        if (!chat || chat.root !== root || get().deletingChats[id] || currentRoot?.lifetime !== owner.lifetime ||
          (originHistoryOpen && (!useUi.getState().historyOpen || useUi.getState().historyEpoch !== originHistoryEpoch || activeRoot()?.id !== root))) return false
        const tabs = useTabs.getState()
        if (tabs.tabs.some(tab => tab.id === chatTabId(id))) {
          tabs.openChat(id, root, chat.title)
        } else {
          const blank = tabs.tabs.filter(tab => tab.kind === 'chat' && get().isBlankChat(tab.id.slice(5), root))
            .sort((a, b) => Number(b.id === tabs.activeId) - Number(a.id === tabs.activeId) ||
              (get().chatFocusOrder[b.id.slice(5)] ?? 0) - (get().chatFocusOrder[a.id.slice(5)] ?? 0))[0]
          if (blank && tabs.replaceChatTab(blank.id.slice(5), id, root, chat.title)) get().forgetChat(blank.id.slice(5))
          else tabs.openChatInRight(id, root, chat.title)
        }
        useUi.getState().closeHistory()
        get().markChatFocused(id)
        set({ focusRequests: { ...get().focusRequests, [id]: (get().focusRequests[id] ?? 0) + 1 } })
        return true
      } finally {
        if (!alreadyLoaded && !useTabs.getState().tabs.some(tab => tab.id === chatTabId(id))) get().forgetChat(id)
        set({ resumingChatId: null })
      }
    },
    deletingChats: {},
    deleteChat: async (id, root) => {
      if (get().deletingChats[id]) return false
      const chat = get().chats[id] ?? unsavedClosedChats.get(id)
      if (chat && chat.root !== root) return false
      if (chat?.status === 'running' || get().running[id] !== undefined || get().interjecting[id] || resetLocks.has(id) ||
        [...planActionLocks].some(key => key.startsWith(`${id}:`))) {
        useUi.getState().toast(t('agent.history.deleteRunning'), 'error')
        return false
      }

      // Optimistic removal: the drawer row disappears before disk writes and the IPC delete settle.
      const history = get().historyByRoot[root]
      const historyWasLoading = Boolean(history?.loading)
      const removedIndex = history?.chats.findIndex(item => item.id === id) ?? -1
      const removed = removedIndex >= 0 ? history!.chats[removedIndex] : undefined
      const originQuery = history?.query
      const originPage = history?.page
      if (history) historyTicket++
      set({
        deletingChats: { ...get().deletingChats, [id]: true },
        loadingChats: { ...get().loadingChats, [id]: false },
        pageLoading: { ...get().pageLoading, [id]: false },
        ...(history ? { historyByRoot: { [root]: {
          ...history,
          chats: removed ? history.chats.filter(item => item.id !== id) : history.chats,
          total: removed ? Math.max(0, history.total - 1) : history.total,
          loading: false,
          error: false,
        } } } : {}),
      })
      const epoch = chatEpochs.get(id)
      if (epoch) epoch.deleted = true
      chatEpochs.delete(id)
      const timer = timers.get(id)
      if (timer) clearTimeout(timer)
      timers.delete(id)
      let deleted = false
      try {
        // Previously accepted writes must settle before removal; new saves are blocked above.
        await Promise.allSettled([writeQueues.get(id), evictions.get(id)])
        await api.agentChatDelete(id, root)
        deleted = true
        dirty.delete(id)
        unsavedClosedChats.delete(id)
        get().forgetChat(id)
        await useTabs.getState().close(chatTabId(id), true)
        agentBridge.onChatDeleted()
        const latest = get().historyByRoot[root]
        if (latest && latest.chats.length === 0 && latest.page > 1) {
          void get().loadHistory(root, { page: latest.page - 1, query: latest.query, silent: true })
        } else if (historyWasLoading && latest) {
          void get().loadHistory(root, { page: latest.page, query: latest.query, silent: true })
        }
        return true
      } catch (error) {
        // Restore only the row this call removed; concurrent optimistic deletions stay removed.
        if (!deleted && removed && originQuery !== undefined && originPage !== undefined) {
          const current = get().historyByRoot[root]
          if (current && current.query === originQuery && current.page === originPage &&
            !current.chats.some(item => item.id === removed.id)) {
            const chats = [...current.chats, removed].sort(historySummaryOrder)
            set({ historyByRoot: { [root]: { ...current, chats, total: current.total + 1, loading: false, error: false } } })
          }
        } else if (!deleted && historyWasLoading) {
          const current = get().historyByRoot[root]
          if (current) void get().loadHistory(root, { page: current.page, query: current.query, silent: true })
        }
        useUi.getState().toast(errorText(error), 'error')
        return false
      } finally {
        const deletingChats = { ...get().deletingChats }
        delete deletingChats[id]
        set({ deletingChats })
        // Keep the original record retryable after any failed removal, including failed prior saves.
        if (!deleted && get().chats[id]) schedulePersist(id)
      }
    },
    providers: null,
    providersLoading: false,
    catalogs: {},
    catalogLoading: {},

    chats: {},
    running: {},
    loadingChats: {},
    chatFocusOrder: {},
    markChatFocused: (chatId) => {
      if (get().chats[chatId]) set({ chatFocusOrder: { ...get().chatFocusOrder, [chatId]: ++localSeq } })
    },
    addContext: (root, attachments, intent = 'add') => {
      if (!useSettings.getState().agentEnabled) return false
      const fail = (key: 'agent.context.invalid' | 'agent.context.limit' | 'agent.context.memory' | 'error.workspace.notOpen') => {
        useUi.getState().toast(t(key), 'error'); return false
      }
      if (!root) return fail('error.workspace.notOpen')
      const initialError = validateAttachments(root, attachments)
      if (initialError) return fail(initialError)
      if (!attachments.length) return false
      const tabs = useTabs.getState()
      const open = (tabs.tabs ?? []).filter(tab => tab.kind === 'chat' && tab.root === root &&
        get().chats[tab.id.slice(5)] && !get().deletingChats[tab.id.slice(5)])
      const visible = new Set((tabs.groups ?? []).map(group => group.activeId))
      const ranked = [...open].sort((a, b) => Number(visible.has(b.id)) - Number(visible.has(a.id)) ||
        (get().chatFocusOrder[b.id.slice(5)] ?? 0) - (get().chatFocusOrder[a.id.slice(5)] ?? 0))
      const existingId = ranked[0]?.id.slice(5)
      const previous = existingId ? get().chatDrafts[existingId] : undefined
      const combined = [...(previous?.attachments ?? []), ...attachments]
      const error = validateAttachments(root, combined)
      if (error) return fail(error)
      const unsentBytes = Object.values(get().chatDrafts).reduce((sum, draft) => sum + attachmentBytes(draft.attachments), 0) +
        Object.values(get().queues).flat().reduce((sum, draft) => sum + attachmentBytes(draft.attachments), 0)
      if (unsentBytes + attachmentBytes(attachments) > budget.agentUnsentAttachmentBytes()) return fail('agent.context.memory')
      const id = existingId ?? get().newChat(root)
      if (!id) return false
      const draft = get().chatDrafts[id] ?? { text: '', mentions: [] }
      const instruction = intent === 'explain' ? t('agent.context.explainPrompt') : intent === 'refactor' ? t('agent.context.refactorPrompt') : ''
      get().setChatDraft(id, { attachments: combined.map(item => ({ ...item })),
        text: instruction ? [draft.text, instruction].filter(Boolean).join('\n\n') : draft.text })
      get().openChatTab(id)
      get().markChatFocused(id)
      set({ focusRequests: { ...get().focusRequests, [id]: (get().focusRequests[id] ?? 0) + 1 } })
      return true
    },
    chatDrafts: {},
    queues: {},
    interjecting: {},
    skillsByRoot: {},
    skillsLoading: {},

    chatDefaults: emptyDefaults,

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
      // A new chat asks for a forced check. Coalesce concurrent requests, but remember that a
      // refresh is still owed: one more run happens after the current request settles.
      if (get().catalogLoading[provider]) {
        if (force) catalogForceQueued.add(provider)
        return
      }
      if (!force && get().catalogs[provider]) return
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
        // A forced refresh exists to notice removed models. Only repair session defaults when the
        // catalog is trustworthy (non-empty); a failed CLI probe must not wipe the user's choice.
        const defaults = get().chatDefaults
        if (
          defaults.provider === provider &&
          defaults.model &&
          catalog.models.length > 0 &&
          !catalog.models.some((model) => model.id === defaults.model)
        ) {
          const stale = defaults.model
          const fallback =
            catalog.models.find((model) => model.id === catalog.defaultModel) ??
            catalog.models[0]
          const effort = fallback.efforts.includes(defaults.effort)
            ? defaults.effort
            : fallback.defaultEffort || fallback.efforts[0] || ''
          set({
            chatDefaults: { ...defaults, model: fallback.id, effort },
            // Blank chats have not sent anything yet: switch them to the surviving model too.
            chats: Object.fromEntries(
              Object.entries(get().chats).map(([id, chat]): [string, AgentChat] =>
                chat.provider === provider &&
                chat.status === 'idle' &&
                chat.messages.length === 0 &&
                chat.model === stale
                  ? [id, { ...chat, model: fallback.id, effort, updatedAt: Date.now() }]
                  : [id, chat],
              ),
            ),
          })
        }
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
      } finally {
        if (catalogForceQueued.delete(provider)) {
          void get().loadCatalog(provider, true)
        }
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

    loadChat: async (id, expectedRoot) => {
      if (get().deletingChats[id]) return
      const unsaved = unsavedClosedChats.get(id)
      if (unsaved) {
        if (expectedRoot && unsaved.root !== expectedRoot) return
        unsavedClosedChats.delete(id)
        set({ chats: { ...get().chats, [id]: unsaved } })
        schedulePersist(id)
        return
      }
      if (get().chats[id] || get().loadingChats[id]) return
      const epoch = chatEpoch(id)
      set({ loadingChats: { ...get().loadingChats, [id]: true } })
      try {
        const page = expectedRoot ? await api.agentChatOpen(id, 80, expectedRoot) : await api.agentChatOpen(id, 80)
        if (chatEpochs.get(id) !== epoch) return
        const chat = page ? normalizeChat({ ...page.header, messages: page.messages }, true) : null
        if (chat && chat.id === id && (!expectedRoot || chat.root === expectedRoot)) {
          set({
            pages: { ...get().pages, ...(page ? { [id]: page } : {}) },
            chats: { ...get().chats, [id]: chat },
            loadingChats: { ...get().loadingChats, [id]: false },
          })
          useTabs.getState().setTabName(chatTabId(id), chat.title)
          return
        }
      } catch (error) {
        if (chatEpochs.get(id) !== epoch) return
        useUi.getState().toast(errorText(error), 'error')
      }
      set({ loadingChats: { ...get().loadingChats, [id]: false } })
    },

    loadPage: async (id, direction) => {
      const chat = get().chats[id]
      if (!chat || chat.status === 'running' || get().pageLoading[id] || get().deletingChats[id]) return
      const epoch = chatEpoch(id)
      set({ pageLoading: { ...get().pageLoading, [id]: true } })
      try {
        await persistChat(id)
        await writeQueues.get(id)
        if (dirty.has(id) || chatEpochs.get(id) !== epoch) return
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
            ...(direction === 'earlier' ? { beforeId: cursor } : { afterId: cursor }), limit: 40,
          })
        }
        if (!page || !get().chats[id] || chatEpochs.get(id) !== epoch) return
        const normalized = normalizeChat({ ...page.header, messages: page.messages }, true)
        if (!normalized) return
        if (direction === 'earlier' || direction === 'later') {
          const current = get().chats[id]
          const oldPage = get().pages[id]
          const combined = direction === 'earlier' ? [...normalized.messages, ...current.messages] : [...current.messages, ...normalized.messages]
          const unique = combined.filter((message, index) => combined.findIndex(item => item.id === message.id) === index)
          let trimmed = false
          while (unique.length > 1 && (unique.length > 160 || messageBytes(unique) > 1024 * 1024)) {
            if (direction === 'earlier') unique.pop()
            else unique.shift()
            trimmed = true
          }
          normalized.messages = unique
          page = { ...page, messages: unique,
            hasEarlier: direction === 'earlier' ? page.hasEarlier : trimmed || !!oldPage?.hasEarlier,
            hasLater: direction === 'later' ? page.hasLater : trimmed || !!oldPage?.hasLater }
        }
        set({ chats: { ...get().chats, [id]: normalized }, pages: { ...get().pages, [id]: page } })
      } catch (error) {
        if (chatEpochs.get(id) !== epoch) return
        const current = get().chats[id]
        if (current) set({ chats: { ...get().chats, [id]: { ...current, error: errorText(error) } } })
      } finally {
        if (chatEpochs.get(id) === epoch) set({ pageLoading: { ...get().pageLoading, [id]: false } })
      }
    },

    forgetChat: (id) => {
      chatEpochs.delete(id)
      const leaving = get().chats[id]
      const chats = { ...get().chats }
      delete chats[id]
      const running = { ...get().running }
      delete running[id]
      const chatDrafts = { ...get().chatDrafts }
      delete chatDrafts[id]
      const chatFocusOrder = { ...get().chatFocusOrder }
      delete chatFocusOrder[id]
      const queues = { ...get().queues }
      delete queues[id]
      const interjecting = { ...get().interjecting }
      delete interjecting[id]
      const timer = timers.get(id)
      if (timer) clearTimeout(timer)
      timers.delete(id)
      // Capture the last transcript before the record leaves memory
      if (leaving) persistLeavingChat(id, leaving)
      const pages = { ...get().pages }
      delete pages[id]
      const pageLoading = { ...get().pageLoading }
      delete pageLoading[id]
      const loadingChats = { ...get().loadingChats }
      delete loadingChats[id]
      const focusRequests = { ...get().focusRequests }
      delete focusRequests[id]
      set({ chats, running, chatDrafts, chatFocusOrder, queues, interjecting, pages, pageLoading, loadingChats, focusRequests,
        ...(get().localPicker?.chatId === id ? { localPicker: null } : {}) })
    },

    openChatTab: (id) => {
      const chat = get().chats[id]
      if (!chat || get().deletingChats[id]) return
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
        permissionMode: useSettings.getState().agentDefaultPermissionMode,
        planning: false,
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
      schedulePersist(chatId)
      useTabs.getState().openChatInRight(chatId, targetRoot, '')
      // Every new chat checks the installed CLI for model changes; the catalog request is
      // backgrounded so the tab still opens immediately.
      if (defaults.provider) void get().loadCatalog(defaults.provider, true)
      return chatId
    },

    sendMessage: async (chatId, draft) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId]) return
      if (!useSettings.getState().agentEnabled) return
      if (resetLocks.has(chatId)) return
      if (get().interjecting[chatId]) return
      if ([...planActionLocks].some(key => key.startsWith(`${chatId}:`))) return
      const composerDraft = get().chatDrafts[chatId]
      draft = snapshotAgentDraft(draft)
      const local = parseAgentLocalCommand(draft.text)
      const normalized = normalizeAgentDraft(draft)
      if (normalized.command === 'plan' && !normalized.text && !local) {
        if (chat.status === 'running' || findPendingQuestion(chat.messages) || findPendingPlanAction(chat.messages) || get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
        const planning = !chat.planning
        set({ chats: { ...get().chats, [chatId]: { ...chat, planning, permissionMode: planning ? 'read-only' : 'workspace-write' } } })
        get().setChatDraft(chatId, { text: '', command: undefined })
        schedulePersist(chatId)
        return
      }
      if (local) {
        try {
          if (chat.status === 'running' && !['new', 'resume', 'status', 'help'].includes(local.id)) throw new Error(t('agent.local.busy'))
          const noArgs = ['new', 'fork', 'compact', 'status', 'help']
          if (local.args && noArgs.includes(local.id)) throw new Error(t('agent.local.invalidArgs'))
          const blocked = !!findPendingQuestion(chat.messages) || !!findPendingPlanAction(chat.messages) ||
            get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction
          if (['compact', 'fork', 'permissions'].includes(local.id) && (blocked || (get().queues[chatId]?.length ?? 0) > 0)) throw new Error(t('agent.local.busy'))
          if (local.id === 'new') { await get().resetChat(chatId); return }
          get().setChatDraft(chatId, { text: '', command: undefined })
          if (local.id === 'model') {
            if (local.args) {
              if (/\s/.test(local.args)) throw new Error(t('agent.local.invalidArgs'))
              get().setChatOptions(chatId, { model: local.args === 'default' ? '' : local.args })
            } else set({ localPicker: { chatId, kind: 'model' } })
            return
          }
          if (local.id === 'permissions') {
            if (!local.args) { set({ localPicker: { chatId, kind: 'permissions' } }); return }
            if (!['read-only', 'workspace-write', 'full-access'].includes(local.args)) throw new Error(t('agent.local.invalidArgs'))
            get().setPermissionMode(chatId, local.args as AgentPermissionMode)
            return
          }
          if (local.id === 'resume') {
            if (!local.args) {
              if (!useSettings.getState().agentHistoryEnabled) throw new Error(t('agent.local.unavailable'))
              useWorkspace.getState().setActiveRoot(chat.root)
              useUi.getState().openHistory()
              return
            }
            if (!await get().resumeChat(local.args, chat.root)) throw new Error(t('agent.missingChat'))
            return
          }
          if (local.id === 'compact') {
            if (!chat.sessionId) throw new Error(t('agent.local.unavailable'))
            await runTurn(chatId, { text: 'Summarize this conversation for a fresh context. Preserve the task, approved decisions, constraints, relevant paths, completed work, and remaining steps. Return only the summary. Do not modify files, run side-effecting commands, ask questions, or implement the task.', mentions: [] }, false, undefined, true, true)
            return
          }
          if (local.id === 'fork') {
            if (!['claude', 'codex'].includes(chat.provider) || !chat.sessionId || !get().providers?.find(p => p.id === chat.provider)?.supportsFork) throw new Error(t('agent.local.forkUnsupported'))
            await queueChatSave(chatId, chat)
            const id = newChatId()
            const page = await api.agentChatClone(chatId, { id, sessionAction: 'fork', currentContext: null, sessionUsage: null, sessionCost: null, createdAt: Date.now() })
            const cloned = normalizeChat({ ...page.header, messages: page.messages })
            if (cloned) {
              set({ chats: { ...get().chats, [id]: cloned }, pages: { ...get().pages, [id]: page } })
              get().openChatTab(id)
            }
            return
          }
          const text = local.id === 'status'
            ? t('agent.local.statusText', { provider: chat.provider, model: chat.model || t('agent.picker.defaultModel'),
              effort: chat.effort || t('agent.picker.defaultModel'), mode: chat.permissionMode ?? 'workspace-write',
              planning: String(!!chat.planning), status: chat.status, session: chat.sessionId ?? '—',
              queued: get().queues[chatId]?.length ?? 0, pending: String(!!blocked),
              context: chat.currentContext?.contextTokens ?? '—', window: chat.currentContext?.contextWindow ?? '—',
              total: chat.sessionUsage?.totalTokens ?? '—', root: chat.root })
            : t('agent.local.helpText')
          if (chat.status === 'running') {
            useUi.getState().toast(text)
            return
          }
          const current = get().chats[chatId]
          set({ chats: { ...get().chats, [chatId]: { ...current,
            messages: [...current.messages, { id: agentUid('n'), role: 'assistant', at: Date.now(),
              items: [{ id: agentUid('n'), type: 'notice', text }] }],
          } } })
          schedulePersist(chatId)
        } catch (error) {
          const current = get().chats[chatId]
          set({ chats: { ...get().chats, [chatId]: { ...current, error: errorText(error) } } })
        }
        return
      }
      if (/^\/[a-z][a-z-]*(?:\s|$)/.test(draft.text.trim()) && !normalized.command) {
        set({ chats: { ...get().chats, [chatId]: { ...chat, error: t('agent.local.invalidArgs') } } })
        return
      }
      if (get().pages[chatId]?.hasLater) await get().loadPage(chatId, 'latest')
      if (get().pages[chatId]?.hasLater || get().pageLoading[chatId]) return
      const next = snapshotAgentDraft(normalizeAgentDraft(draft))
      const contextError = validateAttachments(chat.root, next.attachments ?? [])
      if (contextError) { useUi.getState().toast(t(contextError), 'error'); return }
      if (!next.text.trim() && !(next.skills ?? []).length) return
      // A structured question owns the next turn. The answer must go through answerQuestion so
      // it carries the source question and the planning read-only boundary.
      if (findPendingQuestion(get().chats[chatId].messages) || findPendingPlanAction(get().chats[chatId].messages) || get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
      const queue = get().queues[chatId] ?? []
      // Running turn, or a queue left over from a stopped / disabled turn: keep FIFO order
      if (chat.status === 'running' || queue.length > 0) {
        enqueueMessage(chatId, next, composerDraft)
        if (chat.status !== 'running') drainQueue(chatId)
        return
      }
      await runTurn(chatId, next, true, composerDraft)
    },

    answerQuestion: async (chatId, itemId, answer) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running' || get().pageLoading[chatId] || resetLocks.has(chatId) || !useSettings.getState().agentEnabled) return false
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
      try {
        if (await runTurn(chatId, { text: prompt, mentions: [], command: pending.message.planning ? 'plan' : undefined }, true, undefined, readOnly)) return true
      } catch (error) {
        const current = get().chats[chatId]
        if (current) set({ chats: { ...get().chats, [chatId]: { ...current, error: errorText(error) } } })
      }
      const current = get().chats[chatId]
      if (!current) return false
      if (!current.messages.some(message => message.id === pending.message.id)) {
        // The source question can leave the loaded window when runTurn loads recent history.
        await queueChatSave(chatId, { ...current, messages: [pending.message] }).catch(error => useUi.getState().toast(errorText(error), 'error'))
      }
      const latest = get().chats[chatId]
      if (!latest) return false
      // Restore only this answer in the latest page, retaining newer text, metadata and sibling items.
      const restored = latest.messages.map(message => message.id === pending.message.id ? {
        ...message,
        items: message.items?.map(item => item.id === itemId && item.answer === trimmed
          ? { ...item, answer: pending.item.answer } : item),
      } : message)
      set({ chats: { ...get().chats, [chatId]: { ...latest, messages: restored } } })
      const restoredPage = get().pages[chatId]
      if (restoredPage) set({ pages: { ...get().pages, [chatId]: { ...restoredPage, hasPendingQuestion: true, pendingMessageId: pending.message.id } } })
      schedulePersist(chatId)
      return false
    },

    resolvePlanAction: async (chatId, itemId, action, instructions = '') => {
      if (!['implement-current', 'implement-fresh', 'continue-planning'].includes(action)) return false
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running' || get().pageLoading[chatId] || !useSettings.getState().agentEnabled) return false
      const pending = findPendingPlanAction(chat.messages)
      const lockKey = `${chatId}:${itemId}`
      if (planActionLocks.has(lockKey)) return false
      if (!pending || pending.item.id !== itemId || findPendingQuestion(chat.messages) || get().pages[chatId]?.hasPendingQuestion) return false

      planActionLocks.add(lockKey)
      // Clear-context execution intentionally reuses the current chat record and tab. The reset below
      // removes the old transcript/session before the new run starts, so a second chat cannot appear.
      const targetId = chatId
      let sourceMessage = pending.message
      const updateCard = async (resolved: boolean, state: 'launching' | 'completed' | 'failed') => {
        const current = get().chats[chatId]
        if (!current) return
        sourceMessage = { ...sourceMessage, items: sourceMessage.items?.map(item => item.id === itemId
          ? { ...item, resolved, action, actionState: state, targetChatId: targetId } : item) }
        const hasSource = current.messages.some(message => message.id === sourceMessage.id)
        // A failed clear-context launch has already reset the transcript. Restore the source card so
        // the user can retry; successful launches deliberately leave the old card out of the new context.
        const messages = hasSource
          ? current.messages.map(message => message.id === sourceMessage.id ? sourceMessage : message)
          : resolved
            ? current.messages
            : [...current.messages, sourceMessage]
        const updated = { ...current, messages, ...(!resolved ? { permissionMode: chat.permissionMode, planning: chat.planning } : {}) }
        set({ chats: { ...get().chats, [chatId]: updated } })
        const page = get().pages[chatId]
        if (page) set({ pages: { ...get().pages, [chatId]: { ...page, hasUnhandledPlanAction: !resolved || state === 'launching',
          pendingMessageId: !resolved || state === 'launching' ? sourceMessage.id : null } } })
        schedulePersist(chatId)
        // The selected card may leave the loaded window when runTurn navigates to recent history.
        await queueChatSave(chatId, { ...updated, messages: messages.some(message => message.id === sourceMessage.id) ? messages : [sourceMessage] })
      }
      const plan = (pending.message.items ?? []).filter(item => item.type === 'text' || item.type === 'plan')
        .map(item => item.text).filter(text => text.trim()).join('\n\n')
      const prompt = ['Implement the approved plan below. Re-read the relevant project instructions and files, then carry the work through implementation and requested verification.',
        plan, instructions.trim()].filter(Boolean).join('\n\n')
      try {
        // Persist the action and stable target before starting any side effects.
        await updateCard(true, 'launching')
        if (action === 'continue-planning') {
          const current = get().chats[chatId]
          set({ chats: { ...get().chats, [chatId]: { ...current, planning: true, permissionMode: 'read-only' } },
            focusRequests: { ...get().focusRequests, [chatId]: (get().focusRequests[chatId] ?? 0) + 1 } })
          get().setChatDraft(chatId, { text: instructions.trim() || get().chatDrafts[chatId]?.text || '', command: undefined })
          await updateCard(true, 'completed')
          await queueChatSave(chatId, get().chats[chatId])
          return true
        }
        if (action === 'implement-fresh') {
          const reset = await get().resetChat(chatId)
          if (!reset) {
            await updateCard(false, 'failed')
            return false
          }
        }
        const destination = get().chats[targetId]
        if (destination?.messages.some(message => message.planActionId === itemId && message.launchAccepted)) {
          await updateCard(true, 'completed')
          return true
        }
        const accepted = await runTurn(targetId, { text: prompt, mentions: [] }, true, undefined, false, false, itemId)
        if (action === 'implement-fresh') {
          if (!accepted) await updateCard(false, 'failed')
          await queueChatSave(chatId, get().chats[chatId])
          if (accepted && get().chats[targetId]?.status === 'idle') drainQueue(targetId)
          return accepted
        }
        await updateCard(accepted, accepted ? 'completed' : 'failed')
        await queueChatSave(chatId, get().chats[chatId])
        if (accepted && get().chats[targetId]?.status === 'idle') drainQueue(targetId)
        return accepted
      } catch (error) {
        await updateCard(false, 'failed').catch(() => {})
        useUi.getState().toast(errorText(error), 'error')
        return false
      } finally {
        planActionLocks.delete(lockKey)
      }
    },

    markTurnChangesReverted: (chatId, messageId) => {
      patchMessageChanges(chatId, messageId, { revertedAt: Date.now() })
    },

    markTurnChangesStale: (chatId, messageId) => {
      patchMessageChanges(chatId, messageId, { stale: true })
    },

    removeQueued: (chatId, id) => {
      if (get().deletingChats[chatId] || get().interjecting[chatId] === id) return
      const queue = (get().queues[chatId] ?? []).filter((item) => item.id !== id)
      const queues = { ...get().queues }
      if (queue.length > 0) queues[chatId] = queue
      else delete queues[chatId]
      set({ queues })
    },

    editQueued: (chatId, id) => {
      if (get().deletingChats[chatId] || get().interjecting[chatId] === id) return false
      const queue = get().queues[chatId] ?? []
      const item = queue.find((entry) => entry.id === id)
      if (!item) return false
      const current: AgentDraft = get().chatDrafts[chatId] ?? { text: '', mentions: [] }
      const text = current.text.trim() && item.text.trim()
        ? `${current.text.replace(/\s+$/, '')}\n\n${item.text.replace(/^\s+/, '')}`
        : current.text.trim() ? current.text : item.text
      const mentions = [...(current.mentions ?? []), ...(item.mentions ?? [])].filter((mention, index, all) =>
        all.findIndex((entry) => entry.rel === mention.rel && entry.isDir === mention.isDir) === index)
      const attachments = [...(current.attachments ?? []), ...(item.attachments ?? [])].filter((attachment, index, all) =>
        all.findIndex((entry) => entry.id === attachment.id) === index)
      const skills = [...(current.skills ?? []), ...(item.skills ?? [])].filter((skill, index, all) =>
        all.findIndex((entry) => entry.path === skill.path) === index)
      const command = current.command ?? item.command
      const nextQueue = queue.filter((entry) => entry.id !== id)
      const queues = { ...get().queues }
      if (nextQueue.length > 0) queues[chatId] = nextQueue
      else delete queues[chatId]
      set({
        queues,
        chatDrafts: { ...get().chatDrafts, [chatId]: {
          text,
          mentions,
          ...(attachments.length ? { attachments } : {}),
          ...(command ? { command } : {}),
          ...(skills.length ? { skills } : {}),
        } },
        focusRequests: { ...get().focusRequests, [chatId]: (get().focusRequests[chatId] ?? 0) + 1 },
      })
      return true
    },

    interjectQueued: async (chatId, id) => {
      const blocked = () => {
        const chat = get().chats[chatId]
        return !chat || get().deletingChats[chatId] || !useSettings.getState().agentEnabled || get().pageLoading[chatId] ||
          !!findPendingQuestion(chat.messages) || !!findPendingPlanAction(chat.messages) ||
          get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction ||
          [...planActionLocks].some(key => key.startsWith(`${chatId}:`))
      }
      if (blocked() || get().interjecting[chatId] || !get().queues[chatId]?.some(item => item.id === id)) return false
      set({ interjecting: { ...get().interjecting, [chatId]: id } })
      let unsubscribe: (() => void) | undefined
      let accepted = false
      let removed: { item: AgentQueuedMessage; index: number } | undefined
      try {
        const runId = get().chats[chatId].activeRunId
        if (runId) await launches.get(runId)
        const current = get().chats[chatId]
        if (!current || blocked()) return false
        if (current.status === 'running') {
          if (current.activeRunId !== runId) return false
          // Subscribe before requesting cancellation: Done can precede the IPC response.
          const stopped = new Promise<boolean>(resolve => {
            unsubscribe = useAgent.subscribe(state => {
              const chat = state.chats[chatId]
              if (!chat || state.interjecting[chatId] !== id || chat.activeRunId !== runId) resolve(false)
              else if (chat.status !== 'running') resolve(true)
            })
          })
          await api.agentCancel(chatId)
          if (!await stopped) return false
          unsubscribe?.()
          unsubscribe = undefined
        }
        if (get().pages[chatId]?.hasLater) await get().loadPage(chatId, 'latest')
        if (blocked() || get().pages[chatId]?.hasLater || get().interjecting[chatId] !== id) return false
        const queue = get().queues[chatId] ?? []
        const index = queue.findIndex(item => item.id === id)
        if (index < 0) return false
        const item = queue[index]
        const queues = { ...get().queues, [chatId]: queue.filter(entry => entry.id !== id) }
        if (!queues[chatId].length) delete queues[chatId]
        removed = { item, index }
        set({ queues })
        accepted = await runTurn(chatId, snapshotAgentDraft(item), true)
        return accepted
      } catch (error) {
        const chat = get().chats[chatId]
        if (chat) set({ chats: { ...get().chats, [chatId]: { ...chat, error: errorText(error) } } })
        return false
      } finally {
        unsubscribe?.()
        if (!accepted && removed && get().chats[chatId]) {
          const remaining = get().queues[chatId] ?? []
          if (!remaining.some(entry => entry.id === id)) {
            const restored = [...remaining]
            restored.splice(Math.min(removed.index, restored.length), 0, removed.item)
            set({ queues: { ...get().queues, [chatId]: restored } })
          }
        }
        if (get().interjecting[chatId] === id) {
          const interjecting = { ...get().interjecting }
          delete interjecting[chatId]
          set({ interjecting })
        }
        if (accepted && get().chats[chatId]?.status === 'idle') drainQueue(chatId)
      }
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
        if (chat.sessionAction === 'fork' && chat.sessionId === event.sessionId) {
          void get().stop(chatId)
          const running = { ...get().running }
          delete running[chatId]
          set({ chats: { ...get().chats, [chatId]: { ...chat, status: 'error', error: t('agent.local.forkUnsupported') } }, running })
          schedulePersist(chatId)
          return
        }
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
        next.currentContext = usage.contextTokens !== undefined || usage.contextWindow !== undefined ? usage : chat.currentContext
        const nativeTotal = normalizeAgentUsage(event.sessionUsage)
        const previous = chat.messages.at(-1)?.usage
        next.sessionUsage = nativeTotal ?? replaceTurnUsage(chat.sessionUsage, previous, usage)
        if (nativeTotal) {
          next.sessionCost = { knownUsd: nativeTotal.costUsd ?? 0, unpricedTurns: nativeTotal.costUsd === null ? 1 : 0 }
        } else {
          const cost = chat.sessionCost ?? { knownUsd: chat.sessionUsage?.costUsd ?? 0,
            unpricedTurns: chat.sessionUsage?.costUsd === null ? 1 : 0 }
          next.sessionCost = { knownUsd: Math.max(0, cost.knownUsd - (previous?.costUsd ?? 0) + (usage.costUsd ?? 0)),
            unpricedTurns: Math.max(0, cost.unpricedTurns - (previous?.costUsd === null ? 1 : 0) + (usage.costUsd === null ? 1 : 0)) }
          next.sessionUsage.costUsd = next.sessionCost.unpricedTurns ? null : next.sessionCost.knownUsd
        }
        if (next === chat) return
        set({ chats: { ...get().chats, [chatId]: next } })
        schedulePersist(chatId)
        return
      }

      if (event.kind === 'turnChanges') {
        const next = patchLastAssistantMessage(chat, message => ({ ...message, changes: event.changes }))
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
          const items = (message.items ?? []).map(item => item.type === 'permission' && ['pending', 'submitting'].includes(item.permissionState ?? '') ? { ...item, permissionState: 'expired' as const } : item.status === 'running' ? { ...item, status: event.ok ? 'ok' as const : 'error' as const } : item)
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
          const questions = items.some(item => item.type === 'question')
          if (event.ok && !event.cancelled && message.planning === true && !message.compact &&
            !findPendingQuestion(chat.messages) && !get().pages[chatId]?.hasPendingQuestion &&
            !findPendingPlanAction(chat.messages) && !get().pages[chatId]?.hasUnhandledPlanAction &&
            items.some(item => item.type === 'text' && item.text.trim()) &&
            !items.some(item => item.type === 'error' || item.type === 'plan') && !questions) {
            items.push({ id: `plan-${message.id}`, type: 'plan', text: '', resolved: false })
          }
          return items.map(item => item.type === 'question'
            ? { ...item, complete: event.ok && !event.cancelled } : item)
        })
        next = { ...next, status, error: failure, compactPending: false, updatedAt: Date.now(),
          messages: next.messages.map((message, index) => index === next.messages.length - 1 ? {
            ...message, completion: event.cancelled ? 'stopped' : event.ok ? 'completed' : 'failed',
            completedAt: event.completedAt, durationMs: event.durationMs,
          } : message) }
        if (chat.compactPending && event.ok && !event.cancelled) {
          const last = next.messages.at(-1)
          const summary = last?.items?.filter(item => item.type === 'text').map(item => item.text).join('\n\n').trim()
          if (summary && !last?.items?.some(item => item.type === 'error' || item.type === 'question')) {
            const compacted = { ...next, compactSummary: summary, sessionId: null, sessionAction: null,
              currentContext: undefined, sessionUsage: undefined, sessionCost: undefined }
            dirty.delete(chatId)
            const timer = timers.get(chatId)
            if (timer) clearTimeout(timer)
            timers.delete(chatId)
            // Retain the old session until the summary and reset have been atomically saved.
            void queueChatSave(chatId, compacted).then(() => {
              if (get().chats[chatId]?.activeRunId !== runId) return
              set({ chats: { ...get().chats, [chatId]: compacted }, running })
              schedulePersist(chatId)
            }).catch(error => {
              set({ chats: { ...get().chats, [chatId]: { ...next, error: errorText(error), status: 'error' } }, running })
              schedulePersist(chatId)
            })
            return
          }
        }
        set({ chats: { ...get().chats, [chatId]: next }, running })
        schedulePersist(chatId)

        if (event.ok && !event.cancelled) drainQueue(chatId)
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
          case 'itemComplete':
            return upsert(message, event.itemId,
              () => ({ id: event.itemId, type: 'text', text: '' }),
              item => ({ ...item, complete: true, text: event.text ?? item.text }))
          case 'toolOutputDelta': {
            const items = upsert(message, event.itemId,
              () => ({ id: event.itemId, type: 'tool', text: '', status: 'running' }),
              item => ({ ...item, output: (item.output ?? '') + event.text }))
            return applyToolOutput(items, event.itemId, event.text, sequence)
          }
          case 'permissionRequest':
            return upsert(message, event.itemId,
              () => ({ id: event.itemId, type: 'permission', text: event.reason }),
              item => ({ ...item, title: event.operation, detail: event.detail, requestId: event.requestId,
                runId, permissionState: item.permissionState ?? 'pending' }))
          case 'permissionResolved':
            return (message.items ?? []).map(item => item.requestId === event.requestId
              ? { ...item, permissionState: event.allowed ? 'allowed' : 'denied' } : item)
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
          case 'toolEnd': {
            const items = upsert(
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
            return event.output === null ? items : applyToolOutput(items, event.itemId, event.output, sequence, true)
          }
          case 'question':
            return upsert(
              message,
              event.itemId,
              () => ({
                id: event.itemId,
                type: 'question',
                text: '',
                complete: false,
                header: event.header,
                question: event.question,
                multiSelect: event.multiSelect,
                options: event.options,
              }),
              (item) => ({
                ...item,
                complete: false,
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
          case 'failure':
            return [...(message.items ?? []), { id: agentUid('e'), type: 'error', text: errorText(event.error) }]
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

    setChatProvider: (chatId, provider, { remember = true } = {}) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || !provider || chat.provider === provider || chat.status === 'running') return
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
            sessionAction: null,
            currentContext: undefined,
            sessionUsage: undefined,
            sessionCost: undefined,
            compactSummary: undefined,
            messages,
            status: chat.status === 'error' || chat.status === 'cancelled' ? 'idle' : chat.status,
            error: null,
            updatedAt: now,
          },
        },
      })
      schedulePersist(chatId)
      void get().loadCatalog(provider)
      if (remember && provider !== settings.agentDefaultProvider) {
        useSettings.getState().patch({
          agentDefaultProvider: provider,
          agentDefaultModel: model,
          agentDefaultEffort: effort,
        })
      }
    },

    setPermissionMode: (chatId, mode) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running' || get().queues[chatId]?.length ||
        findPendingQuestion(chat.messages) || findPendingPlanAction(chat.messages) ||
        get().pages[chatId]?.hasPendingQuestion || get().pages[chatId]?.hasUnhandledPlanAction) return
      set({ chats: { ...get().chats, [chatId]: { ...chat, permissionMode: mode, planning: false } } })
      schedulePersist(chatId)
      useSettings.getState().patch({ agentDefaultPermissionMode: mode })
    },

    respondPermission: async (chatId, requestId, allow) => {
      const chat = get().chats[chatId]
      const item = chat?.messages.at(-1)?.items?.find(item => item.requestId === requestId)
      if (!chat || chat.status !== 'running' || !chat.activeRunId || item?.runId !== chat.activeRunId || item.permissionState !== 'pending') return
      const runId = chat.activeRunId
      const next = patchLastAssistant(chat, message => (message.items ?? []).map(entry => entry === item
        ? { ...entry, permissionState: 'submitting', answer: allow ? 'allow' : 'deny' } : entry))
      set({ chats: { ...get().chats, [chatId]: next } })
      try {
        // Persist the user's decision before forwarding it to the live native request.
        await queueChatSave(chatId, next)
        await api.agentPermissionRespond(chatId, runId, requestId, allow)
      } catch (error) {
        const current = get().chats[chatId]
        if (!current || current.activeRunId !== runId) return
        const recovered = patchLastAssistant(current, message => (message.items ?? []).map(entry =>
          entry.requestId === requestId && entry.permissionState === 'submitting'
            ? { ...entry, permissionState: current.status === 'running' ? 'pending' : 'expired' } : entry))
        set({ chats: { ...get().chats, [chatId]: { ...recovered, error: errorText(error) } } })
        schedulePersist(chatId)
      }
    },

    setChatOptions: (chatId, patch) => {
      const chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running') return
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
            currentContext: patch.model !== undefined && patch.model !== chat.model ? undefined : chat.currentContext,
            effort,
            updatedAt: Date.now(),
          },
        },
      })
      schedulePersist(chatId)
      if (chat.provider) {
        useSettings.getState().patch({
          agentDefaultProvider: chat.provider,
          agentDefaultModel: patch.model ?? chat.model,
          agentDefaultEffort: effort,
        })
      }
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
      if (get().deletingChats[chatId]) return
      const current: AgentDraft = get().chatDrafts[chatId] ?? { text: '', mentions: [] }
      set({
        chatDrafts: { ...get().chatDrafts, [chatId]: { ...current, ...patch } },
      })
    },

    resetChat: (chatId) => {
      if (get().deletingChats[chatId]) return Promise.resolve(false)
      const existing = resetLocks.get(chatId)
      if (existing) return existing
      const work = (async () => {
      let chat = get().chats[chatId]
      if (!chat) return false
      const queuedBeforeReset = get().queues[chatId]
      const restoreQueue = () => {
        if (!queuedBeforeReset?.length || get().queues[chatId]?.length) return
        set({ queues: { ...get().queues, [chatId]: queuedBeforeReset } })
      }

      // Subscribe before cancelling: the matching Done event may arrive before the IPC call
      // resolves, and reset must never race the old process or its queued drain.
      const runId = chat.status === 'running' ? chat.activeRunId : null
      if (runId) {
        let unsubscribe: (() => void) | undefined
        const stopped = new Promise<boolean>((resolve) => {
          unsubscribe = useAgent.subscribe((state) => {
            const current = state.chats[chatId]
            if (!current || current.activeRunId !== runId || current.status !== 'running') resolve(true)
          })
        })
        try {
          // Drop queued work before Done can automatically drain it.
          const queues = { ...get().queues }
          delete queues[chatId]
          set({ queues })
          await api.agentCancel(chatId)
          if (!await stopped) {
            restoreQueue()
            return false
          }
        } catch (error) {
          restoreQueue()
          const current = get().chats[chatId]
          if (current) {
            set({ chats: { ...get().chats, [chatId]: { ...current, error: errorText(error) } } })
            schedulePersist(chatId)
          }
          return false
        } finally {
          unsubscribe?.()
        }
      }

      chat = get().chats[chatId]
      if (!chat || get().deletingChats[chatId] || chat.status === 'running') return false

      const timer = timers.get(chatId)
      if (timer) clearTimeout(timer)
      timers.delete(chatId)
      dirty.delete(chatId)
      try {
        await writeQueues.get(chatId)
      } catch {
        // The reset below is the authoritative write; a failed older patch must not block it.
      }

      const reset: AgentChat = {
        ...chat,
        title: '',
        activeRunId: null,
        eventSequence: undefined,
        sessionId: null,
        sessionUsage: undefined,
        sessionCost: undefined,
        currentContext: undefined,
        compactSummary: undefined,
        compactPending: false,
        sessionAction: null,
        planning: false,
        messages: [],
        status: 'idle',
        error: null,
        updatedAt: Date.now(),
      }
      const { messages: _messages, ...header } = reset
      try {
        const page = await api.agentChatReset(chatId, {
          ...header,
          currentContext: null,
          sessionUsage: null,
          sessionCost: null,
          compactSummary: null,
          messages: [],
        })
        const normalized = normalizeChat({ ...page.header, messages: page.messages }) ?? reset
        const pages = { ...get().pages, [chatId]: page }
        const chatDrafts = { ...get().chatDrafts }
        delete chatDrafts[chatId]
        const queues = { ...get().queues }
        delete queues[chatId]
        const interjecting = { ...get().interjecting }
        delete interjecting[chatId]
        set({
          chats: { ...get().chats, [chatId]: { ...normalized, messages: [], status: 'idle', error: null } },
          pages,
          chatDrafts,
          queues,
          interjecting,
          focusRequests: { ...get().focusRequests, [chatId]: (get().focusRequests[chatId] ?? 0) + 1 },
        })
        useTabs.getState().setTabName(chatTabId(chatId), '')
        return true
      } catch (error) {
        restoreQueue()
        const current = get().chats[chatId]
        if (current) {
          set({ chats: { ...get().chats, [chatId]: { ...current, error: errorText(error) } } })
          schedulePersist(chatId)
        }
        return false
      }
      })()
      const result = work.finally(() => {
        if (resetLocks.get(chatId) === result) resetLocks.delete(chatId)
      })
      resetLocks.set(chatId, result)
      return result
    },

    newChatFrom: (chatId) => {
      const chat = get().chats[chatId]
      if (!chat) return
      void get().resetChat(chatId)
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
  }
})
