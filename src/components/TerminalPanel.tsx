import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { lockTextSelection } from '../lib/fileDragState'
import { useTerminal } from '../store/terminal'
import { useSettings } from '../store/settings'
import { TerminalView } from './TerminalView'
import { Icon } from './Icon'
import { ErrorBoundary } from './ErrorBoundary'
import { useT } from '../i18n'
import type { TerminalTab } from '../store/terminal'
import { TerminalContextAction } from './TerminalContextAction'

const TAB_GAP = 2
const INITIAL_TAB_WIDTH = 140

/** Terminal tab title: built from the current locale, never stored in state */
function terminalTitle(
  tab: TerminalTab,
  t: (
    key: 'terminal.title' | 'terminal.titleWithPath',
    params?: { index?: number; name?: string },
  ) => string,
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
export default function TerminalPanel({ height }: { height: number }) {
  const t = useT()
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<{ id: string; x: number } | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLDivElement>(null)
  const widthsRef = useRef<Record<string, number>>({})
  const [widths, setWidths] = useState<Record<string, number>>({})
  useEffect(() => () => stopDrag.current?.(), [])
  const tabs = useTerminal((s) => s.tabs)
  const activeId = useTerminal((s) => s.activeId)
  const open = useTerminal((s) => s.open)
  const close = useTerminal((s) => s.close)
  const activate = useTerminal((s) => s.activate)
  const restart = useTerminal((s) => s.restart)
  const maximized = useTerminal((s) => s.maximized)
  const visible = useTerminal((s) => s.visible)
  const panelVisible = useSettings((s) => s.panelVisible)
  /** TerminalView must know the panel is collapsed so it can fit + repaint fully on expand */
  const shown = visible && panelVisible

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0] ?? null
  /** activeId should never be null with tabs present; fall back to the first to avoid a blank panel */
  const shownId = activeTab?.id ?? null

  const tabOrder = JSON.stringify(tabs.map(tab => tab.id))
  useLayoutEffect(() => {
    const track = trackRef.current
    if (!track) return
    const elements = [...track.querySelectorAll<HTMLElement>('[data-terminal-tab]')]
    const measured: Record<string, number> = {}
    const commit = () => {
      if (JSON.stringify(widthsRef.current) === JSON.stringify(measured)) return
      widthsRef.current = { ...measured }
      setWidths(widthsRef.current)
    }
    for (const element of elements) {
      const id = element.dataset.terminalTab!
      const width = element.offsetWidth || widthsRef.current[id]
      if (width) measured[id] = width
    }
    commit()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        const width = element.offsetWidth
        if (width > 0) measured[element.dataset.terminalTab!] = width
      }
      commit()
    })
    elements.forEach(element => observer.observe(element))
    return () => observer.disconnect()
  }, [tabOrder])

  const positions = new Map<string, number>()
  let trackWidth = 0
  for (const tab of tabs) {
    positions.set(tab.id, trackWidth)
    trackWidth += (widths[tab.id] ?? INITIAL_TAB_WIDTH) + TAB_GAP
  }
  useLayoutEffect(() => {
    if (drag || !shownId) return
    const strip = stripRef.current
    const element = trackRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    if (!strip || !element || strip.clientWidth <= 0) return
    const left = positions.get(shownId) ?? 0
    const right = left + (widths[shownId] ?? INITIAL_TAB_WIDTH)
    if (left < strip.scrollLeft) strip.scrollLeft = left
    else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth
  }, [shownId, tabOrder, widths, drag])
  useEffect(() => {
    if (drag && !tabs.some(tab => tab.id === drag.id)) stopDrag.current?.()
  }, [tabs, drag])

  const selected = tabs.find((tab) => tab.id === menu?.id)
  const index = tabs.findIndex((tab) => tab.id === menu?.id)
  const bulk = (mode: 'others' | 'left' | 'right' | 'exited') => {
    if (menu) useTerminal.getState().closeMatching(menu.id, mode)
  }
  const menuItems: MenuItem[] = selected
    ? [
        { label: t('tabs.close'), onClick: () => close(selected.id) },
        {
          label: t('tabs.closeOthers'),
          disabled: !tabs.some((tab) => tab.id !== selected.id && !tab.pinned),
          onClick: () => bulk('others'),
        },
        {
          label: t('tabs.closeLeft'),
          disabled: !tabs.slice(0, index).some((tab) => !tab.pinned),
          onClick: () => bulk('left'),
        },
        {
          label: t('tabs.closeRight'),
          disabled: !tabs.slice(index + 1).some((tab) => !tab.pinned),
          onClick: () => bulk('right'),
        },
        {
          label: t('tabs.closeAll'),
          danger: true,
          onClick: () => useTerminal.getState().closeAll(),
        },
        {
          label: t('terminal.closeExited'),
          disabled: !tabs.some((tab) => tab.exited && !tab.pinned),
          onClick: () => bulk('exited'),
        },
        { type: 'separator' },
        {
          label: t('terminal.pinLeft'),
          checked: selected.pinned === 'left',
          onClick: () =>
            useTerminal.getState().pin(selected.id, selected.pinned === 'left' ? null : 'left'),
        },
        {
          label: t('terminal.pinRight'),
          checked: selected.pinned === 'right',
          onClick: () =>
            useTerminal.getState().pin(selected.id, selected.pinned === 'right' ? null : 'right'),
        },
      ]
    : []

  return (
    <div
      className="flex min-h-0 flex-col overflow-hidden border-t border-line bg-bg"
      style={{ height }}
    >
      <div
        className="flex h-[36px] shrink-0 items-center gap-1 border-b border-line bg-panel px-2"
        onClick={(event) => {
          if (
            event.detail !== 2 ||
            (event.target as HTMLElement).closest('[data-terminal-tab], button')
          )
            return
          open()
        }}
      >
        <div ref={stripRef} className="tab-strip h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden">
          <div ref={trackRef} className="relative h-full min-w-full" style={{ width: Math.max(trackWidth, 1) }}>
          {tabs.map((tab) => {
            const active = tab.id === shownId
            return (
              <div
                key={tab.id}
                data-terminal-tab={tab.id}
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activate(tab.id)
                  }
                }}
                onContextMenu={(event) => {
                  event.preventDefault()
                  setMenu({ id: tab.id, x: event.clientX, y: event.clientY })
                }}
                onPointerDown={(event) => {
                  if ((event.target as HTMLElement).closest('button')) return
                  if (event.button === 1) {
                    event.preventDefault()
                    close(tab.id)
                    return
                  }
                  if (event.button !== 0) return
                  event.preventDefault()
                  activate(tab.id)
                  stopDrag.current?.()
                  const startX = event.clientX
                  const startY = event.clientY
                  const grabX = event.clientX - event.currentTarget.getBoundingClientRect().left
                  let unlock: (() => void) | null = null
                  const move = (pointer: PointerEvent) => {
                    const track = trackRef.current
                    const strip = stripRef.current
                    if (!track || !strip) return
                    if (!unlock && Math.abs(pointer.clientX - startX) < 4 && Math.abs(pointer.clientY - startY) < 4) return
                    if (!unlock) {
                      unlock = lockTextSelection()
                    }
                    const stripRect = strip.getBoundingClientRect()
                    if (strip.clientWidth > 0) {
                      if (pointer.clientX < stripRect.left + 24) strip.scrollLeft = Math.max(0, strip.scrollLeft - 16)
                      else if (pointer.clientX > stripRect.right - 24) strip.scrollLeft += 16
                    }
                    const order = useTerminal.getState().tabs
                    const self = order.findIndex(item => item.id === tab.id)
                    if (self < 0) { stopDrag.current?.(); return }
                    const widthOf = (id: string) => widthsRef.current[id] ?? INITIAL_TAB_WIDTH
                    let offset = 0
                    let partitionStart = 0
                    let partitionEnd = 0
                    const centers: number[] = []
                    order.forEach(item => {
                      const width = widthOf(item.id)
                      centers.push(offset + width / 2)
                      if ((item.pinned ?? null) === (order[self].pinned ?? null)) {
                        if (!partitionEnd) partitionStart = offset
                        partitionEnd = offset + width
                      }
                      offset += width + TAB_GAP
                    })
                    const x = Math.max(partitionStart, Math.min(partitionEnd - widthOf(tab.id), pointer.clientX - track.getBoundingClientRect().left - grabX))
                    setDrag({ id: tab.id, x })
                    const center = x + widthOf(tab.id) / 2
                    let target = self
                    for (let i = 0; i < order.length; i++) {
                      if ((order[i].pinned ?? null) !== (order[self].pinned ?? null)) continue
                      if (i < self && center <= centers[i]) { target = i; break }
                      if (i > self && center >= centers[i]) target = i
                    }
                    if (target !== self) useTerminal.getState().reorder(tab.id, order[target].id, target > self)
                  }
                  const stop = () => {
                    window.removeEventListener('pointermove', move)
                    window.removeEventListener('pointerup', stop)
                    window.removeEventListener('pointercancel', stop)
                    window.removeEventListener('blur', stop)
                    window.removeEventListener('keydown', key, true)
                    unlock?.()
                    unlock = null
                    setDrag(null)
                    stopDrag.current = null
                  }
                  const key = (event: KeyboardEvent) => {
                    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); stop() }
                  }
                  stopDrag.current = stop
                  window.addEventListener('pointermove', move)
                  window.addEventListener('pointerup', stop)
                  window.addEventListener('pointercancel', stop)
                  window.addEventListener('blur', stop)
                  window.addEventListener('keydown', key, true)
                }}
                data-active={active}
                data-dragging={drag?.id === tab.id}
                style={{ transform: `translate(${drag?.id === tab.id ? drag.x : positions.get(tab.id)}px, -50%)` }}
                className={`tab-pill terminal-tab group absolute left-0 top-1/2 flex h-[26px] cursor-pointer items-center gap-1.5 px-2 text-xs ${
                  active ? 'text-fg' : 'text-muted hover:bg-hover'
                }`}
              >
                <Icon
                  name="terminal"
                  size={13}
                  className={tab.exited ? 'text-muted' : 'text-success'}
                />
                <span className="max-w-[170px] truncate">{terminalTitle(tab, t)}</span>
                {tab.pinned ? <Icon name="pin" size={11} className="text-muted" /> : null}
                {/* × kills this terminal including its process group, leaving nothing behind */}
                {!tab.pinned ? (
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      close(tab.id)
                    }}
                    className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-[var(--r-row)] opacity-0 transition-colors duration-fast hover:bg-hover-strong group-hover:opacity-100 group-focus-within:opacity-100"
                    data-tip={t('terminal.closeTip')}
                    aria-label={t('terminal.closeTip')}
                  >
                    <Icon name="close" size={11} strokeWidth={2} />
                  </button>
                ) : null}
              </div>
            )
          })}
          </div>
        </div>
        <TerminalContextAction tabId={shownId} />
        <button
          data-tip={t('terminal.newTip')}
          onClick={() => open()}
          className="flex h-6 w-6 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <Icon name="plus" size={15} />
        </button>
        <button
          aria-label={t(maximized ? 'terminal.restore' : 'terminal.maximize')}
          data-tip={t(maximized ? 'terminal.restore' : 'terminal.maximize')}
          onClick={() => useTerminal.getState().setMaximized(!maximized)}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name={maximized ? 'window-restore' : 'window-maximize'} size={14} />
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
              style={{
                visibility: active ? 'visible' : 'hidden',
                pointerEvents: active ? 'auto' : 'none',
              }}
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
      {menu && selected ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  )
}
