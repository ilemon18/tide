import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useT } from '../i18n'
import { compactAge } from '../lib/format'
import { AGENT_HISTORY_PAGE_SIZE, useAgent } from '../store/agent'
import { useUi } from '../store/ui'
import { useWorkspace } from '../store/workspace'
import { AgentProviderIcon } from './AgentProviderIcon'
import { Icon } from './Icon'

// This page owns the search debounce; composing input is never submitted midway through an IME candidate.
const SEARCH_DELAY_MS = 250

function HistoryList({ root }: { root: string }) {
  const t = useT()
  const history = useAgent(state => state.historyByRoot[root])
  const running = useAgent(state => state.running)
  const chats = useAgent(state => state.chats)
  const deleting = useAgent(state => state.deletingChats)
  const resuming = useAgent(state => state.resumingChatId)
  const searchFocus = useUi(state => state.historySearchFocus)
  const [search, setSearch] = useState('')
  const [, setAgeTick] = useState(0)
  const [composing, setComposing] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)
  const confirmPending = useRef(false)
  const query = search.trim()

  useEffect(() => {
    searchRef.current?.focus()
    searchRef.current?.select()
  }, [searchFocus])

  useEffect(() => {
    const timer = setInterval(() => setAgeTick(tick => tick + 1), 30_000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (composing) return
    const load = () => { void useAgent.getState().loadHistory(root, { page: 1, query }) }
    // The first page and clearing search are immediate. Typing a keyword is debounced.
    const timer = query ? setTimeout(load, SEARCH_DELAY_MS) : null
    if (!query) load()
    return () => {
      if (timer !== null) clearTimeout(timer)
      useAgent.getState().clearHistory()
    }
  }, [root, query, composing])

  const totalPages = Math.max(1, Math.ceil((history?.total ?? 0) / AGENT_HISTORY_PAGE_SIZE))
  const busy = !history || history.loading
  const now = Date.now()
  const formatDate = (value: number) => {
    const date = new Date(value)
    return Number.isFinite(date.getTime())
      ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
      : ''
  }

  return (
    <>
      <div className="relative mt-4 shrink-0">
        <Icon name="search" size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          ref={searchRef}
          type="search"
          value={search}
          aria-label={t('agent.history.search')}
          placeholder={t('agent.history.search')}
          onChange={event => {
            const value = event.target.value
            if (value.trim() !== query) useAgent.getState().clearHistory()
            setSearch(value)
          }}
          onCompositionStart={() => {
            useAgent.getState().clearHistory()
            setComposing(true)
          }}
          onCompositionEnd={event => {
            setSearch(event.currentTarget.value)
            setComposing(false)
          }}
          className="h-10 w-full rounded-[var(--r-control)] border border-line bg-panel pl-9 pr-3 text-sm text-fg outline-none placeholder:text-muted focus:border-accent"
        />
      </div>

      <div className="mt-4 -mr-2 min-h-0 flex-1 overflow-y-auto pr-2" aria-busy={busy}>
        {busy ? (
          <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
            <Icon name="spinner" size={16} className="animate-spin" />{t('agent.history.loading')}
          </div>
        ) : history.error ? (
          <div role="alert" className="py-16 text-center">
            <button type="button" onClick={() => void useAgent.getState().loadHistory(root)} className="text-sm text-accent hover:underline">
              {t('agent.history.retry')}
            </button>
          </div>
        ) : history.chats.length === 0 ? (
          <p role="status" className="py-16 text-center text-sm text-muted">{t(query ? 'agent.history.noResults' : 'agent.history.empty')}</p>
        ) : (
          <ul className="divide-y divide-line-soft">
            {history.chats.map(item => {
              const title = item.title || t('agent.newChat')
              const isRunning = running[item.id] !== undefined || chats[item.id]?.status === 'running'
              return (
                <li key={item.id} className="flex items-center gap-2 rounded-[var(--r-control)] px-2 transition-colors hover:bg-hover">
                  <button
                    type="button"
                    disabled={!!resuming || deleting[item.id]}
                    aria-label={t('agent.history.open', { title })}
                    title={title}
                    className="flex min-w-0 flex-1 items-start gap-3 py-4 text-left disabled:opacity-50"
                    onClick={async () => {
                      const restored = await useAgent.getState().resumeChat(item.id, root)
                      if (!restored && searchRef.current?.isConnected && useUi.getState().historyOpen) {
                        useUi.getState().toast(t('agent.missingChat'), 'error')
                      }
                    }}
                  >
                    <AgentProviderIcon provider={item.provider} size={20} className="mt-0.5 shrink-0 text-accent" />
                    <span className="flex min-w-0 flex-1 flex-col gap-1">
                      <span className="truncate text-sm font-medium text-fg">{title}</span>
                      <span className="text-xs text-muted" title={formatDate(item.updatedAt)}>{compactAge(item.updatedAt, now)}</span>
                    </span>
                    {resuming === item.id ? <Icon name="spinner" size={16} className="shrink-0 animate-spin text-muted" /> : null}
                  </button>
                  <button
                    type="button"
                    disabled={isRunning || deleting[item.id] || !!resuming}
                    aria-label={t('agent.history.delete', { title })}
                    data-tip={t(isRunning ? 'agent.history.deleteRunning' : 'agent.history.deleteTitle')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--r-control)] text-muted hover:bg-danger/10 hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                    onClick={async event => {
                      if (confirmPending.current) return
                      confirmPending.current = true
                      const trigger = event.currentTarget
                      try {
                        const confirmed = await useUi.getState().confirm({
                          title: t('agent.history.deleteTitle'),
                          message: t('agent.history.deleteMessage', { title }),
                          confirmText: t('agent.history.deleteTitle'), danger: true, confirmOnEnter: true,
                        })
                        if (confirmed) await useAgent.getState().deleteChat(item.id, root)
                      } finally {
                        confirmPending.current = false
                        if (trigger.isConnected) trigger.focus()
                        else searchRef.current?.focus()
                      }
                    }}
                  >
                    <Icon name={deleting[item.id] ? 'spinner' : 'trash'} size={15} className={deleting[item.id] ? 'animate-spin' : ''} />
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <nav aria-label={t('agent.history.pagination')} className="mt-4 flex shrink-0 items-center justify-between gap-3 border-t border-line-soft py-4 text-xs">
        <button type="button" disabled={busy || history?.error || !!resuming || (history?.page ?? 1) <= 1}
          onClick={() => void useAgent.getState().loadHistory(root, { page: (history?.page ?? 1) - 1 })}
          className="rounded-[var(--r-control)] px-3 py-2 text-fg hover:bg-hover disabled:opacity-40">
          {t('agent.history.previous')}
        </button>
        <span role="status" className="text-muted">{t('agent.history.page', { page: history?.page ?? 1, pages: totalPages })}</span>
        <button type="button" disabled={busy || history?.error || !!resuming || (history?.page ?? 1) >= totalPages}
          onClick={() => void useAgent.getState().loadHistory(root, { page: (history?.page ?? 1) + 1 })}
          className="rounded-[var(--r-control)] px-3 py-2 text-fg hover:bg-hover disabled:opacity-40">
          {t('agent.history.next')}
        </button>
      </nav>
    </>
  )
}

export function AgentHistoryPage() {
  const t = useT()
  const root = useWorkspace(state => state.roots.find(root => root.id === state.activeRootId) ?? state.roots[0])
  const opener = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    const active = document.activeElement
    if (active instanceof HTMLElement && !active.closest('[data-history-drawer]')) opener.current = active
    return () => {
      const target = opener.current
      opener.current = null
      if (target?.isConnected) target.focus()
    }
  }, [])
  const historyKey = useRef({ id: root?.id, lifetime: root?.lifetime, revision: 0 })
  if (historyKey.current.id !== root?.id || historyKey.current.lifetime !== root?.lifetime) {
    // Symbols with the same description still represent distinct workspace lifetimes.
    historyKey.current = { id: root?.id, lifetime: root?.lifetime, revision: historyKey.current.revision + 1 }
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.repeat || event.nativeEvent.isComposing || event.defaultPrevented) return
    event.preventDefault()
    event.stopPropagation()
    useUi.getState().closeHistory()
  }
  return (
    <aside
      data-history-drawer
      aria-label={t('agent.history.title')}
      onKeyDown={onKeyDown}
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-line-soft bg-bg"
    >
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
        <header className="flex shrink-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-fg">{t('agent.history.title')}</h1>
            {root ? <p className="mt-0.5 truncate text-xs text-muted" title={root.id}>{root.name}</p> : null}
          </div>
          <button
            type="button"
            aria-label={t('agent.history.close')}
            data-tip={t('agent.history.close')}
            onClick={() => useUi.getState().closeHistory()}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <Icon name="close" size={14} />
          </button>
        </header>
        {root ? <HistoryList key={historyKey.current.revision} root={root.id} /> : (
          <p role="status" className="py-16 text-center text-sm text-muted">{t('agent.history.noProject')}</p>
        )}
      </div>
    </aside>
  )
}
