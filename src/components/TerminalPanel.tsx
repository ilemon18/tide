import { useTerminal } from '../store/terminal'
import { useSettings } from '../store/settings'
import { TerminalView } from './TerminalView'
import { Icon } from './Icon'
import { ErrorBoundary } from './ErrorBoundary'
import { useT } from '../i18n'
import type { TerminalTab } from '../store/terminal'

/** Terminal tab title: built from the current locale, never stored in state */
function terminalTitle(
  tab: TerminalTab,
  t: (key: 'terminal.title' | 'terminal.titleWithPath', params?: { index?: number; name?: string }) => string,
): string {
  if (tab.rel) {
    const name = tab.rel.split('/').pop() || tab.rel
    return t('terminal.titleWithPath', { name })
  }
  return t('terminal.title', { index: tab.ordinal })
}

/**
 * Terminal panel. Every xterm instance stays mounted (inactive ones hidden via visibility), so the
 * screen survives tab switches and collapse/expand — mounting only the active tab leaves full-screen
 * programs (vim, less) blank until a key is pressed. A few MB per terminal is a fair price. PTYs live
 * in the backend, so collapsing or switching tabs never respawns the shell.
 */
export default function TerminalPanel() {
  const t = useT()
  const tabs = useTerminal((s) => s.tabs)
  const activeId = useTerminal((s) => s.activeId)
  const open = useTerminal((s) => s.open)
  const close = useTerminal((s) => s.close)
  const activate = useTerminal((s) => s.activate)
  const restart = useTerminal((s) => s.restart)
  const height = useSettings((s) => s.panelHeight)
  const visible = useTerminal((s) => s.visible)
  const panelVisible = useSettings((s) => s.panelVisible)
  /** TerminalView must know the panel is collapsed so it can fit + repaint fully on expand */
  const shown = visible && panelVisible

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  /** activeId should never be null with tabs present; fall back to the first to avoid a blank panel */
  const shownId = activeTab?.id ?? null

  return (
    <div className="flex min-h-0 flex-col overflow-hidden border-t border-line bg-bg" style={{ height }}>
      <div className="flex h-[36px] shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((tab) => {
            const active = tab.id === shownId
            return (
              <div
                key={tab.id}
                onMouseDown={() => activate(tab.id)}
                data-active={active}
                className={`tab-pill group flex h-[26px] shrink-0 cursor-default items-center gap-1.5 px-2 text-xs ${
                  active ? 'text-fg' : 'text-muted hover:bg-hover'
                }`}
              >
                <Icon
                  name="terminal"
                  size={13}
                  className={tab.exited ? 'text-muted' : 'text-success'}
                />
                <span className="max-w-[170px] truncate">{terminalTitle(tab, t)}</span>
                {/* × kills this terminal including its process group, leaving nothing behind */}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    close(tab.id)
                  }}
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-[var(--r-row)] opacity-0 transition-colors duration-fast hover:bg-hover-strong group-hover:opacity-100 group-focus-within:opacity-100"
                  data-tip={t('terminal.closeTip')}
                >
                  <Icon name="close" size={11} strokeWidth={2} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          data-tip={t('terminal.newTip')}
          onClick={() => open()}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <Icon name="plus" size={15} />
        </button>
        <span className="mx-0.5 h-4 w-px shrink-0 bg-line" />
        <button
          data-tip={t('terminal.killTip')}
          disabled={!activeTab}
          onClick={() => {
            if (activeTab) close(activeTab.id)
          }}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-danger disabled:opacity-30 disabled:hover:bg-transparent"
        >
          <Icon name="trash" size={14} />
        </button>
      </div>

      <div className="relative min-h-0 flex-1">
        {tabs.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
            <span>{t('terminal.empty')}</span>
          </div>
        ) : null}
        {/* One resident xterm per tab; inactive ones are only hidden, so sizes stay and rendering isn't interrupted */}
        {tabs.map((tab) => {
          const active = tab.id === shownId
          return (
            <div
              key={`${tab.id}:${tab.generation}`}
              className="absolute inset-0"
              style={{ visibility: active ? 'visible' : 'hidden', pointerEvents: active ? 'auto' : 'none' }}
              aria-hidden={!active}
            >
              <ErrorBoundary label={t('activity.terminal')}>
                <TerminalView tab={tab} active={active && shown} />
              </ErrorBoundary>
            </div>
          )
        })}
      </div>

      {activeTab?.exited ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-panel px-2.5 py-1 text-xs text-muted">
          <Icon name="warning" size={12} className="text-warning" />
          <span>{t('terminal.exited')}</span>
          <button
            onClick={() => restart(activeTab.id)}
            className="ml-auto flex items-center gap-1 rounded-[4px] border border-line px-2 py-[2px] text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name="refresh" size={11} />
            {t('terminal.restart')}
          </button>
        </div>
      ) : null}
    </div>
  )
}