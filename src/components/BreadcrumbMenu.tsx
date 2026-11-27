import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { readDirectoryEntries } from '../lib/workspaceEntries'
import { dirname } from '../lib/paths'
import { errorText, type DirEntryInfo } from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useTabs } from '../store/tabs'
import { useT } from '../i18n'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'

/** A directory browser rooted in the workspace; every expansion uses the same authorized IPC as Explorer. */
export function BreadcrumbMenu({
  root,
  rel,
  x,
  y,
  onClose,
}: {
  root: string
  rel: string
  x: number
  y: number
  onClose: () => void
}) {
  const t = useT()
  const showHidden = useSettings((s) => s.showHidden)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const [entries, setEntries] = useState<Record<string, DirEntryInfo[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState('')
  const base = dirname(rel)
  const dirs = [base, ...expanded]
  const key = JSON.stringify(dirs)
  useEffect(() => {
    let current = true
    for (const dir of dirs) {
      if (entries[dir]) continue
      void readDirectoryEntries(root, dir, () => current)
        .then((items) => {
          if (current) setEntries((previous) => ({ ...previous, [dir]: items }))
        })
        .catch((e) => {
          if (current) setError(errorText(e))
        })
    }
    return () => {
      current = false
    }
  }, [root, key, entries])
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (rect)
      setPos({
        x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
      })
  }, [x, y, entries, expanded])
  useEffect(() => {
    const outside = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node) && !(event.target as HTMLElement).closest('[data-breadcrumb-trigger]')) onClose()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      document.removeEventListener('mousedown', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [onClose])
  useEffect(() => {
    const selected = ref.current?.querySelector<HTMLElement>('[data-current="true"]')
    selected?.scrollIntoView({ block: 'center' })
    selected?.focus({ preventScroll: true })
  }, [entries[base]])
  const render = (dir: string, depth = 0): React.ReactNode =>
    (entries[dir] ?? [])
      .filter((entry) => entry.name !== '.DS_Store' && (showHidden || !entry.name.startsWith('.')))
      .map((entry) => (
        <div key={entry.path}>
          <button
            type="button"
            role="treeitem"
            aria-expanded={entry.isDir ? expanded.has(entry.path) : undefined}
            aria-selected={entry.path === rel}
            data-current={entry.path === rel}
            disabled={entry.isSymlink}
            style={{ paddingLeft: 8 + depth * 16 }}
            className={`flex h-7 w-full items-center gap-2 rounded-[var(--r-row)] pr-3 text-left text-sm hover:bg-hover disabled:opacity-40 ${entry.path === rel ? 'bg-row-selected text-accent' : 'text-fg'}`}
            onClick={() => {
              if (entry.isDir)
                setExpanded((previous) => {
                  const next = new Set(previous)
                  if (next.has(entry.path)) next.delete(entry.path)
                  else next.add(entry.path)
                  return next
                })
              else {
                onClose()
                void useTabs.getState().openFile(root, entry.path)
              }
            }}
          >
            {entry.isDir ? (
              <Icon
                name="chevron-right"
                size={12}
                className={expanded.has(entry.path) ? 'rotate-90' : ''}
              />
            ) : (
              <span className="w-3" />
            )}
            <FileIcon
              name={entry.name}
              isDir={entry.isDir}
              isOpen={expanded.has(entry.path)}
              size={14}
            />
            <span className="truncate">{entry.name}</span>
          </button>
          {expanded.has(entry.path) ? render(entry.path, depth + 1) : null}
        </div>
      ))
  return createPortal(
    <div
      ref={ref}
      role="tree"
      aria-label={t('breadcrumbs.siblings')}
      className="app-region-no-drag fixed z-50 max-h-[min(420px,70vh)] w-[360px] max-w-[calc(100vw-16px)] overflow-auto rounded-popup border border-line-soft bg-panel p-1 shadow-popup"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(event) => {
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        event.stopPropagation()
        const buttons = Array.from(
          ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [],
        )
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
        const next =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? buttons.length - 1
              : Math.max(
                  0,
                  Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)),
                )
        buttons[next]?.focus()
      }}
    >
      {error ? (
        <div role="alert" className="px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : !entries[base] ? (
        <div className="px-3 py-2 text-xs text-muted">{t('explorer.reading')}</div>
      ) : (
        render(base)
      )}
    </div>,
    document.body,
  )
}
