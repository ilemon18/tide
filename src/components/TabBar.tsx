import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import { groupTabs, useTabs, type Tab, type TabGroupId } from '../store/tabs'
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

type Measurements = {
  widths: Record<string, number>
  viewportWidth: number
}

type TabItemProps = {
  tab: Tab
  x: number
  active: boolean
  dragging: boolean
  away: boolean
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>, id: string) => void
  onContextMenu: (event: React.MouseEvent<HTMLDivElement>, id: string) => void
  onDoubleClick: (event: React.MouseEvent<HTMLDivElement>, id: string) => void
  onClose: (id: string) => void
}

const TabItem = memo(function TabItem({
  tab,
  x,
  active,
  dragging,
  away,
  onPointerDown,
  onContextMenu,
  onDoubleClick,
  onClose,
}: TabItemProps) {
  const t = useT()
  return (
    <div
      data-tab-id={tab.id}
      onPointerDown={(event) => onPointerDown(event, tab.id)}
      onContextMenu={(event) => onContextMenu(event, tab.id)}
      onDoubleClick={(event) => onDoubleClick(event, tab.id)}
      title={tabTooltip(tab)}
      data-active={active}
      data-dragging={dragging}
      data-away={away}
      data-pinned={tab.pinned}
      data-temporary={tab.temporary}
      className={`tab-pill group absolute left-0 top-[3px] flex h-[28px] cursor-default items-center gap-1.5 overflow-hidden pl-2.5 pr-1.5 text-sm ${
        active ? 'text-fg' : 'text-muted hover:bg-hover hover:text-fg/90'
      } ${dragging ? 'cursor-grabbing' : ''}`}
      style={{ transform: `translateX(${x}px)` }}
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
        // Use the real relative path so file and diff tabs resolve the same file icon.
        <FileIcon
          name={basename(tab.rel)}
          size={14}
          className={`shrink-0 ${tab.kind === 'diff' ? 'opacity-70' : ''}`}
        />
      )}
      {/* Pinned tabs show the file name like normal ones; only the right slot becomes a pin
         (no close button to avoid accidental closes; unpin via the context menu). Same look as VSCode. */}
      <span className={`min-w-0 truncate ${tab.temporary ? 'italic' : ''}`}>{tabTitle(tab)}</span>
      {tab.dirty ? (
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" data-tip={t('tabs.unsavedTip')} />
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
          onClick={(event) => {
            event.stopPropagation()
            onClose(tab.id)
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
})

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
  const [measurements, setMeasurements] = useState<Measurements>({ widths: {}, viewportWidth: 0 })
  const measurementsRef = useRef(measurements)
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  /** Tab ghost that follows the pointer when dragging across panes (null = dragging inside its own strip) */
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null)

  const tabOrder = JSON.stringify(tabs.map((tab) => tab.id))
  const hasTabs = tabs.length > 0
  const measuredOnceRef = useRef(false)
  const wheelDeltaRef = useRef(0)
  const wheelFrameRef = useRef<number | null>(null)

  const commitMeasurements = useCallback((next: Measurements) => {
    const previous = measurementsRef.current
    if (
      previous.viewportWidth === next.viewportWidth &&
      Object.keys(previous.widths).length === Object.keys(next.widths).length &&
      Object.entries(next.widths).every(([id, width]) => previous.widths[id] === width)
    ) {
      return
    }
    measurementsRef.current = next
    setMeasurements(next)
  }, [])

  // Observe intrinsic sizes, including font/locale/title changes and pane/sidebar resizing.
  // Never feed these measurements back into the tab's own width.
  useLayoutEffect(() => {
    const track = trackRef.current
    const strip = stripRef.current
    if (!track || !strip) {
      measuredOnceRef.current = false
      commitMeasurements({ widths: {}, viewportWidth: 0 })
      return
    }

    // The first pass establishes every intrinsic width. Later observer callbacks only read tabs that
    // actually resized, while strip resizes update just the viewport used for active-tab visibility.
    // Avoid getBoundingClientRect() here: it forces a layout read for every tab on mount.
    let nextWidths = measurementsRef.current.widths
    const currentIds = new Set<string>()
    track.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((el) => {
      const id = el.dataset.tabId
      if (!id) return
      currentIds.add(id)
      if (measuredOnceRef.current && nextWidths[id] !== undefined) return
      const width = el.offsetWidth
      if (width <= 0) return
      if (nextWidths === measurementsRef.current.widths) nextWidths = { ...nextWidths }
      nextWidths[id] = width
    })
    // Drop measurements for tabs that are no longer in this group.
    for (const id of Object.keys(nextWidths)) {
      if (currentIds.has(id)) continue
      if (nextWidths === measurementsRef.current.widths) nextWidths = { ...nextWidths }
      delete nextWidths[id]
    }

    measuredOnceRef.current = true
    commitMeasurements({
      widths: nextWidths,
      viewportWidth: strip.clientWidth,
    })

    const observer = new ResizeObserver((entries) => {
      let nextWidths: Record<string, number> = measurementsRef.current.widths
      let widthsChanged = false
      let nextViewport = measurementsRef.current.viewportWidth
      for (const entry of entries) {
        if (entry.target === strip) {
          nextViewport = strip.clientWidth
          continue
        }
        const tab = entry.target as HTMLElement
        const id = tab.dataset.tabId
        if (!id) continue
        const width = entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width
        if (width <= 0 || measurementsRef.current.widths[id] === width) continue
        if (nextWidths === measurementsRef.current.widths) nextWidths = { ...nextWidths }
        nextWidths[id] = width
        widthsChanged = true
      }
      if (!widthsChanged && nextViewport === measurementsRef.current.viewportWidth) return
      commitMeasurements({ widths: nextWidths, viewportWidth: nextViewport })
    })
    observer.observe(strip)
    track.querySelectorAll<HTMLElement>('[data-tab-id]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [commitMeasurements, tabOrder])

  // Let the browser handle horizontal trackpad scrolling natively. Vertical mouse-wheel deltas are
  // accumulated and committed as one scrollLeft write per frame, with no layout reads in the handler.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const flush = () => {
      wheelFrameRef.current = null
      const delta = wheelDeltaRef.current
      wheelDeltaRef.current = 0
      if (delta !== 0) strip.scrollLeft += delta
    }
    const onWheel = (event: WheelEvent) => {
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return
      if (event.deltaY === 0) return
      event.preventDefault()
      wheelDeltaRef.current += event.deltaY
      if (wheelFrameRef.current === null) wheelFrameRef.current = requestAnimationFrame(flush)
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      strip.removeEventListener('wheel', onWheel)
      if (wheelFrameRef.current !== null) cancelAnimationFrame(wheelFrameRef.current)
      wheelFrameRef.current = null
      wheelDeltaRef.current = 0
    }
  }, [hasTabs])

  // Cache absolute positions; drag/active updates can move a tab without rebuilding every layout.
  const { layout, cursor } = useMemo(() => {
    const positions = new Map<string, { x: number; w: number }>()
    let nextCursor = 0
    for (const tab of tabs) {
      const width = measurements.widths[tab.id] ?? TAB_W
      positions.set(tab.id, { x: nextCursor, w: width })
      nextCursor += width + GAP
    }
    return { layout: positions, cursor: nextCursor }
  }, [measurements.widths, tabOrder])

  // Scroll the active tab into view (the scrollbar is hidden once tabs overflow, so this is the only way).
  // Do it in the layout phase: a newly opened tab is already inside the viewport on the current frame,
  // instead of painting in place and then jumping.
  useLayoutEffect(() => {
    const strip = stripRef.current
    if (!strip || !groupActiveId || drag?.active) return
    // Tabs are absolutely positioned at left:0 and moved with translateX, so `offsetLeft` is 0 for every
    // one. Use the cached layout instead of reading geometry from each node.
    const box = layout.get(groupActiveId)
    if (!box || measurements.widths[groupActiveId] === undefined) return
    const left = box.x
    const width = box.w
    const right = left + width
    // Already visible: leave the strip exactly where the user scrolled it to
    if (left >= strip.scrollLeft && right <= strip.scrollLeft + measurements.viewportWidth) return
    // No smooth behavior: switching files should snap, not animate
    if (left < strip.scrollLeft) strip.scrollLeft = left
    else strip.scrollLeft = right - measurements.viewportWidth
  }, [drag?.active, groupActiveId, layout, measurements])

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

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>, id: string) => {
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
      const draggedWidth = measurementsRef.current.widths[current.id] ?? TAB_W
      const center = current.pointerX - current.grabX + draggedWidth / 2

      let target = self
      let offset = 0
      for (let i = 0; i < order.length; i += 1) {
        const width = measurementsRef.current.widths[order[i].id] ?? TAB_W
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
  }, [activate, closeIn, groupId, moveTabToGroup, promoteTab])

  const onContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>, id: string) => {
    event.preventDefault()
    activate(id, groupId)
    setMenu({ x: event.clientX, y: event.clientY, tabId: id })
  }, [activate, groupId])

  const onDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>, id: string) => {
    // Double-clicking the close button is a double-close misclick, not a tab promotion
    if ((event.target as HTMLElement).closest('button')) return
    promoteTab(id)
  }, [promoteTab])

  const onClose = useCallback((id: string) => {
    void closeIn(id, groupId)
  }, [closeIn, groupId])

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
        >
          <div ref={trackRef} className="relative h-full" style={{ width: Math.max(cursor, 1) }}>
            {tabs.map((tab) => {
              const box = layout.get(tab.id)
              if (!box) return null
              const dragging = Boolean(drag?.active && drag.id === tab.id)
              // When dragged onto another pane, this one in the source strip yields to the ghost
              const away = dragging && ghost !== null
              const x = dragging ? drag!.pointerX - drag!.grabX : box.x
              return (
                <TabItem
                  key={tab.id}
                  tab={tab}
                  x={x}
                  active={tab.id === groupActiveId}
                  dragging={dragging}
                  away={away}
                  onPointerDown={onPointerDown}
                  onContextMenu={onContextMenu}
                  onDoubleClick={onDoubleClick}
                  onClose={onClose}
                />
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
