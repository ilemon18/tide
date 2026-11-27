import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useGoLive, canGoLive } from '../store/goLive'
import { useTabs } from '../store/tabs'
import { useWorkspace } from '../store/workspace'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { Icon } from './Icon'

export function GoLive() {
  const t = useT()
  const activeId = useTabs((state) => state.activeId)
  const active = useTabs((state) => state.tabs.find((tab) => tab.id === activeId))
  const servers = useGoLive((state) => state.servers)
  const busy = useGoLive((state) => state.busy)
  const roots = useWorkspace((state) => state.roots)
  const enabled = useSettings((state) => state.goLiveEnabled)
  const [menu, setMenu] = useState<{ right: number; bottom: number } | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLDivElement>(null)
  const wasEnabled = useRef(enabled)
  const current = servers.find(
    (server) => server.root === active?.root && server.rel === active?.rel,
  )
  const available = canGoLive(active)
  useEffect(() => {
    if (enabled && servers.length) void useGoLive.getState().refresh()
  }, [enabled, roots])
  useEffect(() => {
    if (wasEnabled.current && !enabled) {
      setMenu(null)
      if (servers.length) void useGoLive.getState().stopAll()
    }
    wasEnabled.current = enabled
  }, [enabled, servers.length])
  useEffect(() => {
    if (!enabled || !menu) return
    void useGoLive.getState().refresh()
    const outside = (event: MouseEvent) => {
      if (
        !ref.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setMenu(null)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMenu(null)
      }
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [enabled, menu])
  const show = (element: HTMLElement) => {
    const rect = element.getBoundingClientRect()
    setMenu((previous) =>
      previous
        ? null
        : {
            right: Math.max(8, window.innerWidth - rect.right),
            bottom: window.innerHeight - rect.top + 6,
          },
    )
  }
  const start = async () => {
    if (!enabled || !available) return
    const server = await useGoLive.getState().start(active)
    if (server) await useGoLive.getState().open(server.id)
  }
  if (!enabled) return null
  return (
    <div ref={trigger} className="flex shrink-0 items-center">
      <button
        type="button"
        aria-disabled={busy || !available}
        aria-busy={busy}
        aria-label={t('live.button')}
        data-tip={t(available ? 'live.startHint' : 'live.selectHtml')}
        className={`flex h-5 items-center justify-center gap-1 rounded-[var(--r-row)] px-1.5 text-xs leading-none ${busy ? 'cursor-wait opacity-50' : !available ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:bg-hover hover:text-fg'} ${servers.length ? 'text-success' : ''}`}
        onClick={(event) => {
          if (busy || !available) return
          if (current) show(event.currentTarget)
          else void start()
        }}
      >
        <Icon
          name={busy ? 'spinner' : 'monitor'}
          size={12}
          className={`block shrink-0 ${busy ? 'animate-spin' : ''}`}
        />
        <span className="flex items-center leading-none">
          {current ? `:${current.port}` : t('live.button')}
          {servers.length > 1 ? ` (${servers.length})` : ''}
        </span>
      </button>
      <button
        type="button"
        aria-label={t('live.running')}
        aria-expanded={Boolean(menu)}
        aria-haspopup="dialog"
        onClick={(event) => show(event.currentTarget)}
        className="cursor-pointer flex h-5 w-4 items-center justify-center rounded-[var(--r-row)] hover:bg-hover hover:text-fg"
      >
        <Icon name="chevron-down" size={11} />
      </button>
      {menu
        ? createPortal(
            <div
              ref={ref}
              role="dialog"
              aria-label={t('live.running')}
              style={menu}
              className="fixed z-50 w-[340px] max-w-[calc(100vw-16px)] rounded-popup border border-line-soft bg-panel p-2 shadow-popup"
            >
              <div className="mb-2 flex items-center justify-between gap-2 px-1 text-xs">
                <span className="text-fg">{t('live.running')}</span>
                {servers.length ? (
                  <button
                    disabled={busy}
                    className="rounded px-1.5 py-1 text-danger hover:bg-danger/10 disabled:opacity-40"
                    onClick={() => void useGoLive.getState().stopAll()}
                  >
                    {t('live.stopAll')}
                  </button>
                ) : null}
              </div>
              <div className="max-h-[240px] overflow-auto">
                {servers.map((server) => (
                  <div
                    key={server.id}
                    className="flex items-center gap-1 rounded-[var(--r-row)] hover:bg-hover"
                  >
                    <button
                      type="button"
                      onClick={() => void useGoLive.getState().open(server.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 px-2 py-2 text-left text-xs"
                      title={server.url}
                    >
                      <span className="text-success">:{server.port}</span>
                      <span className="truncate text-fg">
                        {server.rel || server.root.split(/[\\/]/).pop()}
                      </span>
                      <Icon name="external" size={11} className="ml-auto shrink-0 text-muted" />
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      aria-label={t('live.stop', { port: server.port })}
                      data-tip={t('live.stop', { port: server.port })}
                      onClick={() => void useGoLive.getState().stop(server.id)}
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    >
                      <Icon name="stop" size={12} />
                    </button>
                  </div>
                ))}
                {!servers.length ? (
                  <p className="px-2 py-3 text-xs text-muted">{t('live.empty')}</p>
                ) : null}
              </div>
              {available && !current ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void start()}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded border border-line px-2 py-1.5 text-xs text-accent hover:bg-hover disabled:opacity-40"
                >
                  <Icon name="plus" size={12} />
                  {t('live.startCurrent')}
                </button>
              ) : null}
              {active?.external ? (
                <p className="mt-2 px-1 text-2xs leading-relaxed text-muted">
                  {t('live.externalHint')}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
