import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { chatTabId, findPendingPlanAction, findPendingQuestion, useAgent } from '../store/agent'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import type { AgentDraft } from '../lib/agentCommand'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { openSettings } from '../lib/actions'
import { isMac } from '../lib/paths'
import { shortcutKey } from '../lib/keys'
import { AgentComposer } from './AgentComposer'
import { AssistantMessage, UserMessage } from './AgentMessage'
import { Icon } from './Icon'
import { ModelPicker } from './AgentPickers'
import { AgentContextUsage } from './AgentContextUsage'
import { CopyButton } from './CopyButton'

/** Queued prompt plus the metadata that will be sent with it. */
function serializeQueuedMessage(item: AgentDraft): string {
  const parts: string[] = []
  if (item.command) parts.push(`/${item.command}`)
  for (const skill of item.skills ?? []) parts.push(`$${skill.name} (${skill.path})`)
  for (const mention of item.mentions ?? []) parts.push(`@${mention.rel}`)
  if (item.text) parts.push(item.text)
  return parts.join('\n')
}

/** A chat tab: transcript, per-chat options and the composer. */
export function AgentChat({ chatId }: { chatId: string }) {
  const t = useT()
  const chat = useAgent((s) => s.chats[chatId])
  const page = useAgent(s => s.pages[chatId])
  const pageLoading = useAgent(s => s.pageLoading[chatId])
  const loading = useAgent((s) => s.loadingChats[chatId])
  const focusRequest = useAgent(s => s.focusRequests[chatId] ?? 0)
  const localPicker = useAgent(s => s.localPicker?.chatId === chatId ? s.localPicker : null)
  const draftState = useAgent((s) => s.chatDrafts[chatId])
  const queued = useAgent((s) => s.queues[chatId])
  const providers = useAgent((s) => s.providers)
  const enabled = useSettings((s) => s.agentEnabled)
  const focused = useTabs((s) => s.activeId === chatTabId(chatId))

  const scrollRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const captureAnchor = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll<HTMLElement>('[data-agent-message]')].find(row => row.getBoundingClientRect().bottom > top)
    anchor.current = row ? { id: row.dataset.agentMessage!, offset: row.getBoundingClientRect().top - top } : null
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const saved = anchor.current
    if (!el || !saved || atBottom) return
    const row = [...el.querySelectorAll<HTMLElement>('[data-agent-message]')].find(row => row.dataset.agentMessage === saved.id)
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset
    captureAnchor()
  }, [chat?.messages, atBottom])
  const navigate = (direction: 'earlier' | 'later' | 'pending') => {
    captureAnchor()
    setAtBottom(false)
    void useAgent.getState().loadPage(chatId, direction)
  }

  const running = chat?.status === 'running'
  const jumpKeys = isMac() ? '⇧⌘↓' : 'Ctrl+Shift+↓'

  // Esc stops the turn of the focused chat. Pickers and the context-usage popup handle Escape
  // first and stop propagation, so dismissing them must not cancel the agent.
  useEffect(() => {
    if (!focused || !running) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.isComposing || e.defaultPrevented) return
      const ui = useUi.getState()
      if (ui.overlay || ui.confirmReq || ui.promptReq) return
      e.preventDefault()
      e.stopPropagation()
      void useAgent.getState().stop(chatId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chatId, focused, running])

  useEffect(() => {
    if (providers === null) void useAgent.getState().loadProviders()
  }, [providers])

  // A tab opened before the CLI scan finished starts with no provider; adopt the first usable
  // one as soon as the list arrives, so the composer is ready without another click.
  useEffect(() => {
    if (!chat || chat.provider || !providers) return
    const agent = useAgent.getState()
    agent.resolveDefaults()
    const provider = useAgent.getState().chatDefaults.provider
    if (provider) agent.setChatProvider(chatId, provider, { remember: false })
  }, [chat?.provider, chatId, providers])

  useEffect(() => {
    if (chat?.provider) void useAgent.getState().loadCatalog(chat.provider)
  }, [chat?.provider])

  // ⌘⇧↓ / Ctrl+Shift+↓: jump to the latest message even while the composer has focus
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey || shortcutKey(e) !== 'arrowdown') return
      e.preventDefault()
      setAtBottom(true)
      const el = scrollRef.current
      if (el) el.scrollTop = el.scrollHeight
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const last = chat && chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : undefined
  const signature = useMemo(() => {
    if (!last) return 'empty'
    return `${last.id}:${(last.items ?? [])
      .map(
        (item) =>
          item.text.length +
          (item.detail?.length ?? 0) +
          (item.output?.length ?? 0) +
          (item.status ?? ''),
      )
      .join(',')}`
  }, [last])

  // Switching chat tabs reuses this component instance: start the new transcript at its end
  useEffect(() => {
    setAtBottom(true)
    anchor.current = null
  }, [chatId])

  useEffect(() => {
    if (!atBottom) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [signature, chat?.status, atBottom])

  useEffect(() => {
    const el = scrollRef.current
    const content = el?.firstElementChild
    if (!el || !content || !atBottom || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { el.scrollTop = el.scrollHeight })
    observer.observe(content)
    return () => observer.disconnect()
  }, [chatId, Boolean(chat), atBottom])

  if (!chat) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg text-xs text-muted">
        {loading ? (
          <>
            <Icon name="spinner" size={18} className="agent-spinner shrink-0 text-accent" />
            {t('agent.loading')}
          </>
        ) : (
          <>{t('agent.missingChat')}</>
        )}
      </div>
    )
  }

  const pendingQuestion = findPendingQuestion(chat.messages)
  const pendingPlan = findPendingPlanAction(chat.messages)
  const draft: AgentDraft = draftState ?? { text: '', mentions: [] }
  const providerInfo = providers?.find((provider) => provider.id === chat.provider)
  const providerMissing =
    providers !== null && (!providerInfo || !providerInfo.installed || !providerInfo.supported)
  const providerLabel =
    providerInfo?.name ?? (chat.provider || t('agent.noAgents'))


  return (
    <div className="absolute inset-0 flex flex-col bg-bg">
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-line bg-bg px-2.5">
        <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px] bg-accent/15 text-accent">
          <Icon name="agent" size={12} />
        </div>
        <span className="min-w-0 max-w-[280px] truncate text-sm font-medium text-fg/90">
          {chat.title || t('agent.newChat')}
        </span>
        <span className="shrink-0 rounded-[var(--r-row)] bg-panel-alt px-1.5 py-0.5 text-2xs text-muted">
          {providerLabel}
        </span>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            data-tip={t('agent.newChat')}
            aria-label={t('agent.newChat')}
            onClick={() => useAgent.getState().newChatFrom(chatId)}
            className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <Icon name="plus" size={14} />
          </button>
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onClickCapture={event => {
            if ((event.target as HTMLElement).closest('button[aria-expanded]')) {
              captureAnchor()
              setAtBottom(false)
            }
          }}
          onScroll={(e) => {
            const el = e.currentTarget
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40)
            captureAnchor()
          }}
          className="h-full select-text overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-4">
            {chat.error ? <div role="alert" className="text-xs text-danger">{chat.error}</div> : null}
            {page?.pendingMessageId && !chat.messages.some(m => m.id === page.pendingMessageId) ? (
              <button disabled={running || pageLoading} onClick={() => navigate('pending')} className="text-xs text-accent">
                {t('agent.history.pending')}
              </button>
            ) : null}
            {page?.hasEarlier ? (
              <button disabled={running || pageLoading} onClick={() => navigate('earlier')} className="text-xs text-accent">
                {t('agent.history.earlier')}
              </button>
            ) : null}
            {chat.messages.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-16 text-xs text-muted">
                <Icon name="agent" size={22} className="text-muted/60" />
                {t('agent.empty')}
              </div>
            ) : (
              chat.messages.map((message) =>
                <div key={message.id} data-agent-message={message.id} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
                {message.role === 'user' ? (
                  <UserMessage key={message.id} root={chat.root} message={message} />
                ) : (
                  <AssistantMessage
                    key={message.id}
                    chatId={chatId}
                    root={chat.root}
                    message={message}
                    running={running && message.id === last?.id}
                    pendingQuestionId={pendingQuestion?.item.id ?? null}
                  />
                )}
                </div>,
              )
            )}

            {page?.hasLater ? (
              <button disabled={running || pageLoading} onClick={() => navigate('later')} className="text-xs text-accent">
                {t('agent.history.later')}
              </button>
            ) : null}
          </div>
        </div>

        {!atBottom ? (
          <button
            type="button"
            onClick={() => {
              setAtBottom(true)
              const el = scrollRef.current
              if (el) el.scrollTop = el.scrollHeight
            }}
            className="absolute bottom-2 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-line bg-panel px-2.5 py-1 text-2xs text-fg shadow-popup transition-colors duration-fast hover:bg-hover-solid"
          >
            <Icon name="arrow-down" size={11} />
            {t('agent.jumpToLatest')}
            <span className="ml-0.5 rounded-[3px] border border-line-soft bg-panel-alt px-1 font-mono text-[10px] leading-[14px] text-muted">
              {jumpKeys}
            </span>
          </button>
        ) : null}
      </div>

      <div className="shrink-0 border-t border-line-soft bg-bg py-2">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-1.5 px-4">
          {queued && queued.length > 0 ? (
            <div className="flex flex-col gap-1">
              {queued.map((item) => (
                <div
                  key={item.id}
                  data-tip={t('agent.queue.pending')}
                  className="group/item flex items-center gap-1.5 rounded-[var(--r-row)] border border-line-soft bg-panel-alt px-2 py-1 text-2xs text-muted"
                >
                  <Icon name="clock" size={11} className="shrink-0" />
                  <span className="shrink-0">{t('agent.queue.badge')}</span>
                  {item.command ? (
                    <span className="shrink-0 rounded-[3px] bg-accent/10 px-1 font-mono text-[10px] text-accent">
                      /{item.command}
                    </span>
                  ) : null}
                  {(item.skills ?? []).slice(0, 2).map((skill) => (
                    <span
                      key={skill.path}
                      className="max-w-[110px] shrink-0 truncate rounded-[3px] bg-panel px-1 font-mono text-[10px] text-fg/70"
                    >
                      ${skill.name}
                    </span>
                  ))}
                  {(item.skills?.length ?? 0) > 2 ? (
                    <span className="shrink-0 text-[10px] text-muted">
                      +{(item.skills?.length ?? 0) - 2}
                    </span>
                  ) : null}
                  <span className="min-w-0 flex-1 truncate text-fg/80">
                    {item.text.split('\n')[0]}
                  </span>
                  <CopyButton
                    text={serializeQueuedMessage(item)}
                    label={t('agent.copy.queued')}
                    tip={t('agent.copy.queued')}
                    iconOnly
                    className="h-4 w-4 opacity-0 group-hover/item:opacity-100 group-focus-within/item:opacity-100"
                  />
                  <button
                    type="button"
                    aria-label={t('agent.queue.remove')}
                    data-tip={t('agent.queue.remove')}
                    onClick={() => useAgent.getState().removeQueued(chatId, item.id)}
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-muted/70 hover:bg-hover hover:text-fg"
                  >
                    <Icon name="close" size={10} />
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          {providerMissing ? (
            <div className="flex flex-wrap items-center gap-1.5 text-2xs text-warning">
              <Icon name="alert-circle" size={11} className="shrink-0" />
              <span className="min-w-0">
                {chat.provider
                  ? t('agent.providerMissing', { name: providerLabel })
                  : t('agent.noAgentsHint')}
              </span>
              <button
                type="button"
                onClick={() => openSettings('agent')}
                className="text-accent hover:underline"
              >
                {t('settings.section.agent.label')}
              </button>
            </div>
          ) : null}
          {!enabled ? (
            <div className="flex items-center gap-1.5 text-2xs text-muted">
              <Icon name="info" size={11} className="shrink-0" />
              {t('agent.disabled')}
              <button
                type="button"
                onClick={() => openSettings('agent')}
                className="text-accent hover:underline"
              >
                {t('settings.section.agent.label')}
              </button>
            </div>
          ) : null}
          {chat.sessionAction === 'fork' && chat.status === 'error' ? (
            <button onClick={() => useAgent.getState().restartSession(chatId)} className="text-xs text-accent">{t('agent.local.restart')}</button>
          ) : null}
          <div className="flex items-center gap-2 text-2xs text-muted">
            {chat.planning ? t('agent.mode.plan') : chat.permissionMode === 'read-only' ? t('agent.mode.readOnly') : null}
          </div>
          {localPicker ? (
            <div role="dialog" aria-label={t(`agent.local.${localPicker.kind}.label`)} className="flex flex-col gap-1 rounded border border-line p-2">
              <button className="self-end text-xs" onClick={() => useAgent.setState({ localPicker: null })}>{t('tabs.close')}</button>
              {localPicker.kind === 'resume' ? localPicker.chats?.map(item => (
                <button key={item.id} className="truncate text-left text-xs hover:text-accent" onClick={() => {
                  useAgent.setState({ localPicker: null })
                  void useAgent.getState().loadChat(item.id).then(() => useAgent.getState().openChatTab(item.id))
                }}>{item.title || item.id} · {item.provider}</button>
              )) : localPicker.kind === 'model' ? (
                <ModelPicker provider={chat.provider} value={chat.model} onPick={model => {
                  useAgent.getState().setChatOptions(chatId, { model })
                  useAgent.setState({ localPicker: null })
                }} />
              ) : (['read-only', 'workspace-write', 'full-access'] as const).map(mode => (
                <button key={mode} className="text-left text-xs hover:text-accent" onClick={() => {
                  useAgent.setState({ localPicker: null })
                  useAgent.getState().setPermissionMode(chatId, mode)
                }}>{t(`agent.permission.${mode}`)}</button>
              ))}
            </div>
          ) : null}
          <AgentComposer
            contextUsage={<AgentContextUsage chatId={chatId} />}
            root={chat.root}
            draft={draft.text}
            mentions={draft.mentions}
            command={draft.command}
            skills={draft.skills ?? []}
            provider={chat.provider}
            model={chat.model}
            effort={chat.effort}
            permissionMode={chat.permissionMode}
            onPermission={mode => useAgent.getState().setPermissionMode(chatId, mode)}
            running={running}
            disabled={!enabled}
            blocked={providerMissing}
            pendingQuestion={pendingQuestion !== null || page?.hasPendingQuestion}
            pendingPlan={pendingPlan !== null || page?.hasUnhandledPlanAction}
            autoFocusKey={`${chatId}:${focusRequest}`}
            onDraft={(text) => useAgent.getState().setChatDraft(chatId, { text })}
            onMentions={(mentions) => useAgent.getState().setChatDraft(chatId, { mentions })}
            onCommand={(command) => useAgent.getState().setChatDraft(chatId, { command })}
            onSkills={(skills) => useAgent.getState().setChatDraft(chatId, { skills })}
            onProvider={(provider) => useAgent.getState().setChatProvider(chatId, provider)}
            onModel={(model) => useAgent.getState().setChatOptions(chatId, { model })}
            onEffort={(effort) => useAgent.getState().setChatOptions(chatId, { effort })}
            onStop={() => void useAgent.getState().stop(chatId)}
            onSend={() => {
              if (!draft.text.trim() && !(draft.skills ?? []).length && draft.command !== 'plan') return
              setAtBottom(true)
              // Immediately scroll to bottom when sending a message
              const el = scrollRef.current
              if (el) {
                requestAnimationFrame(() => {
                  el.scrollTop = el.scrollHeight
                })
              }
              void useAgent.getState().sendMessage(chatId, draft)
            }}
          />
        </div>
      </div>
    </div>
  )
}
