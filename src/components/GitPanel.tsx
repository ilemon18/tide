import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useWorkspace } from '../store/workspace'
import { useGit } from '../store/git'
import { useTabs } from '../store/tabs'
import { useBlame } from '../store/blame'
import { Icon, type IconName } from './Icon'
import { FileIcon } from './FileIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import type { GitFile, GitStatus } from '../lib/ipc'
import { basename, dirname } from '../lib/paths'
import { beginFilePointerDrag, wasFileDragJustFinished } from '../lib/fileDragState'
import { useT, type MessageKey } from '../i18n'
import { budget } from '../lib/memoryBudget'

const STATUS_COLOR: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-danger',
  R: 'text-accent',
  C: 'text-accent',
  U: 'text-danger',
  '?': 'text-muted',
  T: 'text-warning',
}

/** Both letters of a conflict XY turn red; AA (added on both sides) uses the warning color */
function conflictColor(code: string): string {
  return code === 'AA' ? 'text-warning' : 'text-danger'
}

const OP_SUBMIT_LABEL: Record<string, MessageKey> = {
  merge: 'git.op.merge',
  'cherry-pick': 'git.op.cherryPick',
  revert: 'git.op.revert',
  rebase: 'git.op.rebase',
  am: 'git.op.am',
}

const COMMIT_MAX_H = 120

/** Commit message starts at one line, grows with content, scrolls internally past the cap */
function resizeCommitBox(el: HTMLTextAreaElement) {
  el.style.height = 'auto'
  const border = el.offsetHeight - el.clientHeight
  const full = el.scrollHeight + border
  el.style.height = `${Math.min(full, COMMIT_MAX_H)}px`
  el.style.overflowY = full > COMMIT_MAX_H ? 'auto' : 'hidden'
}

function StatusBadge({ status, conflict }: { status: string; conflict?: boolean }) {
  const t = useT()
  return (
    <span
      className={`shrink-0 text-center font-semibold ${
        conflict ? `w-5 ${conflictColor(status)}` : 'w-3'
      } text-xs ${conflict ? '' : (STATUS_COLOR[status] ?? 'text-muted')}`}
      title={conflict ? t('git.conflictStatus', { status }) : undefined}
    >
      {conflict ? status : status === '?' ? 'U' : status}
    </span>
  )
}

function ActionButton({
  icon,
  tip,
  onClick,
  disabled,
}: {
  icon: IconName
  tip: string
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void
  disabled?: boolean
}) {
  return (
    <button
      data-tip={tip}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

function RepoSection({ root, status }: { root: { id: string; name: string }; status: GitStatus | undefined }) {
  const t = useT()
  const busy = useGit((s) => s.busy)
  const refresh = useGit((s) => s.refresh)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const discard = useGit((s) => s.discard)
  const discardAllChanges = useGit((s) => s.discardAllChanges)
  const commit = useGit((s) => s.commit)
  const continueOperation = useGit((s) => s.continueOperation)
  const abortOperation = useGit((s) => s.abortOperation)
  const skipOperation = useGit((s) => s.skipOperation)
  const resetConflict = useGit((s) => s.resetConflict)
  const pull = useGit((s) => s.pull)
  const push = useGit((s) => s.push)
  const undoLastCommit = useGit((s) => s.undoLastCommit)
  const openDiff = useTabs((s) => s.openDiff)
  const openFile = useTabs((s) => s.openFile)
  const refreshFromDisk = useTabs((s) => s.refreshFromDisk)

  const [message, setMessage] = useState('')
  /** Last content auto-filled into the box: only overwrite while it still equals it */
  const autoFilled = useRef('')
  /** Whether the user has touched the box */
  const touched = useRef(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // The file open in the editor stays marked in the Git list too (VSCode does this in Source Control).
  // A diff tab points at the same rel, so both file and diff tabs highlight the row.
  const activeRel = useTabs((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeId)
    return tab && tab.root === root.id && (tab.kind === 'file' || tab.kind === 'diff')
      ? tab.rel
      : null
  })

  const operation = status?.operation ?? null
  const opKey = operation ? `${operation.kind}\u0000${status?.pendingMessage ?? ''}` : ''

  // A conflict operation is in progress: prefill the commit box with the message it expects.
  // Only write when the user has not touched it (empty or still the last auto value), so no refresh
  // overwrites what is being typed.
  useEffect(() => {
    if (!opKey) {
      if (!touched.current && message === autoFilled.current) setMessage('')
      autoFilled.current = ''
      touched.current = false
      return
    }
    const next = (status?.pendingMessage ?? '').trim()
    if (!next) return
    if (!touched.current && (message.length === 0 || message === autoFilled.current)) {
      autoFilled.current = next
      setMessage(next)
    }
    // message deliberately not a dep: a status refresh must not wipe what the user just typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opKey])

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (el) resizeCommitBox(el)
  }, [message])

  // Resizing the sidebar changes wrapping, so remeasure; react to width only to avoid loops with height
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    let width = el.clientWidth
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      resizeCommitBox(el)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }))

  /** After commit / undo the commit that inline blame points at is gone: clear the cache and refetch on demand */
  const refreshBlame = () => {
    const blame = useBlame.getState()
    blame.clear()
    for (const tab of useTabs.getState().tabs) {
      if (tab.root === root.id && tab.kind === 'file') blame.scheduleFetch(tab)
    }
  }

  const afterCommit = () => {
    setMessage('')
    autoFilled.current = ''
    touched.current = false
    refreshBlame()
  }

  const doCommit = () => {
    if (!status) return
    if (operation) {
      if (status.conflicts.length > 0) return
      void continueOperation(root.id, message).then((ok) => {
        if (ok) {
          afterCommit()
          void refreshFromDisk(root.id)
        }
      })
      return
    }
    if (!message.trim() || status.staged.length === 0) return
    void commit(root.id, message).then((ok) => {
      if (ok) afterCommit()
    })
  }

  const canSubmit = operation
    ? status?.conflicts.length === 0 && status.staged.length > 0 && busy === null
    : Boolean(status && message.trim() && status.staged.length > 0 && busy === null)

  const submitLabel = operation
    ? t(OP_SUBMIT_LABEL[operation.kind] ?? 'common.continue')
    : t('git.commit')

  /**
   * Row shortcut on the left of the stage / discard buttons: jump straight into the worktree file when the
   * diff is not what is needed. A file deleted from the worktree has nothing to open, so it gets none.
   */
  const openFileAction = (file: GitFile) =>
    file.status.includes('D')
      ? []
      : [
          {
            title: t('diff.openFile'),
            icon: 'pen' as IconName,
            run: () => void openFile(root.id, file.path),
          },
        ]

  const renderGroup = (
    key: string,
    title: string,
    files: GitFile[],
    actions: { label: string; icon: IconName; run: () => void; disabled?: boolean }[],
    onClickFile: (file: GitFile) => void,
    rowActions: (file: GitFile) => { icon: IconName; title: string; run: () => void }[],
    conflictGroup = false,
  ) => {
    if (files.length === 0) return null
    const isCollapsed = collapsed[key]
    return (
      <div>
        <div className="group flex items-center gap-1 px-2 py-[3px]">
          <button onClick={() => toggle(key)} className="flex min-w-0 flex-1 items-center gap-1 text-left">
            <Icon name={isCollapsed ? 'chevron-right' : 'chevron-down'} size={12} className="text-muted" />
            <span
              className={`truncate text-2xs font-semibold ${conflictGroup ? 'text-danger' : 'text-muted'}`}
            >
              {title}
            </span>
            <span className="ml-1 rounded-full bg-panel-alt px-1.5 text-2xs text-muted">{files.length}</span>
          </button>
          <div className="invisible flex items-center gap-0.5 group-hover:visible">
            {actions.map((action) => (
              <button
                key={action.label}
                data-tip={action.label}
                aria-label={action.label}
                disabled={action.disabled}
                onClick={action.run}
                className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon name={action.icon} size={12} />
              </button>
            ))}
          </div>
        </div>

        {!isCollapsed
          ? files.map((file) => (
              <div
                key={`${key}:${file.path}`}
                onPointerDown={(e) => {
                  if ((e.target as HTMLElement).closest('button')) return
                  beginFilePointerDrag(e, { root: root.id, rel: file.path })
                }}
                onClick={() => {
                  if (wasFileDragJustFinished()) return
                  onClickFile(file)
                }}
                data-active={activeRel === file.path}
                className={`group relative flex cursor-default items-center gap-1.5 py-[4px] pl-7 pr-2 text-sm text-fg/90 row-hover ${
                  activeRel === file.path ? 'git-file-row-active' : ''
                }`}
                title={file.path}
              >
                <FileIcon name={basename(file.path)} size={14} className="shrink-0" />
                {/* The name comes first and keeps priority: the directory only gets leftover room,
                    shrinks away far sooner, and what stays visible is its closest segments */}
                <span className="min-w-0 shrink truncate">{basename(file.path)}</span>
                {dirname(file.path) ? (
                  <span className="git-file-dir min-w-0 max-w-[60%] shrink-[999] text-2xs text-muted/70">
                    <span>{dirname(file.path)}</span>
                  </span>
                ) : null}
                {/* The status letter keeps its slot at the row end but fades on hover: action buttons cover it */}
                <span className="ml-auto shrink-0 transition-opacity group-hover:opacity-0">
                  <StatusBadge status={file.status} conflict={conflictGroup} />
                </span>
                {/* Actions float above the file name: no row width taken, long names can run to the edge */}
                <span className="row-actions-float invisible absolute inset-y-0 right-1.5 flex items-center gap-0.5 pl-5 group-hover:visible">
                  {rowActions(file).map((action) => (
                    <button
                      key={action.title}
                      data-tip={action.title}
                      onClick={(e) => {
                        e.stopPropagation()
                        action.run()
                      }}
                      className="flex h-[18px] w-[18px] items-center justify-center rounded-[4px] text-muted hover:bg-hover-strong hover:text-fg"
                    >
                      <Icon name={action.icon} size={12} />
                    </button>
                  ))}
                </span>
              </div>
            ))
          : null}
      </div>
    )
  }

  if (!status) {
    return (
      <div className="px-3 py-2 text-xs text-muted">
        <div className="mb-1 truncate font-semibold text-fg/80">{root.name}</div>
        {t('git.loading')}
      </div>
    )
  }

  const moreItems: MenuItem[] = [
    {
      label: t('git.undoLastCommit'),
      disabled: !status.head || Boolean(operation) || busy !== null,
      onClick: () => {
        void undoLastCommit(root.id).then((message) => {
          if (message === null) return
          // Put the last commit message back into the box so it can be edited and recommitted
          setMessage(message)
          autoFilled.current = message
          touched.current = false
          refreshBlame()
        })
      },
    },
  ]
  // Once every conflict is resolved the operation card disappears; keep skip / abort reachable here.
  if (operation && status.conflicts.length === 0) {
    moreItems.push(
      { type: 'separator' },
      {
        label: t('common.skip'),
        disabled: !operation.canSkip || busy !== null,
        onClick: () => {
          void skipOperation(root.id).then((ok) => {
            if (ok) void refreshFromDisk(root.id, { force: true })
          })
        },
      },
      {
        label: t('common.abort'),
        danger: true,
        disabled: busy !== null,
        onClick: () => {
          void abortOperation(root.id).then((ok) => {
            if (ok) {
              afterCommit()
              void refreshFromDisk(root.id, { force: true })
            }
          })
        },
      },
    )
  }

  return (
    <div>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Icon name="git" size={14} className="shrink-0 text-muted" />
        <span className="truncate text-xs font-semibold text-fg/85">{status.branch}</span>
        {status.ahead > 0 ? <span className="text-2xs text-muted">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="text-2xs text-muted">↓{status.behind}</span> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <ActionButton icon="arrow-down" tip="Pull" disabled={busy !== null} onClick={() => void pull(root.id)} />
          <ActionButton icon="arrow-up" tip="Push" disabled={busy !== null} onClick={() => void push(root.id)} />
          <ActionButton icon="refresh" tip={t('git.refreshTip')} onClick={() => void refresh(root.id, true)} />
          <ActionButton
            icon="more"
            tip={t('git.moreActions')}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setMenu({ x: rect.right - 190, y: rect.bottom + 4 })
            }}
          />
        </div>
      </div>

      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={moreItems}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {operation && status.conflicts.length > 0 ? (
        <div className="mx-2 mb-1.5 rounded-[5px] border border-warning/40 bg-warning/10 px-2 py-1.5">
          <div className="flex items-center gap-1.5 text-xs">
            <Icon name="git" size={12} className="shrink-0 text-warning" />
            <span className="truncate text-fg/90">{operation.label}</span>
            <span className="shrink-0 text-danger">
              {t('git.conflictsCount', { count: status.conflicts.length })}
            </span>
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <button
              disabled={status.conflicts.length > 0 || busy !== null}
              title={status.conflicts.length > 0 ? t('git.markResolvedFirst') : undefined}
              onClick={doCommit}
              className="rounded-[4px] border border-line px-2 py-[2px] text-2xs text-fg/90 hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.continue')}
            </button>
            {operation.canSkip ? (
              <button
                disabled={busy !== null}
                onClick={() => {
                  void skipOperation(root.id).then((ok) => {
                    if (ok) void refreshFromDisk(root.id, { force: true })
                  })
                }}
                className="rounded-[4px] border border-line px-2 py-[2px] text-2xs text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
              >
                {t('common.skip')}
              </button>
            ) : null}
            <button
              disabled={busy !== null}
              onClick={() => {
                void abortOperation(root.id).then((ok) => {
                  if (ok) {
                    afterCommit()
                    void refreshFromDisk(root.id, { force: true })
                  }
                })
              }}
              className="ml-auto rounded-[4px] px-2 py-[2px] text-2xs text-danger hover:bg-danger/15 disabled:opacity-40"
            >
              {t('common.abort')}
            </button>
          </div>
        </div>
      ) : null}

      <div className="px-2 pb-1.5">
        <textarea
          ref={textareaRef}
          value={message}
          onChange={(e) => {
            touched.current = true
            setMessage(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              doCommit()
            }
          }}
          placeholder={
            operation
              ? t('git.commitPlaceholderOp', { label: operation.label })
              : t('git.commitPlaceholder')
          }
          rows={1}
          spellCheck={false}
          className="w-full resize-none rounded-[4px] border border-line bg-bg px-2 py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <div className="mt-1.5 flex items-center gap-2">
          <button
            disabled={!canSubmit}
            onClick={doCommit}
            className="flex-1 rounded-[4px] bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'commit' || busy === 'continue' ? t('git.processing') : submitLabel}
          </button>
        </div>
      </div>

      {renderGroup(
        'conflicts',
        t('git.section.conflicts'),
        status.conflicts,
        // Deliberately no "mark all resolved": bulk git add before conflicts are handled would
        // mark files still containing <<<<<<< as resolved. Marking one by one matches VSCode.
        [],
        // Conflict files open the worktree file directly: the user's own edits stay visible and the
        // editor's "accept current / accept incoming / accept both" buttons keep working
        (file) => void openFile(root.id, file.path),
        (file) => [
          { title: t('git.markResolved'), icon: 'check', run: () => void stage(root.id, [file.path]) },
          {
            title: t('git.regenerateMarkers'),
            icon: 'undo',
            run: () => void resetConflict(root.id, file.path),
          },
        ],
        true,
      )}

      {renderGroup(
        'staged',
        t('git.section.staged'),
        status.staged,
        [{ label: t('git.unstageAll'), icon: 'minus', run: () => void unstage(root.id, status.staged.map((f) => f.path)) }],
        (file) => void openDiff(root.id, file.path, true),
        (file) => [
          ...openFileAction(file),
          { title: t('git.unstage'), icon: 'minus', run: () => void unstage(root.id, [file.path]) },
        ],
      )}

      {renderGroup(
        'changes',
        t('git.section.changes'),
        status.changes,
        [
          { label: t('git.stageAll'), icon: 'plus', run: () => void stage(root.id, status.changes.map((f) => f.path)) },
          {
            label: t('git.discardAllChanges'),
            icon: 'undo',
            disabled: busy !== null,
            run: () => void discardAllChanges(root.id),
          },
        ],
        (file) => void openDiff(root.id, file.path, false),
        (file) => [
          ...openFileAction(file),
          { title: t('git.stage'), icon: 'plus', run: () => void stage(root.id, [file.path]) },
          { title: t('git.discardChanges'), icon: 'undo', run: () => void discard(root.id, [file.path]) },
        ],
      )}

      {renderGroup(
        'untracked',
        t('git.section.untracked'),
        status.untracked,
        [{ label: t('git.stageAll'), icon: 'plus', run: () => void stage(root.id, status.untracked.map((f) => f.path)) }],
        (file) => void openDiff(root.id, file.path, false),
        (file) => [
          ...openFileAction(file),
          { title: t('git.stage'), icon: 'plus', run: () => void stage(root.id, [file.path]) },
          { title: t('git.deleteFile'), icon: 'trash', run: () => void discard(root.id, [file.path]) },
        ],
      )}
    </div>
  )
}

export function GitPanel() {
  const t = useT()
  const roots = useWorkspace((s) => s.roots)
  const statuses = useGit((s) => s.statuses)
  const refresh = useGit((s) => s.refresh)

  const gitRoots = roots.filter((r) => r.isGitRepo)
  // Probe non-repo projects too: after a git init in the terminal this must discover it by itself
  // (the watcher is the main path; the 10s poll below only covers missed events)
  const probeKey = roots.map((r) => `${r.id}:${r.isGitRepo}`).join('|')

  useEffect(() => {
    if (!probeKey) return
    void refresh()
    // File watching is the main sync path; keep only a fallback poll in case the watcher misses events
    // (longer in lightweight mode: every poll spawns a git subprocess)
    const timer = setInterval(() => {
      if (document.hasFocus()) void refresh()
    }, budget.gitPollInterval())
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probeKey])

  if (roots.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center text-sm text-muted">
        {t('git.openProjectFirst')}
      </div>
    )
  }

  if (gitRoots.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-5 text-center">
        <Icon name="git" size={26} className="text-muted/60" />
        <p className="text-sm text-muted">{t('git.notRepo')}</p>
        <p className="text-2xs text-muted/70">{t('git.gitInitHint')}</p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        {gitRoots.map((root) => (
          <RepoSection key={root.id} root={root} status={statuses[root.id]} />
        ))}
      </div>
    </div>
  )
}
