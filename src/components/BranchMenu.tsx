import { useEffect, useMemo, useRef, useState } from 'react'
import { useGit } from '../store/git'
import { useUi } from '../store/ui'
import { checkoutBranch, createBranch, fetchRemote } from '../lib/actions'
import { relativeTime, shortSha } from '../lib/format'
import { Icon } from './Icon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { GitDialogs, type GitDialog } from './GitDialogs'
import type { GitBranch } from '../lib/ipc'
import { useT } from '../i18n'

/** Default limit per group; search always uses the complete cached branch list. */
const RECENT_LIMIT = 10
const SEARCH_LIMIT = 200

/** Current branch -> local branches (newest commit first) -> remote branches (newest commit first) */
export function sortBranches(list: GitBranch[]): GitBranch[] {
  return [...list].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1
    if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1
    return b.time - a.time
  })
}

export function selectRecentBranches(all: GitBranch[], limit = RECENT_LIMIT): GitBranch[] {
  return (['local', 'remote'] as const).flatMap((kind) => {
    const branches = all.filter((branch) => branch.kind === kind)
    // Pin the current local branch before limiting, even when its commit is old.
    const sorted = kind === 'local' ? sortBranches(branches) : branches.sort((a, b) => b.time - a.time)
    return sorted.slice(0, limit)
  })
}

export function searchBranches(all: GitBranch[], query: string): GitBranch[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const rank = (branch: GitBranch) => {
    const name = branch.name.toLowerCase()
    if (name === q) return 0
    if (name.startsWith(q) || name.split('/').pop() === q) return 1
    if (name.includes(`/${q}`)) return 2
    return 3
  }
  return all
    .filter((branch) => branch.name.toLowerCase().includes(q))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'local' ? -1 : 1
      return rank(a) - rank(b)
    })
}

export function branchesForMenu(branches: GitBranch[], localOnly = false): GitBranch[] {
  return sortBranches(localOnly ? branches.filter(branch => branch.kind === 'local') : branches)
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
  const [creating, setCreating] = useState(false)
  const [context, setContext] = useState<{ x: number; y: number; branch: GitBranch } | null>(null)
  const [dialog, setDialog] = useState<GitDialog | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const root = menu?.root ?? null

  useEffect(() => {
    if (!menu) return
    setContext(null); setDialog(null)
    setQuery('')
    setIndex(0)
    void useGit.getState().loadBranches(menu.root)
  }, [menu])

  const all = useMemo(() => (data ? branchesForMenu(data.branches, menu?.localOnly) : []), [data, menu?.localOnly])

  const recentItems = useMemo(() => selectRecentBranches(all), [all])

  const searched = useMemo(() => {
    if (!query.trim()) return null
    return searchBranches(all, query)
  }, [all, query])

  const shown = useMemo(
    () => (searched ? searched.slice(0, SEARCH_LIMIT) : recentItems),
    [searched, recentItems],
  )
  const groups = useMemo(() => {
    const local = shown.filter((branch) => branch.kind === 'local')
    const remote = shown.filter((branch) => branch.kind === 'remote')
    return [
      { kind: 'local' as const, items: local, offset: 0 },
      { kind: 'remote' as const, items: remote, offset: local.length },
    ]
  }, [shown])
  const truncated = searched ? searched.length > SEARCH_LIMIT : false

  // Allow creating a typed name that does not already exist, after all results.
  const createName = query.trim()
  const canCreate =
    !!searched && createName !== '' && !all.some((b) => b.name === createName)
  const total = shown.length + (canCreate ? 1 : 0)

  useEffect(() => setIndex(0), [query])

  // When the result count shrinks (list refreshed, create row gone) pull the highlight back in range
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, total - 1)))
  }, [total])

  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [index, shown, canCreate])

  if (!menu || !root) return null

  const pick = (branch: GitBranch) => {
    if (busy !== null) return
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

  const branchItems = (branch: GitBranch): MenuItem[] => {
    const disabled = busy !== null
    const form = (kind: 'rename' | 'delete' | 'merge' | 'rebase', force = false) => setDialog({ kind, root, current: data?.current ?? '', branch, force })
    return [
      { label: t('git.checkoutBranch'), disabled: disabled || branch.current, onClick: () => pick(branch) },
      { label: t('git.fetchBranch'), disabled, onClick: () => void useGit.getState().fetchBranch(root, { name: branch.name, kind: branch.kind }) },
      { label: t('git.renameBranch'), disabled, onClick: () => form('rename') },
      { type: 'separator' },
      { label: t('git.mergeBranch'), disabled: disabled || branch.current || Boolean(data?.detached), onClick: () => form('merge') },
      { label: t('git.rebaseBranch'), disabled: disabled || branch.current || Boolean(data?.detached), onClick: () => form('rebase') },
      { type: 'separator' },
      { label: t('git.deleteBranch'), danger: true, disabled: disabled || branch.current, onClick: () => form('delete') },
      ...(branch.kind === 'local' ? [{ label: t('git.forceDeleteBranch'), danger: true, disabled: disabled || branch.current, onClick: () => form('delete', true) }] : []),
    ]
  }
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4"
      onMouseDown={() => { if (!dialog && !context && busy === null) close() }}
    >
      <div
        role="dialog"
        data-shortcut-dialog
        aria-label={t('branch.searchPlaceholder')}
        className="flex h-[480px] max-h-[calc(100dvh-32px)] w-[560px] max-w-[92vw] flex-col overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
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
                setIndex((i) => Math.max(0, Math.min(total - 1, i + 1)))
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
            className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
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

        <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden py-1">
          {loading && !data ? (
            <div className="px-3 py-8 text-center text-sm text-muted">{t('branch.loading')}</div>
          ) : null}

          {shown.length === 0 && data && !canCreate ? (
            <div className="px-3 py-8 text-center text-sm text-muted">
              {searched ? t('branch.noMatch') : t('branch.empty')}
            </div>
          ) : null}

          {groups.map((group) => group.items.length > 0 ? (
            // Group headings are visual only and are excluded from the keyboard index.
            <section key={group.kind} aria-label={t(group.kind === 'local' ? 'branch.local' : 'branch.remote')}>
              <h3 className="px-3 pb-1 pt-2 text-2xs font-medium text-muted">
                {t(group.kind === 'local' ? 'branch.local' : 'branch.remote')}
              </h3>
              {group.items.map((branch, groupIndex) => {
                const i = group.offset + groupIndex
                return (
            <button
              key={`${branch.kind}:${branch.name}`}
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={() => pick(branch)}
              onContextMenu={event => { event.preventDefault(); setContext({ x: event.clientX, y: event.clientY, branch }) }}
              className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left ${
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
                )
              })}
            </section>
          ) : null)}

          {canCreate ? (
            <button
              data-active={index === shown.length}
              onMouseEnter={() => setIndex(shown.length)}
              onClick={runCreate}
              disabled={creating || busy !== null}
              className={`flex w-full items-center gap-2 whitespace-nowrap px-3 py-[6px] text-left disabled:opacity-60 ${
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

      </div>
      {context ? <ContextMenu {...context} items={branchItems(context.branch)} onClose={() => setContext(null)} /> : null}
      {dialog ? <GitDialogs key={`${dialog.kind}:${'branch' in dialog ? dialog.branch.name : ''}`} dialog={dialog} onClose={() => setDialog(null)} /> : null}
    </div>
  )
}
