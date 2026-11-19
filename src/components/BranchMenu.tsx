import { useEffect, useMemo, useRef, useState } from 'react'
import { useGit } from '../store/git'
import { useUi } from '../store/ui'
import { checkoutBranch, createBranch, fetchRemote } from '../lib/actions'
import { relativeTime, shortSha } from '../lib/format'
import { Icon } from './Icon'
import type { GitBranch } from '../lib/ipc'
import { useT } from '../i18n'

/** By default show only branches active in the last 5 days; older ones via search or "show all" */
const RECENT_DAYS = 5
const SEARCH_LIMIT = 200

/** Current branch -> local branches (newest commit first) -> remote branches (newest commit first) */
function sortBranches(list: GitBranch[]): GitBranch[] {
  return [...list].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1
    return b.time - a.time
  })
}

/** Branch dropdown in the status bar's bottom-left: filter + checkout + fetch remote (VS Code style) */
export function BranchMenu() {
  const t = useT()
  const menu = useUi((s) => s.branchMenu)
  const close = useUi((s) => s.closeBranchMenu)
  const data = useGit((s) => (menu ? s.branches[menu.root] : undefined))
  const loading = useGit((s) => (menu ? s.branchesLoading[menu.root] : false))
  const busy = useGit((s) => s.busy)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [creating, setCreating] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)

  const root = menu?.root ?? null

  useEffect(() => {
    if (!menu) return
    setQuery('')
    setIndex(0)
    setShowAll(false)
    void useGit.getState().loadBranches(menu.root)
  }, [menu])

  const all = useMemo(() => (data ? sortBranches(data.branches) : []), [data])

  const recentItems = useMemo(() => {
    const cutoff = Date.now() / 1000 - RECENT_DAYS * 86400
    // Always keep the current branch so you can see where you are on a detached / old branch
    return all.filter((b) => b.current || b.time >= cutoff)
  }, [all])

  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return null
    // Match branch names only: this used to match commit messages too, so searching master
    // also listed unrelated branches that mention master in a commit.
    const hits = all.filter((b) => b.name.toLowerCase().includes(q))
    const rank = (branch: GitBranch) => {
      const name = branch.name.toLowerCase()
      if (name === q) return 0
      if (name.startsWith(q)) return 1
      // Remote branches like origin/master: an exact match on the last segment also counts
      if (name.split('/').pop() === q) return 1
      if (name.includes(`/${q}`)) return 2
      return 3
    }
    // sort is stable: within a rank the original "current / local / remote + newest first" order holds
    return [...hits].sort((a, b) => rank(a) - rank(b))
  }, [all, query])

  const items = searched ?? (showAll ? all : recentItems)
  const shown = searched ? searched.slice(0, SEARCH_LIMIT) : items
  const truncated = searched ? searched.length > SEARCH_LIMIT : false

  // When no branch matches, allow creating a new branch from the typed name
  const createName = query.trim()
  const canCreate =
    !!searched && createName !== '' && !all.some((b) => b.name === createName)
  const total = shown.length + (canCreate ? 1 : 0)

  useEffect(() => setIndex(0), [query, showAll])

  // When the result count shrinks (list refreshed, create row gone) pull the highlight back in range
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, total - 1)))
  }, [total])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index])

  if (!menu || !root) return null

  const pick = (branch: GitBranch) => {
    close()
    if (branch.current) return
    void checkoutBranch(root, branch.name, branch.kind)
  }

  const runCreate = () => {
    if (!canCreate || creating || busy !== null) return
    setCreating(true)
    void createBranch(root, createName).then((ok) => {
      setCreating(false)
      // Keep the dialog open on failure so the user can retry with another name
      if (ok) close()
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4"
      onMouseDown={close}
    >
      <div
        className="flex w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
        style={{ maxHeight: '60vh' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-3 py-2">
          <Icon name="search" size={14} className="text-muted" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setIndex((i) => Math.min(total - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setIndex((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                if (index >= shown.length) {
                  if (canCreate) runCreate()
                } else {
                  const item = shown[index]
                  if (item) pick(item)
                }
              } else if (e.key === 'Escape') {
                e.preventDefault()
                close()
              }
            }}
            placeholder={t('branch.searchPlaceholder')}
            className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
          />
          {data?.detached ? (
            <span className="shrink-0 rounded-full bg-panel-alt px-1.5 text-2xs text-warning">
              detached
            </span>
          ) : null}
          <button
            data-tip={t('status.fetchTip')}
            disabled={busy !== null}
            onClick={() => void fetchRemote(root)}
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
          >
            <Icon
              name={busy === 'fetch' ? 'spinner' : 'refresh'}
              size={14}
              className={busy === 'fetch' ? 'animate-spin' : ''}
            />
          </button>
        </div>

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          {loading && !data ? (
            <div className="px-3 py-8 text-center text-sm text-muted">{t('branch.loading')}</div>
          ) : null}

          {shown.length === 0 && data && !canCreate ? (
            <div className="px-3 py-8 text-center text-sm text-muted">
              {searched ? t('branch.noMatch') : t('branch.noRecent')}
            </div>
          ) : null}

          {shown.map((branch, i) => (
            <button
              key={`${branch.kind}:${branch.name}`}
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(branch)}
              className={`flex w-full items-center gap-2 px-3 py-[6px] text-left ${
                i === index ? 'bg-active' : ''
              }`}
              title={`${branch.name}${branch.subject ? `\n${branch.subject}` : ''}`}
            >
              <Icon
                name="git"
                size={13}
                className={branch.current ? 'shrink-0 text-accent' : 'shrink-0 text-muted'}
              />
              <span className="min-w-0 shrink-0 max-w-[46%] truncate text-sm text-fg">
                {branch.name}
              </span>
              {branch.kind === 'remote' ? (
                <span className="shrink-0 rounded-full bg-panel-alt px-1.5 text-2xs text-muted/70">
                  remote
                </span>
              ) : null}
              <span className="min-w-0 flex-1 truncate text-2xs text-muted/60">
                {branch.subject || branch.sha}
              </span>
              {branch.time ? (
                <span className="shrink-0 text-2xs text-muted/45">
                  {shortSha(branch.sha)} · {relativeTime(branch.time)}
                </span>
              ) : null}
              {branch.current ? <Icon name="check" size={11} className="shrink-0 text-accent" /> : null}
            </button>
          ))}

          {canCreate ? (
            <button
              data-active={index === shown.length}
              onMouseEnter={() => setIndex(shown.length)}
              onClick={runCreate}
              disabled={creating || busy !== null}
              className={`flex w-full items-center gap-2 px-3 py-[6px] text-left disabled:opacity-60 ${
                index === shown.length ? 'bg-active' : ''
              }`}
              title={t('branch.createTip', { name: createName })}
            >
              <Icon
                name={creating ? 'spinner' : 'plus'}
                size={13}
                className={`shrink-0 text-accent ${creating ? 'animate-spin' : ''}`}
              />
              <span className="min-w-0 flex-1 truncate text-sm text-accent">
                {t('branch.create', { name: createName })}
              </span>
              <span className="shrink-0 text-2xs text-muted/45">{t('branch.fromHead')}</span>
            </button>
          ) : null}

          {truncated ? (
            <div className="px-3 py-2 text-center text-2xs text-muted/50">
              {t('branch.truncated', { count: SEARCH_LIMIT })}
            </div>
          ) : null}
        </div>

        {!searched && all.length > recentItems.length ? (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="flex shrink-0 items-center justify-center gap-1.5 border-t border-line px-3 py-2 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            <Icon name={showAll ? 'chevron-down' : 'chevron-right'} size={11} />
            {showAll ? t('branch.showRecentOnly') : t('branch.showAll', { count: all.length })}
          </button>
        ) : null}
      </div>
    </div>
  )
}