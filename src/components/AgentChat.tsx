import { registerCommandHandlers } from '../lib/commandRuntime'
import { matchesShortcut, useShortcut } from '../lib/useShortcut'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { chatTabId, findPendingPlanAction, findPendingQuestion, useAgent } from '../store/agent'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import type { AgentDraft } from '../lib/agentCommand'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { openSettings } from '../lib/actions'
import { AgentComposer } from './AgentComposer'
import { AssistantMessage, UserMessage } from './AgentMessage'
import { AgentSpinner } from './AgentSpinner'
import { Icon } from './Icon'
import { ModelPicker } from './AgentPickers'
import { AgentContextUsage } from './AgentContextUsage'
import { CopyButton } from './CopyButton'
import { AgentAttachments } from './AgentAttachments'
import { serializeAttachments } from '../lib/agentContext'

/** Queued prompt plus the metadata that will be sent with it. */
function serializeQueuedMessage(item: AgentDraft): string {
  const parts: string[] = []
  if (item.command) parts.push(`/${item.command}`)
  for (const skill of item.skills ?? []) parts.push(`$${skill.name} (${skill.path})`)
  for (const mention of item.mentions ?? []) parts.push(`@${mention.rel}`)
  const attachments = serializeAttachments(item.attachments)
  if (attachments) parts.push(attachments)
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
  const interjecting = useAgent(s => s.interjecting[chatId])
  const providers = useAgent((s) => s.providers)
  const historyEnabled = useSettings((s) => s.agentHistoryEnabled)
  const enabled = useSettings((s) => s.agentEnabled)
  const active = useTabs((s) => s.activeId === chatTabId(chatId))
  const focused = active
  useEffect(() => {
    if (focused) useAgent.getState().markChatFocused(chatId)
  }, [focused, chatId])

  const scrollRef = useRef<HTMLDivElement>(null)
  const popupBoundaryRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  // Follow intent survives content growth; layout-generated scroll events must not disable it.
  const following = useRef(true)
  const lastScrollTop = useRef(0)
  const touchY = useRef<number | null>(null)
  const scrollFrame = useRef<number | null>(null)
  const displayedChat = useRef(chatId)
  const completionState = useRef<{ chatId: string; status: string | undefined }>({ chatId, status: chat?.status })
  const anchor = useRef<{ id: string; offset: number } | null>(null)
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current
    if (!el || !following.current) return
    el.scrollTop = el.scrollHeight
    lastScrollTop.current = el.scrollTop
  }, [])
  const scheduleScroll = useCallback(() => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null
      scrollToEnd()
    })
  }, [scrollToEnd])
  const resumeFollowing = useCallback(() => {
    following.current = true
    anchor.current = null
    setAtBottom(true)
    scrollToEnd()
    scheduleScroll()
  }, [scheduleScroll, scrollToEnd])
  const jumpToLatest = useCallback(async () => {
    resumeFollowing()
    if (useAgent.getState().pages[chatId]?.hasLater) await useAgent.getState().loadPage(chatId, 'latest')
    if (displayedChat.current === chatId) {
      scrollToEnd()
      scheduleScroll()
    }
  }, [chatId, resumeFollowing, scheduleScroll, scrollToEnd])
  const captureAnchor = () => {
    const el = scrollRef.current
    if (!el) return
    const top = el.getBoundingClientRect().top
    const row = [...el.querySelectorAll<HTMLElement>('[data-agent-message]')].find(row => row.getBoundingClientRect().bottom > top)
    anchor.current = row ? { id: row.dataset.agentMessage!, offset: row.getBoundingClientRect().top - top } : null
  }
  const pauseFollowing = () => {
    following.current = false
    setAtBottom(false)
    captureAnchor()
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    const saved = anchor.current
    if (!el || !saved || following.current) return
    const row = [...el.querySelectorAll<HTMLElement>('[data-agent-message]')].find(row => row.dataset.agentMessage === saved.id)
    if (row) el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - saved.offset
    lastScrollTop.current = el.scrollTop
    captureAnchor()
  }, [chat?.messages, atBottom])
  const navigate = (direction: 'earlier' | 'later' | 'pending') => {
    pauseFollowing()
    void useAgent.getState().loadPage(chatId, direction)
  }

  const running = chat?.status === 'running'
  const jumpKeys = useShortcut('context.openOrLatest')

  // Esc stops the turn of the focused chat. Pickers and the context-usage popup handle Escape
  // first and stop propagation, so dismissing them must not cancel the agent.
  useEffect(() => {
    if (!focused || !running) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.repeat || e.isComposing || e.defaultPrevented) return
      const ui = useUi.getState()
      if (ui.overlay || ui.confirmReq || ui.promptReq || document.activeElement?.closest('[data-history-drawer]')) return
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

  useEffect(() => {
    if (!focused) return
    const unregister = registerCommandHandlers({
      'context.openOrLatest': { available: () => focused && !document.activeElement?.closest('[data-shortcut-tree]') && !document.activeElement?.closest('[data-history-drawer]'), run: jumpToLatest },
    })
    // A standalone chat also uses the shared configuration. App capture consumes this first when mounted.
    const handler = (event: KeyboardEvent) => {
      if (document.activeElement?.closest('[data-shortcut-tree]') || document.activeElement?.closest('[data-history-drawer]') ||
        event.defaultPrevented || event.repeat || event.isComposing || event.keyCode === 229 ||
        !matchesShortcut('context.openOrLatest', event)) return
      const ui = useUi.getState()
      if (ui.overlay || ui.confirmReq || ui.promptReq) return
      event.preventDefault()
      void jumpToLatest()
    }
    window.addEventListener('keydown', handler)
    return () => { unregister(); window.removeEventListener('keydown', handler) }
  }, [focused, jumpToLatest])

  const last = chat && chat.messages.length > 0 ? chat.messages[chat.messages.length - 1] : undefined
  // Switching chat tabs reuses this component instance: start the new transcript at its end
  useLayoutEffect(() => {
    displayedChat.current = chatId
    resumeFollowing()
    return () => {
      displayedChat.current = ''
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current)
      scrollFrame.current = null
    }
  }, [chatId, resumeFollowing])

  // Completion can change the final reply layout after reading paused following.
  useLayoutEffect(() => {
    const previous = completionState.current
    const status = chat?.status
    const completed = previous.chatId === chatId && previous.status === 'running' && status !== 'running'
    completionState.current = { chatId, status }
    if (!completed) return
    following.current = true
    anchor.current = null
    setAtBottom(true)
    scrollToEnd()
    scheduleScroll()
  }, [chatId, chat?.status, scheduleScroll, scrollToEnd])

  // Run after the new transcript commits, then again after deferred content/layout settles.
  useLayoutEffect(() => {
    if (!following.current) return
    scrollToEnd()
    scheduleScroll()
  }, [chat?.messages, chat?.status, pageLoading, atBottom, focused, scheduleScroll, scrollToEnd])

  useEffect(() => {
    const el = scrollRef.current
    const content = el?.firstElementChild
    if (!el || !content) return
    const followRenderedContent = () => {
      if (following.current) scheduleScroll()
    }
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(followRenderedContent)
    resize?.observe(content)
    resize?.observe(el)
    // Stream smoothing and Markdown formatting commit inside the reply after the message store updates.
    // Follow those DOM commits too, even when the transcript's observed box has not resized yet.
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(followRenderedContent)
    mutations?.observe(content, { subtree: true, childList: true, characterData: true })
    return () => {
      resize?.disconnect()
      mutations?.disconnect()
    }
  }, [chatId, Boolean(chat), scheduleScroll])

  if (!chat) {
    return (
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-bg text-xs text-muted">
        {loading ? (
          <>
            <AgentSpinner size={18} />
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
  const providerName = (provider: string) => providers?.find(item => item.id === provider)?.name ||
    (provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code' : provider) || t('agent.noAgents')
  const providerLabel = providerName(chat.provider)
  const initialConversation =
    chat.messages.length === 0 &&
    (page?.total ?? 0) === 0 &&
    !page?.hasEarlier && !page?.hasLater &&
    !page?.hasPendingQuestion && !page?.hasUnhandledPlanAction &&
    !loading && !pageLoading && !running && !chat.sessionId &&
    !(queued?.length)

  return (
    <div className="absolute inset-0 flex flex-col bg-bg"
      onFocusCapture={() => useAgent.getState().markChatFocused(chatId)}
      onPointerDownCapture={() => useAgent.getState().markChatFocused(chatId)}>
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
          {historyEnabled ? (
            <button
              type="button"
              data-tip={t('agent.history.title')}
              aria-label={t('agent.history.title')}
              onClick={() => {
                useWorkspace.getState().setActiveRoot(chat.root)
                useUi.getState().openHistory()
              }}
              className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
            >
              <Icon name="clock" size={13} />
            </button>
          ) : null}
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

      <div ref={popupBoundaryRef} data-agent-content className={`flex min-h-0 flex-1 flex-col ${initialConversation ? 'overflow-y-auto' : ''}`}>
        <div className={initialConversation ? 'hidden' : 'relative min-h-0 flex-1'}>
          <div
            ref={scrollRef}
            onPointerDownCapture={event => {
              // Scrollbar presses target the viewport; message content targets its descendants.
              if (event.button === 0 && event.pointerType !== 'touch' && event.target === event.currentTarget) pauseFollowing()
            }}
            onClickCapture={event => {
              if ((event.target as HTMLElement).closest('button[aria-expanded]')) {
                pauseFollowing()
              }
            }}
            onWheel={event => { if (event.deltaY < 0) pauseFollowing() }}
            onTouchStart={event => { touchY.current = event.touches[0]?.clientY ?? null }}
            onTouchMove={event => {
              const y = event.touches[0]?.clientY ?? null
              if (y !== null && touchY.current !== null && y > touchY.current) pauseFollowing()
              touchY.current = y
            }}
            onKeyDownCapture={event => {
              if (!event.defaultPrevented && !event.nativeEvent.isComposing &&
                ['ArrowUp', 'PageUp', 'Home'].includes(event.key)) pauseFollowing()
            }}
            onScroll={(e) => {
              const el = e.currentTarget
              const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
              // Layout and skipped-content rendering can move scrollTop upward without a reading gesture.
              // Only explicit input pauses following; keep settling at the bottom after layout scrolls.
              if (!following.current && el.scrollTop > lastScrollTop.current && nearBottom) {
                following.current = true
                anchor.current = null
              }
              if (following.current && el.scrollHeight - el.scrollTop - el.clientHeight > 1) scheduleScroll()
              lastScrollTop.current = el.scrollTop
              setAtBottom(following.current && !page?.hasLater)
              if (!following.current) captureAnchor()
            }}
            className="h-full select-text overflow-y-auto"
          >
            <div className="mx-auto flex w-full max-w-[820px] flex-col gap-4 px-4 py-4">
              {!initialConversation && chat.error ? <div role="alert" className="text-xs text-danger">{chat.error}</div> : null}
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
              {chat.messages.map((message) => (
                <div key={message.id} data-agent-message={message.id}
                  // Keep live indicators out of skipped-content rendering while the reply grows.
                  style={running && message.id === last?.id
                    ? { contentVisibility: 'visible' }
                    : { contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}>
                  {message.role === 'user' ? (
                    <UserMessage key={message.id} root={chat.root} message={message} />
                  ) : (
                    <AssistantMessage
                      key={message.id}
                      chatId={chatId}
                      root={chat.root}
                      message={message}
                      providerLabel={providerName(message.provider || chat.provider)}
                      running={running && message.id === last?.id}
                      pendingQuestionId={pendingQuestion?.item.id ?? null}
                    />
                  )}
                </div>
              ))}

              {page?.hasLater ? (
                <button disabled={running || pageLoading} onClick={() => navigate('later')} className="text-xs text-accent">
                  {t('agent.history.later')}
                </button>
              ) : null}
            </div>
          </div>

          {!atBottom || page?.hasLater ? (
            <button
              type="button"
              onClick={() => void jumpToLatest()}
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

        <div className={initialConversation ? 'my-auto shrink-0 bg-bg py-6' : 'shrink-0 border-t border-line-soft bg-bg py-2'}>
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-1.5 px-4">
            {initialConversation ? (
              <div className="mb-4 flex flex-col items-center gap-3 text-center">
                <Icon name="agent" size={24} className="text-accent" />
                <h1 className="text-xl font-medium text-fg">{t('agent.empty')}</h1>
              </div>
            ) : null}
            {initialConversation && chat.error ? <div role="alert" className="text-xs text-danger">{chat.error}</div> : null}
            {queued && queued.length > 0 ? (
              <div className="flex max-h-[240px] flex-col gap-1 overflow-y-auto">
                {queued.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center gap-1.5 rounded-[var(--r-row)] border border-line-soft bg-panel px-2 py-1 text-2xs text-muted"
                  >
                    {item.attachments?.length ? <div className="w-full min-w-0"><AgentAttachments attachments={item.attachments} /></div> : null}
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
                    <button
                      type="button"
                      data-tip={t('agent.queue.pending')}
                      disabled={!!interjecting || !enabled || providerMissing || pageLoading ||
                        !!pendingQuestion || !!pendingPlan || page?.hasPendingQuestion || page?.hasUnhandledPlanAction}
                      onClick={() => {
                        void useAgent.getState().interjectQueued(chatId, item.id).then(accepted => {
                          if (accepted && displayedChat.current === chatId) resumeFollowing()
                        })
                      }}
                      className="shrink-0 rounded-[3px] px-1 py-0.5 text-accent hover:bg-accent/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t('agent.queue.send')}
                    </button>
                    <CopyButton
                      text={serializeQueuedMessage(item)}
                      label={t('agent.copy.queued')}
                      tip={t('agent.copy.queued')}
                      iconOnly
                      className="h-4 w-4"
                    />
                    <button
                      type="button"
                      aria-label={t('agent.queue.edit')}
                      data-tip={t('agent.queue.edit')}
                      disabled={interjecting === item.id}
                      onClick={() => useAgent.getState().editQueued(chatId, item.id)}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-muted/70 hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <Icon name="edit" size={10} />
                    </button>
                    <button
                      type="button"
                      aria-label={t('agent.queue.remove')}
                      data-tip={t('agent.queue.remove')}
                      disabled={interjecting === item.id}
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
            {localPicker ? (
              <div role="dialog" aria-label={t(`agent.local.${localPicker.kind}.label`)} className="flex flex-col gap-1 rounded border border-line p-2">
                <button className="self-end text-xs" onClick={() => useAgent.setState({ localPicker: null })}>{t('tabs.close')}</button>
                {localPicker.kind === 'model' ? (
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
              popupBoundaryRef={popupBoundaryRef}
              outlined={initialConversation}
              contextUsage={<AgentContextUsage chatId={chatId} />}
              root={chat.root}
              draft={draft.text}
              mentions={draft.mentions}
              attachments={draft.attachments}
              onRemoveAttachment={id => useAgent.getState().setChatDraft(chatId, {
                attachments: draft.attachments?.filter(item => item.id !== id),
              })}
              command={draft.command}
              skills={draft.skills ?? []}
              provider={chat.provider}
              model={chat.model}
              effort={chat.effort}
              permissionMode={chat.permissionMode}
              onPermission={mode => useAgent.getState().setPermissionMode(chatId, mode)}
              running={running}
              disabled={!enabled}
              blocked={providerMissing || !!interjecting}
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
                resumeFollowing()
                void useAgent.getState().sendMessage(chatId, draft)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
