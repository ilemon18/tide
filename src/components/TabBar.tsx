import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { groupTabs, useTabs, type TabGroupId } from '../store/tabs'
import { isSvgPath } from '../lib/media'
import { basename } from '../lib/paths'
import { groupUnderPointer, highlightPane, insertionIndex } from '../lib/groupDrop'
import { lockTextSelection } from '../lib/fileDragState'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'
import { useT } from '../i18n'
import { tabTitle, tabTooltip } from '../lib/tabTitle'

const GAP = 2
/** Position estimate only, until the intrinsic tab width has been measured. */
const TAB_W = 140

type DragState = {
  id: string
  startClientX: number
  startClientY: number
  grabX: number
  pointerX: number
  active: boolean
}

type MenuState = { x: number; y: number; tabId: string }

export function TabBar({ groupId }: { groupId: TabGroupId }) {
  const t = useT()
  const allTabs = useTabs((s) => s.tabs)
  const activeGroupId = useTabs((s) => s.activeGroupId)
  const splitOrientation = useTabs((s) => s.splitOrientation)
  const group = useTabs((s) => s.groups.find((g) => g.id === groupId))
  const tabs = groupTabs(allTabs, group)
  const groupActiveId = group?.activeId ?? null
  const activate = useTabs((s) => s.activate)
  const closeIn = useTabs((s) => s.closeIn)
  const moveTabToGroup = useTabs((s) => s.moveTabToGroup)
  const promoteTab = useTabs((s) => s.promoteTab)
  const closeOthers = useTabs((s) => s.closeOthers)
  const closeLeft = useTabs((s) => s.closeLeft)
  const closeRight = useTabs((s) => s.closeRight)
  const closeAll = useTabs((s) => s.closeAll)
  const closeUnmodified = useTabs((s) => s.closeUnmodified)
  const pinTab = useTabs((s) => s.pinTab)
  const split = useTabs((s) => s.split)
  const unsplit = useTabs((s) => s.unsplit)
  const setActiveGroup = useTabs((s) => s.setActiveGroup)
  const togglePreview = useTabs((s) => s.togglePreview)

  const trackRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [widths, setWidths] = useState<Record<string, number>>({})
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** Tab ghost that follows the pointer when dragging across panes (null = dragging inside its own strip) */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)

  const tabOrder = JSON.stringify(tabs.map((tab) => tab.id))
  const [viewportWidth, setViewportWidth] = useState(0)
  const widthsRef = useRef(widths)
  widthsRef.current = widths

  // Observe intrinsic sizes, including font/locale/title changes and pane/sidebar resizing.
  // Never feed these measurements back into the tab's own width.
  useLayoutEffect(() => {
    const track = trackRef.current
    const strip = stripRef.current
    if (!track || !strip) {
      setWidths((previous) => Object.keys(previous).length === 0 ? previous : {})
      return
    }
    const measure = () => {
      const next: Record<string, number> = {}
      track.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((el) => {
        if (el.dataset.tabId) next[el.dataset.tabId] = el.getBoundingClientRect().width
      })
      setWidths((previous) =>
        Object.keys(previous).length === Object.keys(next).length &&
        Object.keys(next).every((id) => previous[id] === next[id]) ? previous : next,
      )
      setViewportWidth(strip.clientWidth)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    track.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [tabOrder])

  // Scroll the active tab into view (the scrollbar is hidden once tabs overflow, so this is the only way).
  // Do it in the layout phase: a newly opened tab is already inside the viewport on the current frame,
  // instead of painting in place and then jumping.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip || !groupActiveId || drag?.active) return
    // Tabs are absolutely positioned at left:0 and moved with translateX, so `offsetLeft` is 0 for every one
    // of them. Reading it made the strip scroll back to the first tab instead of revealing the active one;
    // the position has to come from the measured widths, the same geometry the drag code uses.
    let left = 0
    let width = 0
    for (const tab of tabs) {
      const w = widths[tab.id] ?? TAB_W
      if (tab.id === groupActiveId) {
        width = w
        break
      }
      left += w + GAP
    }
    // Not measured yet (first frame of a new tab): the width-aware pass runs once `widths` updates
    if (!width) return
    const right = left + width
    // Already visible: leave the strip exactly where the user scrolled it to
    if (left >= strip.scrollLeft && right <= strip.scrollLeft + strip.clientWidth) return
    // No smooth behavior: switching files should snap, not animate
    if (left < strip.scrollLeft) strip.scrollLeft = left
    else strip.scrollLeft = right - strip.clientWidth
    // `tabs` is rebuilt every render; the dependencies below are the ones that actually change the geometry
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupActiveId, tabOrder, widths, viewportWidth, drag?.active])

  if (tabs.length === 0) return null

  const index = menu ? tabs.findIndex((t) => t.id === menu.tabId) : -1
  const menuTab = index >= 0 ? tabs[index] : null
  const menuItems: MenuItem[] = menu
    ? [
        {
          label: t('tabs.close'),
          shortcut: '⇧⌘W',
          onClick: () => void closeIn(menu.tabId, groupId),
        },
        { label: t('tabs.closeOthers'), onClick: () => void closeOthers(menu.tabId) },
        {
          label: t('tabs.closeLeft'),
          disabled: index <= 0,
          onClick: () => void closeLeft(menu.tabId),
        },
        {
          label: t('tabs.closeRight'),
          disabled: index < 0 || index >= tabs.length - 1,
          onClick: () => void closeRight(menu.tabId),
        },
        {
          label: t('tabs.closeAll'),
          danger: true,
          onClick: () => void closeAll(),
        },
        { label: t('tabs.closeUnmodified'), onClick: () => void closeUnmodified() },
        { type: 'separator' as const },
        {
          label: menuTab?.pinned ? t('tabs.unpin') : t('tabs.pin'),
          onClick: () => pinTab(menu.tabId, !menuTab?.pinned),
        },
        { type: 'separator' as const },
        { label: t('tabs.splitRightMove'), onClick: () => void split('row', true) },
        { label: t('tabs.splitDownMove'), onClick: () => void split('column', true) },
        { label: t('tabs.splitRight'), shortcut: '⌘\\', onClick: () => void split('row', false) },
        { label: t('tabs.splitDown'), shortcut: '⇧⌘\\', onClick: () => void split('column', false) },
        ...(splitOrientation
          ? [
              { type: 'separator' as const },
              { label: t('tabs.unsplit'), onClick: () => unsplit() },
            ]
          : []),
      ]
    : []

  // Layout positions: accumulate widths, 2px gap between tabs
  const layout = new Map<string, { x: number; w: number }>()
  let cursor = 0
  for (const tab of tabs) {
    const w = widths[tab.id] ?? TAB_W
    layout.set(tab.id, { x: cursor, w })
    cursor += w + GAP
  }

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>, id: string) => {
    if (event.button === 1) {
      event.preventDefault()
      void closeIn(id, groupId)
      return
    }
    if (event.button !== 0) return
    if ((event.target as HTMLElement).closest('button')) return

    activate(id, groupId)
    const track = trackRef.current
    const tabRect = event.currentTarget.getBoundingClientRect()
    const trackLeft = track?.getBoundingClientRect().left ?? 0
    const start: DragState = {
      id,
      startClientX: event.clientX,
      startClientY: event.clientY,
      grabX: event.clientX - tabRect.left,
      pointerX: event.clientX - trackLeft,
      active: false,
    }
    dragRef.current = start

    // Dragging a tab across the editor also paints text as a selection, so lock it
    let unlockSelection: (() => void) | null = null

    const onMove = (ev: PointerEvent) => {
      const current = dragRef.current
      const trackEl = trackRef.current
      if (!current || !trackEl) return
      if (!current.active) {
        // Vertical split means vertical dragging, so check both axes
        if (
          Math.abs(ev.clientX - current.startClientX) < 4 &&
          Math.abs(ev.clientY - current.startClientY) < 4
        )
          return
        current.active = true
        promoteTab(current.id)
        unlockSelection = lockTextSelection()
      }
      const trackLeftNow = trackEl.getBoundingClientRect().left
      current.pointerX = ev.clientX - trackLeftNow
      setDrag({ ...current })

      // Pointer left its own strip = possibly changing group: stop moving it here and show the ghost
      const stripRect = stripRef.current?.getBoundingClientRect()
      const outside =
        !stripRect ||
        ev.clientX < stripRect.left ||
        ev.clientX > stripRect.right ||
        ev.clientY < stripRect.top ||
        ev.clientY > stripRect.bottom
      const targetGroup = outside ? groupUnderPointer(ev.clientX, ev.clientY) : null
      const other = targetGroup && targetGroup !== groupId ? targetGroup : null
      setGhost(other ? { x: ev.clientX, y: ev.clientY } : null)
      highlightPane(other)
      if (outside) return

      // Visual center of the dragged tab decides the insertion point (other tabs yield when it passes their center)
      const snapshot = useTabs.getState()
      const order = groupTabs(
        snapshot.tabs,
        snapshot.groups.find((g) => g.id === groupId),
      )
      const self = order.findIndex((t) => t.id === current.id)
      if (self < 0) return
      const draggedWidth = widthsRef.current[current.id] ?? TAB_W
      const center = current.pointerX - current.grabX + draggedWidth / 2

      let target = self
      let offset = 0
      for (let i = 0; i < order.length; i += 1) {
        const width = widthsRef.current[order[i].id] ?? TAB_W
        if (i !== self) {
          const mid = offset + width / 2
          if (i < self && center < mid) {
            target = i
            break
          }
          if (i > self && center > mid) target = i
        }
        offset += width + GAP
      }
      if (target !== self) useTabs.getState().moveTab(groupId, self, target)
    }

    const onUp = (ev: PointerEvent) => {
      const current = dragRef.current
      const targetGroup = groupUnderPointer(ev.clientX, ev.clientY)
      if (current?.active && targetGroup && targetGroup !== groupId) {
        moveTabToGroup(current.id, targetGroup, insertionIndex(targetGroup, ev.clientX, ev.clientY))
      }
      dragRef.current = null
      setDrag(null)
      setGhost(null)
      highlightPane(null)
      unlockSelection?.()
      unlockSelection = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const groupFocused = activeGroupId === groupId
  const groupActiveTab = tabs.find((t) => t.id === groupActiveId) ?? null
  // SVG is edited as source by default, so it alone needs a "peek at the image" exit on the tab bar's right
  const svgTab =
    groupActiveTab?.kind === 'file' && isSvgPath(groupActiveTab.rel) ? groupActiveTab : null

  return (
    <>
      <div
        className={`flex h-[36px] shrink-0 select-none items-center border-b border-line bg-panel px-2 ${
          groupFocused ? '' : 'opacity-95'
        }`}
        onPointerDown={() => setActiveGroup(groupId)}
      >
        <div
          ref={stripRef}
          data-tab-strip="true"
          className="tab-strip h-full min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          onWheel={(e) => {
            // The scrollbar is hidden: use the wheel / horizontal trackpad swipe to reach pushed-out tabs
            const strip = e.currentTarget
            if (strip.scrollWidth <= strip.clientWidth) return
            strip.scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
          }}
        >
          <div ref={trackRef} className="relative h-full" style={{ width: Math.max(cursor, 1) }}>
            {tabs.map((tab) => {
              const active = tab.id === groupActiveId
              const box = layout.get(tab.id)!
              const dragging = drag?.active && drag.id === tab.id
              // When dragged onto another pane, this one in the source strip yields to the ghost
              const away = dragging && ghost !== null
              const x = dragging ? drag!.pointerX - drag!.grabX : box.x
              return (
                <div
                  key={tab.id}
                  data-tab-id={tab.id}
                  onPointerDown={(e) => onPointerDown(e, tab.id)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    activate(tab.id, groupId)
                    setMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
                  }}
                  onDoubleClick={(e) => {
                    // Double-clicking the close button is a double-close misclick, not a tab promotion
                    if ((e.target as HTMLElement).closest('button')) return
                    promoteTab(tab.id)
                  }}
                  title={tabTooltip(tab)}
                  data-active={active}
                  data-dragging={dragging}
                  data-away={away}
                  data-pinned={tab.pinned}
                  data-temporary={tab.temporary}
                  className={`tab-pill group absolute left-0 top-[3px] flex h-[28px] cursor-default items-center gap-1.5 overflow-hidden pl-2.5 pr-1.5 text-sm ${
                    active ? 'text-fg' : 'text-muted hover:bg-hover hover:text-fg/90'
                  } ${dragging ? 'cursor-grabbing' : ''}`}
                  style={{
                    transform: `translateX(${x}px)`,
                  }}
                >
                  {tab.kind === 'chat' ? (
                    <Icon name="agent" size={14} className="shrink-0 text-accent" />
                  ) : tab.kind === 'welcome' ? (
                    <Icon name="home" size={14} className="shrink-0 text-muted" />
                  ) : tab.kind === 'settings' ? (
                    <Icon name="settings" size={14} className="shrink-0 text-muted" />
                  ) : tab.kind === 'untitled' ? (
                    <Icon name="pen" size={14} className="shrink-0 text-muted" />
                  ) : (
                    // Icon comes from the real file name: diff tab names carry a "(staged)" suffix that breaks
                    // the extension match
                    <FileIcon
                      name={basename(tab.rel)}
                      size={14}
                      className={`shrink-0 ${tab.kind === 'diff' ? 'opacity-70' : ''}`}
                    />
                  )}
                  {/* Pinned tabs show the file name like normal ones; only the right slot becomes a pin
                     (no close button to avoid accidental closes; unpin via the context menu). Same look as VSCode. */}
                  <span className={`min-w-0 truncate ${tab.temporary ? 'italic' : ''}`}>
                    {tabTitle(tab)}
                  </span>
                  {tab.dirty ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                      data-tip={t('tabs.unsavedTip')}
                    />
                  ) : null}
                  {tab.pinned ? (
                    <span
                      className="flex h-[16px] w-[16px] shrink-0 items-center justify-center text-muted/60"
                      data-tip={t('tabs.pinnedTip')}
                    >
                      <Icon name="pin" size={11} />
                    </span>
                  ) : (
                    /* The close button always hugs the tab's right edge (never follows a short name) */
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        void closeIn(tab.id, groupId)
                      }}
                      className={`ml-auto flex h-[16px] w-[16px] shrink-0 items-center justify-center rounded-[var(--r-row)] transition-colors duration-fast hover:bg-hover-strong ${
                        active
                          ? 'opacity-60 hover:opacity-100'
                          : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                      }`}
                      data-tip={t('tabs.closeTip')}
                    >
                      <Icon name="close" size={11} strokeWidth={2} />
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        </div>

        {/* Split editor to the right: creates a second pane so two files can sit side by side (⌘\) */}
        {splitOrientation ? null : (
          <button
            onClick={() => void split('row', false)}
            data-tip={t('tabs.splitTip')}
            className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-control)] text-muted transition-colors duration-fast hover:bg-hover hover:text-fg"
          >
            <Icon name="split-right" size={15} />
          </button>
        )}

        {svgTab ? (
          <button
            onClick={() => togglePreview(svgTab.id)}
            data-tip={svgTab.preview ? t('tabs.editSource') : t('tabs.viewSvg')}
            className={`ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--r-control)] transition-colors duration-fast hover:bg-hover hover:text-fg ${
              svgTab.preview ? 'text-accent' : 'text-muted'
            }`}
          >
            <Icon name={svgTab.preview ? 'pen' : 'eye'} size={15} />
          </button>
        ) : null}
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}

      {/* Ghost that follows the pointer while dragging across panes: mount on body, or the tab strip's
          overflow would clip it */}
      {ghost && drag?.active
        ? createPortal(
            <div
              className="tab-drag-ghost"
              style={{ left: ghost.x + 10, top: ghost.y - 16 }}
            >
              {(() => {
                const tab = allTabs.find((t) => t.id === drag.id)
                if (!tab) return null
                return (
                  <>
                    {tab.kind === 'chat' ? (
                      <Icon name="agent" size={14} className="shrink-0 text-accent" />
                    ) : tab.kind === 'welcome' ? (
                      <Icon name="home" size={14} className="shrink-0 text-muted" />
                    ) : tab.kind === 'settings' ? (
                      <Icon name="settings" size={14} className="shrink-0 text-muted" />
                    ) : tab.kind === 'untitled' ? (
                      <Icon name="pen" size={14} className="shrink-0 text-muted" />
                    ) : (
                      <FileIcon name={basename(tab.rel)} size={14} className="shrink-0" />
                    )}
                    <span className="truncate">{tabTitle(tab)}</span>
                  </>
                )
              })()}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
