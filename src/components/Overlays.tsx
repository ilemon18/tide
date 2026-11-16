import { useEffect, useMemo, useRef, useState } from 'react'
import { useWorkspace } from '../store/workspace'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import { useFileIndex } from '../store/fileIndex'
import { fuzzyMatch } from '../lib/fuzzy'
import { buildCommands, type Command } from '../lib/commands'
import { basename, dirname } from '../lib/paths'
import { newWindow, openFolderDialog, openWorkspace, removeRoot } from '../lib/actions'
import { Icon } from './Icon'
import { FileIcon } from './FileIcon'
import { relativeTime } from '../lib/format'
import { useT } from '../i18n'

export function Overlays() {
  const overlay = useUi((s) => s.overlay)
  if (overlay === 'quickopen') return <QuickOpen />
  if (overlay === 'commands') return <CommandPalette />
  if (overlay === 'projects') return <ProjectsPanel />
  return null
}

function Shell({
  children,
  onClose,
  width = 620,
}: {
  children: React.ReactNode
  onClose: () => void
  width?: number
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/25 pt-[9vh]"
      onMouseDown={onClose}
    >
      <div
        className="overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

type Entry = { root: string; rootName: string; path: string }

/** Top results kept while scoring: the list only ever shows this many, so no full sorted array is built */
const MAX_RESULTS = 60

function QuickOpen() {
  const t = useT()
  const setOverlay = useUi((s) => s.setOverlay)
  const seed = useUi((s) => s.quickOpenSeed)
  const roots = useWorkspace((s) => s.roots)
  const openFile = useTabs((s) => s.openFile)
  const jumpToLine = useTabs((s) => s.jumpToLine)

  const byRoot = useFileIndex((s) => s.byRoot)
  const ensureIndex = useFileIndex((s) => s.ensure)

  const [query, setQuery] = useState(seed)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  /** `:42` jumps to line 42 of the current file (⌃G is this entry point) */
  const gotoLine = useMemo(() => {
    const match = /^:\s*(\d{1,6})$/.exec(query.trim())
    return match ? Number(match[1]) : null
  }, [query])

  // Indexes are cached per root: opening the panel no longer rescans disk, and the store dedupes rebuilds
  const rootsKey = roots.map((r) => r.id).join('|')
  useEffect(() => {
    for (const root of roots) void ensureIndex(root.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey])

  const entries = useMemo<Entry[] | null>(() => {
    if (roots.length === 0) return []
    // Only a "ready" flag is needed here: the paths themselves are read straight out of the store while
    // scoring, so a 50k-file repo no longer materializes 50k wrapper objects on every open.
    let complete = true
    for (const root of roots) {
      const index = byRoot[root.id]
      if (!index || (index.files.length === 0 && index.building)) complete = false
    }
    return complete ? [] : null
    // Only changing roots ids require a recompute; tree / expanded changes don't affect the index
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootsKey, byRoot])

  const truncated = roots.some((root) => byRoot[root.id]?.truncated)

  const results = useMemo(() => {
    if (!entries) return []
    // Bounded insertion: keep the best MAX_RESULTS while scanning, instead of building a scored object
    // per file and sorting tens of thousands of them on every keystroke.
    const best: { entry: Entry; score: number; length: number }[] = []
    let worst = -Infinity
    for (const root of roots) {
      const files = byRoot[root.id]?.files
      if (!files || files.length === 0) continue
      const rootName = root.name
      for (const path of files) {
        const hit = fuzzyMatch(query, { path, name: basename(path) })
        if (!hit) continue
        if (best.length === MAX_RESULTS && hit.score <= worst) continue
        const candidate = { entry: { root: root.id, rootName, path }, score: hit.score, length: path.length }
        let at = best.length
        while (at > 0 && best[at - 1].score < candidate.score) at -= 1
        best.splice(at, 0, candidate)
        if (best.length > MAX_RESULTS) best.length = MAX_RESULTS
        worst = best[best.length - 1]?.score ?? -Infinity
      }
    }
    // Same ranking as before: score descending, then shorter paths first
    return best
      .slice()
      .sort((a, b) => b.score - a.score || a.length - b.length)
      .map((item) => item.entry)
  }, [entries, query, roots, byRoot])

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const close = () => setOverlay(null)
  const choose = (entry: Entry) => {
    close()
    void openFile(entry.root, entry.path)
  }
  const goToLine = (line: number) => {
    close()
    jumpToLine(line)
  }

  return (
    <Shell onClose={close}>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="search" size={15} className="text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              if (gotoLine !== null) {
                goToLine(gotoLine)
                return
              }
              const hit = results[index]
              if (hit) choose(hit)
            }
          }}
          placeholder={t('quickopen.placeholder')}
          className="h-11 flex-1 bg-transparent text-md outline-none placeholder:text-muted/60"
        />
        {entries === null ? <span className="text-xs text-muted">{t('quickopen.indexing')}</span> : null}
      </div>

      {truncated ? (
        <div className="border-b border-line px-3 py-1 text-2xs text-warning">
          {t('quickopen.truncated')}
        </div>
      ) : null}

      <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
        {gotoLine !== null ? (
          <button
            data-active="true"
            onClick={() => goToLine(gotoLine)}
            className="flex w-full items-center gap-2 bg-active px-3 py-[5px] text-left text-sm text-fg"
          >
            <Icon name="arrow-down" size={14} className="shrink-0 text-accent" />
            <span className="truncate">{t('quickopen.gotoLine', { line: gotoLine })}</span>
            <span className="ml-auto shrink-0 text-xs text-muted">{t('quickopen.enter')}</span>
          </button>
        ) : null}
        {gotoLine === null && results.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted">
            {entries === null ? t('quickopen.building') : t('quickopen.noResults')}
          </div>
        ) : null}
        {gotoLine === null
          ? results.map((entry, i) => (
              <button
                key={`${entry.root}:${entry.path}`}
                data-active={i === index}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(entry)}
                className={`flex w-full items-center gap-2 px-3 py-[5px] text-left text-sm ${
                  i === index ? 'bg-active text-fg' : 'text-fg/90'
                }`}
              >
                <FileIcon name={basename(entry.path)} size={15} />
                <span className="truncate">{basename(entry.path)}</span>
                <span className="truncate text-xs text-muted">{dirname(entry.path)}</span>
                {roots.length > 1 ? (
                  <span className="ml-auto shrink-0 rounded-full bg-panel-alt px-1.5 text-2xs text-muted">
                    {entry.rootName}
                  </span>
                ) : null}
              </button>
            ))
          : null}
      </div>
    </Shell>
  )
}

function CommandPalette() {
  const t = useT()
  const setOverlay = useUi((s) => s.setOverlay)
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const commands = useMemo<Command[]>(() => buildCommands(), [])

  // No result caching: there are few commands, and a cache would have to track locale changes (titles change)
  const q = query.trim().toLowerCase()
  const results = !q
    ? commands
    : commands.filter(
        (c) =>
          t(c.titleKey).toLowerCase().includes(q) ||
          t(c.groupKey).toLowerCase().includes(q) ||
          c.id.includes(q),
      )

  useEffect(() => setIndex(0), [query])
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  const close = () => setOverlay(null)
  const run = (command: Command) => {
    close()
    void command.run()
  }

  return (
    <Shell onClose={close} width={640}>
      <div className="flex items-center gap-2 border-b border-line px-3">
        <Icon name="command" size={15} className="text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setIndex((i) => Math.min(results.length - 1, i + 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setIndex((i) => Math.max(0, i - 1))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const cmd = results[index]
              if (cmd) run(cmd)
            }
          }}
          placeholder={t('commands.placeholder')}
          className="h-11 flex-1 bg-transparent text-md outline-none placeholder:text-muted/60"
        />
      </div>

      <div ref={listRef} className="max-h-[56vh] overflow-y-auto py-1">
        {results.map((cmd, i) => (
          <button
            key={cmd.id}
            data-active={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => run(cmd)}
            className={`flex w-full items-center gap-3 px-3 py-[6px] text-left text-sm ${
              i === index ? 'bg-active text-fg' : 'text-fg/90'
            }`}
          >
            <span className="w-[96px] shrink-0 truncate text-2xs font-medium text-muted">
              {t(cmd.groupKey)}
            </span>
            <span className="truncate">{t(cmd.titleKey)}</span>
            {cmd.shortcut ? (
              <span className="ml-auto shrink-0 text-xs text-muted">{cmd.shortcut}</span>
            ) : null}
          </button>
        ))}
        {results.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted">{t('commands.noResults')}</div>
        ) : null}
      </div>
    </Shell>
  )
}

/** Dock icon double-click / ⌘⇧O: switch project in this window, or open another window for a different project */
function ProjectsPanel() {
  const t = useT()
  const setOverlay = useUi((s) => s.setOverlay)
  const roots = useWorkspace((s) => s.roots)
  const recent = useWorkspace((s) => s.recent)
  const setActiveRoot = useWorkspace((s) => s.setActiveRoot)
  const [index, setIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const openItems = roots.map((r) => ({ id: r.id, name: r.name, path: r.id, open: true }))
  const recentItems = recent
    .filter((r) => !roots.some((root) => root.id === r.path))
    .map((r) => ({ id: r.path, name: r.name, path: r.path, open: false }))
  const items = [...openItems, ...recentItems]

  const close = () => setOverlay(null)

  const choose = (item: { id: string; path: string; open: boolean }) => {
    close()
    if (item.open) useWorkspace.getState().setActiveRoot(item.id)
    else void openWorkspace(item.path)
  }

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setIndex((i) => Math.min(items.length - 1, i + 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setIndex((i) => Math.max(0, i - 1))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const item = items[index]
        if (item) choose(item)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, index])

  return (
    <Shell onClose={close} width={560}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="files" size={15} className="text-muted" />
        <span className="flex-1 text-sm font-medium">{t('projects.title')}</span>
        <button
          onClick={() => {
            close()
            void openFolderDialog()
          }}
          className="flex items-center gap-1 rounded border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
        >
          <Icon name="folder-plus" size={12} />
          {t('projects.openFolder')}
        </button>
      </div>

      <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-muted">{t('projects.empty')}</div>
        ) : null}

        {openItems.length > 0 ? (
          <div className="px-3 pb-1 pt-1.5 text-2xs font-medium text-muted/70">
            {t('projects.opened')}
          </div>
        ) : null}
        {openItems.map((item, i) => (
          <div
            key={item.id}
            data-active={i === index}
            onMouseEnter={() => setIndex(i)}
            onClick={() => choose(item)}
            className={`group flex cursor-default items-center gap-2 px-3 py-[6px] text-sm ${
              i === index ? 'bg-active text-fg' : 'text-fg/90'
            }`}
          >
            <Icon name="folder-open" size={14} className="shrink-0 text-accent" />
            <span className="truncate">{item.name}</span>
            <span className="truncate text-2xs text-muted">{item.path}</span>
            <button
              onClick={(e) => {
                e.stopPropagation()
                void removeRoot(item.id)
              }}
              data-tip={t('projects.closeTip')}
              className="ml-auto invisible flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-danger group-hover:visible"
            >
              <Icon name="close" size={11} />
            </button>
          </div>
        ))}

        {recentItems.length > 0 ? (
          <div className="px-3 pb-1 pt-2 text-2xs font-medium text-muted/70">
            {t('projects.recent')}
          </div>
        ) : null}
        {recentItems.map((item, i) => {
          const globalIndex = openItems.length + i
          return (
            <div
              key={item.id}
              data-active={globalIndex === index}
              onMouseEnter={() => setIndex(globalIndex)}
              onClick={() => choose(item)}
              className={`group flex cursor-default items-center gap-2 px-3 py-[6px] text-sm ${
                globalIndex === index ? 'bg-active text-fg' : 'text-fg/90'
              }`}
            >
              <FileIcon name={item.name} isDir isOpen={false} size={14} />
              <span className="truncate">{item.name}</span>
              <span className="truncate text-2xs text-muted">{item.path}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  close()
                  void newWindow(item.path)
                }}
                data-tip={t('projects.openInNewWindowTip')}
                className="ml-auto invisible flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-fg group-hover:visible"
              >
                <Icon name="window" size={12} />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  useWorkspace.getState().removeRecent(item.path)
                }}
                data-tip={t('projects.removeRecentTip')}
                className="invisible flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-danger group-hover:visible group-focus-within:visible"
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          )
        })}
      </div>
    </Shell>
  )
}

export { relativeTime }