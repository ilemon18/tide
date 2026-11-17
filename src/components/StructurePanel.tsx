import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { editorStateKey, useTabs } from '../store/tabs'
import { getEditorState } from '../editor/stateCache'
import { resolveLang } from '../editor/languages'
import {
  computeOutline,
  deepestAt,
  filterOutline,
  flattenVisible,
  type FlatOutlineSymbol,
  type OutlineResult,
} from '../editor/outline'
import { signals } from '../editor/signals'
import { Icon } from './Icon'
import { SymbolGlyph } from './SymbolGlyph'
import { useT } from '../i18n'

const EMPTY: OutlineResult = { symbols: [], supported: true, truncated: false }

/** Per-file symbol tree for the active editor. Mounted only while the Structure view is selected. */
export function StructurePanel() {
  const t = useT()
  const tab = useTabs((state) => state.tabs.find((item) => item.id === state.activeId) ?? null)
  const activeGroupId = useTabs((state) => state.activeGroupId)
  const groups = useTabs((state) => state.groups)
  const stateEpoch = useTabs((state) => state.stateEpoch)
  const cursorLine = useTabs((state) => (state.activeId ? state.cursors[state.activeId]?.line : undefined))
  const jumpToLine = useTabs((state) => state.jumpToLine)

  const tabId = tab?.id ?? null
  const tabRel = tab?.rel ?? ''
  const tabKind = tab?.kind ?? null
  const tabPreview = Boolean(tab?.preview)
  const canShow = Boolean(tab && tabKind === 'file' && !tabPreview)
  const langKey = resolveLang(tabRel)?.key ?? null

  const [outline, setOutline] = useState<OutlineResult>(EMPTY)
  const [filter, setFilter] = useState('')
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const recompute = useCallback(() => {
    if (!tabId || !canShow) {
      setOutline(EMPTY)
      return
    }
    const key = editorStateKey(tabId, activeGroupId, groups)
    const state = getEditorState(key)
    if (!state) {
      // The editor state is built asynchronously on first activation. EditorHost emits onOutlineReady
      // once it is mounted, which calls this again; until then an empty tree is the honest answer.
      setOutline(EMPTY)
      return
    }
    setOutline(computeOutline(state, langKey))
  }, [tabId, canShow, activeGroupId, groups, langKey])

  const schedule = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      timer.current = null
      recompute()
    }, 260)
  }, [recompute])

  // A different file/pane starts from a clean tree immediately, not after the debounce.
  useEffect(() => {
    setFilter('')
    setCollapsedPaths(new Set())
    setSelected(null)
    recompute()
  }, [tabId, activeGroupId, recompute])

  // A disk reload rebuilds the state (and with it the Lezer tree).
  useEffect(() => {
    recompute()
  }, [stateEpoch, recompute])

  useEffect(() => {
    const onDirty = (id: string) => {
      if (id === tabId) schedule()
    }
    const onReady = (id: string) => {
      if (id === tabId) recompute()
    }
    signals.onOutlineDirty = onDirty
    signals.onOutlineReady = onReady
    return () => {
      if (signals.onOutlineDirty === onDirty) signals.onOutlineDirty = () => {}
      if (signals.onOutlineReady === onReady) signals.onOutlineReady = () => {}
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }
  }, [tabId, schedule, recompute])

  const filtering = Boolean(filter.trim())
  const rows = useMemo(() => {
    const query = filter.trim()
    return query
      ? filterOutline(outline.symbols, query)
      : flattenVisible(outline.symbols, collapsedPaths)
  }, [outline.symbols, filter, collapsedPaths])

  const activeRowId = useMemo(
    () => (cursorLine ? deepestAt(outline.symbols, cursorLine) : null),
    [outline.symbols, cursorLine],
  )
  // Moving the caret in the editor hands the highlight back to the symbol under it; keyboard navigation
  // (ArrowUp/Down) only changes `selected`, so it stays until Enter actually moves the caret.
  useEffect(() => setSelected(null), [cursorLine])
  const highlighted = selected ?? activeRowId

  const toggle = useCallback((path: string) => {
    setCollapsedPaths((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const choose = useCallback(
    (row: FlatOutlineSymbol) => {
      setSelected(row.symbol.id)
      jumpToLine(row.symbol.line, row.symbol.column)
    },
    [jumpToLine],
  )

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (rows.length === 0) return
    const currentIndex = rows.findIndex((row) => row.symbol.id === highlighted)

    const move = (delta: number) => {
      const nextIndex =
        currentIndex < 0
          ? delta > 0
            ? 0
            : rows.length - 1
          : Math.min(rows.length - 1, Math.max(0, currentIndex + delta))
      setSelected(rows[nextIndex].symbol.id)
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
      return
    }
    if (event.key === 'Enter') {
      if (currentIndex >= 0) {
        event.preventDefault()
        choose(rows[currentIndex])
      }
      return
    }
    if (event.key === 'ArrowRight') {
      if (filtering || currentIndex < 0) return
      const row = rows[currentIndex]
      if (row.symbol.children.length === 0) return
      event.preventDefault()
      if (collapsedPaths.has(row.path)) {
        toggle(row.path)
      } else {
        const child = rows[currentIndex + 1]
        if (child && child.depth > row.depth) setSelected(child.symbol.id)
      }
      return
    }
    if (event.key === 'ArrowLeft' && currentIndex >= 0) {
      if (filtering) return
      const row = rows[currentIndex]
      if (row.symbol.children.length > 0 && !collapsedPaths.has(row.path)) {
        event.preventDefault()
        toggle(row.path)
        return
      }
      // Move to the parent: the nearest preceding row with a smaller depth.
      for (let index = currentIndex - 1; index >= 0; index -= 1) {
        if (rows[index].depth < row.depth) {
          event.preventDefault()
          setSelected(rows[index].symbol.id)
          return
        }
      }
    }
  }

  const emptyText = !canShow
    ? t('structure.noFile')
    : !outline.supported
      ? t('structure.unsupported')
      : filtering
        ? t('structure.noMatches')
        : t('structure.empty')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line-soft px-2 py-1.5">
        <Icon name="filter" size={12} className="shrink-0 text-muted" />
        <input
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value)
            setSelected(null)
          }}
          placeholder={t('structure.filterPlaceholder')}
          aria-label={t('structure.filterPlaceholder')}
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-muted/60"
        />
      </div>

      {outline.truncated ? (
        <div className="shrink-0 border-b border-line-soft px-3 py-1 text-2xs text-warning">
          {t('structure.truncated')}
        </div>
      ) : null}

      {rows.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center">
          <Icon name="structure" size={24} className="text-muted/40" />
          <p className="text-xs leading-relaxed text-muted">{emptyText}</p>
        </div>
      ) : (
        <div
          role="tree"
          aria-label={t('sidebar.structure')}
          tabIndex={0}
          onKeyDown={onKeyDown}
          className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
        >
          {rows.map((row) => (
            <OutlineRow
              key={row.symbol.id}
              row={row}
              highlighted={row.symbol.id === highlighted}
              collapsed={!filtering && collapsedPaths.has(row.path)}
              filtering={filtering}
              onChoose={choose}
              onToggle={toggle}
              expandLabel={t('structure.expand')}
              collapseLabel={t('structure.collapse')}
            />
          ))}
        </div>
      )}
    </div>
  )
}

type OutlineRowProps = {
  row: FlatOutlineSymbol
  highlighted: boolean
  collapsed: boolean
  filtering: boolean
  onChoose: (row: FlatOutlineSymbol) => void
  onToggle: (path: string) => void
  expandLabel: string
  collapseLabel: string
}

/** Memoized row: moving the caret changes only the two affected rows, not a 600-row list. */
const OutlineRow = memo(function OutlineRow({
  row,
  highlighted,
  collapsed,
  filtering,
  onChoose,
  onToggle,
  expandLabel,
  collapseLabel,
}: OutlineRowProps) {
  return (
    <div
      role="treeitem"
      aria-selected={highlighted}
      aria-expanded={!filtering && row.symbol.children.length > 0 ? !collapsed : undefined}
      onClick={() => onChoose(row)}
      className={`flex h-6 cursor-pointer items-center gap-1 pr-2 text-xs ${
        highlighted ? 'bg-row-selected text-fg' : 'text-fg/85 hover:bg-hover'
      }`}
      style={{ paddingLeft: 6 + row.depth * 12 }}
    >
      {!filtering && row.symbol.children.length > 0 ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation()
            onToggle(row.path)
          }}
          aria-label={collapsed ? expandLabel : collapseLabel}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted hover:text-fg"
        >
          <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
        </button>
      ) : (
        <span className="h-4 w-4 shrink-0" />
      )}
      <SymbolGlyph kind={row.symbol.kind} />
      <span className="min-w-0 flex-1 truncate">{row.symbol.name}</span>
      <span className="shrink-0 tabular-nums text-2xs text-muted/60">{row.symbol.line}</span>
    </div>
  )
})
