import { useShortcut } from '../lib/useShortcut'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useWorkspace } from '../store/workspace'
import { useGit } from '../store/git'
import { useTabs } from '../store/tabs'
import { useBlame } from '../store/blame'
import { useAgent } from '../store/agent'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { Icon, type IconName } from './Icon'
import { FileIcon } from './FileIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { GitCommitHistory } from './GitCommitHistory'
import { GitDialogs, type GitDialog } from './GitDialogs'
import { api, type DirEntryInfo, type GitFile } from '../lib/ipc'
import { basename, dirname } from '../lib/paths'
import { readWorkspaceEntry } from '../lib/workspaceEntries'
import { renameEntryFlow, revealEntry } from '../lib/actions'
import { copyText } from '../lib/clipboard'
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
  '?': 'text-success',
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
const FILE_ROW_H = 28
const FILE_ROW_OVERSCAN = 10

type RowAction = { icon: IconName; title: string; run: () => void; danger?: boolean; disabled?: boolean }
type RowActionFactory = (file: GitFile) => RowAction[]
type ClickFile = (file: GitFile) => void
type FileGroup = 'conflicts' | 'staged' | 'changes'
type OpenFileMenu = (file: GitFile, group: FileGroup, x: number, y: number) => void
type SelectFile = (file: GitFile, group: FileGroup, event: Pick<React.MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) => boolean
type FileSelection = { group: FileGroup | null; paths: string[]; anchor: string | null }
type GitScrollState = {
  scrollTop: number
  viewportHeight: number
  layoutVersion: number
  scrollerRef: React.RefObject<HTMLDivElement | null>
}

const GitScrollContext = createContext<GitScrollState | null>(null)

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
      {conflict ? status : status === '?' ? 'A' : status}
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
      aria-label={tip}
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-[5px] text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
    >
      <Icon name={icon} size={14} />
    </button>
  )
}

function StagingCheckbox({ checked, label, disabled = false, onChange }: {
  checked: boolean; label: string; disabled?: boolean; onChange: (checked: boolean) => void
}) {
  return <span className="relative flex h-[14px] w-[14px] shrink-0 items-center justify-center" onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
    <input type="checkbox" checked={checked} aria-checked={checked} aria-label={label} data-tip={label} disabled={disabled}
      onChange={event => { if (!disabled) onChange(event.target.checked) }} className="absolute inset-0 h-full w-full cursor-pointer appearance-none rounded-[3px] border border-line bg-bg outline-none checked:border-accent checked:bg-accent focus-visible:ring-1 focus-visible:ring-accent disabled:cursor-not-allowed disabled:opacity-40" />
    {checked ? <Icon name="check" size={10} className="pointer-events-none relative text-accent-fg" /> : null}
  </span>
}

type GitFileRowProps = {
  index: number
  file: GitFile
  active: boolean
  busy: boolean
  conflictGroup: boolean
  rootId: string
  rowActions: RowActionFactory
  onClickFile: ClickFile
  group: FileGroup
  onFileMenu: OpenFileMenu
  selected: boolean
  onSelectFile: SelectFile
  onToggleStaging: (file: GitFile, group: FileGroup) => void
}

/** A fixed-height row so only the visible slice needs to exist. Actions are created after hover/focus. */
const GitFileRow = memo(function GitFileRow({
  index,
  file,
  active,
  busy,
  conflictGroup,
  rootId,
  rowActions,
  onClickFile,
  group,
  onFileMenu,
  selected,
  onSelectFile,
  onToggleStaging,
}: GitFileRowProps) {
  const t = useT()
  const [actionsVisible, setActionsVisible] = useState(false)
  const hovered = useRef(false)
  const focused = useRef(false)

  const updateActions = () => setActionsVisible(hovered.current || focused.current)
  const openFile = (event: Pick<React.MouseEvent, 'shiftKey' | 'ctrlKey' | 'metaKey'>) => {
    if (wasFileDragJustFinished()) return
    if (!onSelectFile(file, group, event)) return
    onClickFile(file)
  }

  return (
    <div
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button,input') || event.shiftKey || event.ctrlKey || event.metaKey) return
        beginFilePointerDrag(event, { root: rootId, rel: file.path })
      }}
      onClick={event => { if (event.detail <= 1) openFile(event) }}
      onDoubleClick={event => {
        if ((event.target as HTMLElement).closest('button,input') || wasFileDragJustFinished()) return
        onFileMenu(file, group, event.clientX, event.clientY)
      }}
      onContextMenu={event => {
        event.preventDefault()
        if ((event.target as HTMLElement).closest('button,input')) return
        onFileMenu(file, group, event.clientX, event.clientY)
      }}
      onPointerEnter={() => {
        hovered.current = true
        updateActions()
      }}
      onPointerLeave={() => {
        hovered.current = false
        updateActions()
      }}
      onFocusCapture={() => {
        focused.current = true
        updateActions()
      }}
      onBlurCapture={(event) => {
        focused.current = event.currentTarget.contains(event.relatedTarget)
        updateActions()
      }}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          onFileMenu(file, group, rect.left, rect.bottom)
          return
        }
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        openFile(event)
      }}
      tabIndex={0}
      role="option"
      aria-selected={selected}
      data-active={active}
      className={`group absolute left-0 right-0 top-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden pl-7 pr-2 text-sm text-fg/90 row-hover ${
        selected ? 'git-file-row-selected' : active ? 'git-file-row-active' : ''
      }`}
      style={{ transform: `translateY(${index * FILE_ROW_H}px)` }}
      title={file.path}
    >
      <StagingCheckbox checked={group === 'staged'} label={t(group === 'staged' ? 'git.unstageFile' : 'git.stageFile', { path: file.path })} disabled={busy || file.path.endsWith('/')}
        onChange={() => onToggleStaging(file, group)} />
      <FileIcon name={basename(file.path)} size={14} className="shrink-0" />
      {/* The name comes first and keeps priority: the directory only gets leftover room,
          shrinks away far sooner, and what stays visible is its closest segments */}
      <span className={`min-w-0 shrink truncate ${!conflictGroup && (file.status === 'A' || file.status === '?') ? 'text-success' : !conflictGroup && file.status === 'D' ? 'text-danger line-through decoration-danger/60' : ''}`}>{basename(file.path)}</span>
      {dirname(file.path) ? (
        <span className="git-file-dir min-w-0 max-w-[60%] shrink-[999] text-2xs text-muted/70">
          <span>{dirname(file.path)}</span>
        </span>
      ) : null}
      {/* The status letter keeps its slot at the row end but fades on hover: action buttons cover it */}
      <span className="ml-auto shrink-0 transition-opacity group-hover:opacity-0">
        <StatusBadge status={file.status} conflict={conflictGroup} />
      </span>
      {actionsVisible ? (
        <span className="row-actions-float absolute inset-y-0 right-[2px] flex items-center self-center gap-0.5 pl-5">
          {rowActions(file).map((action) => (
            <button
              key={action.title}
              disabled={busy || action.disabled}
              data-tip={action.title}
              aria-label={action.title}
              onClick={(event) => {
                event.stopPropagation()
                action.run()
              }}
              className={`flex h-[18px] w-[18px] shrink-0 cursor-pointer self-center items-center justify-center rounded-[4px] text-muted hover:bg-hover-strong disabled:cursor-not-allowed disabled:opacity-40 ${action.danger ? 'hover:text-danger' : 'hover:text-fg'}`}
            >
              <Icon name={action.icon} size={12} />
            </button>
          ))}
        </span>
      ) : null}
    </div>
  )
})

type VirtualFileRowsProps = {
  rootId: string
  files: GitFile[]
  busy: boolean
  conflictGroup: boolean
  rowActions: RowActionFactory
  onClickFile: ClickFile
  group: FileGroup
  onFileMenu: OpenFileMenu
  selectedPaths: ReadonlySet<string>
  onSelectFile: SelectFile
  onToggleStaging: (file: GitFile, group: FileGroup) => void
  label: string
}

function VirtualFileRows({
  rootId,
  files,
  busy,
  conflictGroup,
  rowActions,
  onClickFile,
  group,
  onFileMenu,
  selectedPaths,
  onSelectFile,
  onToggleStaging,
  label,
}: VirtualFileRowsProps) {
  const scroll = useContext(GitScrollContext)
  const activeRel = useTabs((state) => {
    const active = state.tabs.find((tab) => tab.id === state.activeId)
    return active &&
      active.root === rootId &&
      (active.kind === 'file' || active.kind === 'diff')
      ? active.rel
      : null
  })
  const bodyRef = useRef<HTMLDivElement>(null)
  const bodyTop = useRef(0)
  const [range, setRange] = useState(() => ({
    start: 0,
    end: Math.min(files.length, FILE_ROW_OVERSCAN * 2),
  }))
  const scrollTop = scroll?.scrollTop ?? 0
  const viewportHeight = scroll?.viewportHeight ?? 0
  const layoutVersion = scroll?.layoutVersion ?? 0

  // The repository section above this list can grow/shrink (commit box, operation card). Cache the
  // body offset when that layout changes; scrolling then only needs the cheap slice arithmetic.
  useLayoutEffect(() => {
    const scroller = scroll?.scrollerRef.current
    const body = bodyRef.current
    if (!scroller || !body) return
    bodyTop.current =
      body.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  }, [files, layoutVersion, scroll?.scrollerRef, rootId])

  useLayoutEffect(() => {
    const viewTop = scrollTop
    const viewBottom = viewTop + viewportHeight
    const start = Math.max(
      0,
      Math.floor((viewTop - bodyTop.current) / FILE_ROW_H) - FILE_ROW_OVERSCAN,
    )
    const end = Math.min(
      files.length,
      Math.max(start, Math.ceil((viewBottom - bodyTop.current) / FILE_ROW_H) + FILE_ROW_OVERSCAN),
    )
    setRange((previous) =>
      previous.start === start && previous.end === end ? previous : { start, end },
    )
  }, [files.length, layoutVersion, scrollTop, viewportHeight])

  return (
    <div ref={bodyRef} role="listbox" aria-label={label} aria-multiselectable="true" className="relative" style={{ height: files.length * FILE_ROW_H }}>
      {files.slice(range.start, range.end).map((file, offset) => {
        const index = range.start + offset
        return (
          <GitFileRow
            key={file.path}
            index={index}
            file={file}
            active={activeRel === file.path}
            busy={busy}
            conflictGroup={conflictGroup}
            rootId={rootId}
            rowActions={rowActions}
            onClickFile={onClickFile}
            group={group}
            onFileMenu={onFileMenu}
            selected={selectedPaths.has(file.path)}
            onSelectFile={onSelectFile}
            onToggleStaging={onToggleStaging}
          />
        )
      })}
    </div>
  )
}

const RepoSection = memo(function RepoSection({
  root,
}: {
  root: { id: string; name: string }
}) {
  const t = useT()
  const status = useGit((s) => s.statuses[root.id])
  const busy = useGit((s) => s.busy)
  const refresh = useGit((s) => s.refresh)
  const stage = useGit((s) => s.stage)
  const unstage = useGit((s) => s.unstage)
  const discard = useGit((s) => s.discardFiles)
  const removeFiles = useGit((s) => s.removeFiles)
  const ignoreFiles = useGit((s) => s.ignoreFiles)
  const discardAllChanges = useGit((s) => s.discardAllChanges)
  const commit = useGit((s) => s.commit)
  const continueOperation = useGit((s) => s.continueOperation)
  const abortOperation = useGit((s) => s.abortOperation)
  const skipOperation = useGit((s) => s.skipOperation)
  const resetConflict = useGit((s) => s.resetConflict)
  const pull = useGit((s) => s.pull)
  const push = useGit((s) => s.push)
  const fetch = useGit((s) => s.fetch)
  const loadIdentity = useGit(s => s.loadIdentity)
  const identityInfo = useGit(s => s.identities[root.id])
  const temporaryIdentity = useGit(s => s.temporaryIdentity)
  const identity = temporaryIdentity ?? identityInfo?.effective
  const undoLastCommit = useGit((s) => s.undoLastCommit)
  const stashChanges = useGit((s) => s.stashChanges)
  const popStash = useGit((s) => s.popStash)
  const resetAll = useGit((s) => s.resetAll)
  const openDiff = useTabs((s) => s.openDiff)
  const openFile = useTabs((s) => s.openFile)
  const refreshFromDisk = useTabs((s) => s.refreshFromDisk)
  const agentKeys = useShortcut('agent.ask')
  const agentEnabled = useSettings(s => s.agentEnabled)

  const [message, setMessage] = useState('')
  const [amend, setAmend] = useState(false)
  const [skipHooks, setSkipHooks] = useState(false)
  const [commitMenu, setCommitMenu] = useState<{ x: number; y: number } | null>(null)
  const [historyMenu, setHistoryMenu] = useState<{ x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<GitDialog | null>(null)
  useEffect(() => { void loadIdentity(root.id) }, [loadIdentity, root.id])
  useEffect(() => {
    if (!amend || message.trim()) return
    let current = true
    void api.gitLastMessage(root.id).then(value => { if (current && !touched.current) setMessage(previous => previous.trim() ? previous : value) }).catch(() => {})
    return () => { current = false }
    // Auto-fill once on enabling Amend, preserving subsequent typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amend, root.id])
  /** Last content auto-filled into the box: only overwrite while it still equals it */
  const autoFilled = useRef('')
  /** Whether the user has touched the box */
  const touched = useRef(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** null = not asked yet; only read when the more-actions menu opens */
  const [stashCount, setStashCount] = useState<number | null>(null)
  const groups = useMemo<Record<FileGroup, GitFile[]>>(() => ({ conflicts: status?.conflicts ?? [], staged: status?.staged ?? [],
    changes: [...(status?.changes ?? []), ...(status?.untracked ?? [])] }), [status])
  const [selection, setSelection] = useState<FileSelection>({ group: null, paths: [], anchor: null })
  const onToggleStaging = useCallback((file: GitFile, group: FileGroup) => { if (group === 'staged') void unstage(root.id, [file.path]); else void stage(root.id, [file.path]) }, [root.id, stage, unstage])
  const selectedPaths = useMemo(() => new Set(selection.paths), [selection.paths])
  const [fileMenu, setFileMenu] = useState<{
    x: number; y: number; file: GitFile; files: GitFile[]; group: FileGroup; request: symbol; entry?: DirEntryInfo; loading: boolean; metadataFailed?: boolean
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const closeHistory = useCallback((restoreFocus = false) => { setHistoryMenu(null); if (restoreFocus) textareaRef.current?.focus() }, [])
  const pickHistory = useCallback((value: string) => { touched.current = true; autoFilled.current = ''; setMessage(value); setHistoryMenu(null); textareaRef.current?.focus() }, [])

  const onFileMenu = useCallback<OpenFileMenu>((file, group, x, y) => {
    setMenu(null)
    setCommitMenu(null)
    const paths = selection.group === group && selectedPaths.has(file.path) ? selectedPaths : new Set([file.path])
    if (paths !== selectedPaths) setSelection({ group, paths: [file.path], anchor: file.path })
    setFileMenu({ file, files: groups[group].filter(item => paths.has(item.path)), group, x, y, request: Symbol(), loading: true })
  }, [groups, selectedPaths, selection.group])
  const onSelectFile = useCallback<SelectFile>((file, group, event) => {
    const additive = event.ctrlKey || event.metaKey
    let paths = [file.path]
    let anchor = file.path
    if (event.shiftKey && selection.group === group && selection.anchor) {
      const files = groups[group]
      const from = files.findIndex(item => item.path === selection.anchor)
      const to = files.findIndex(item => item.path === file.path)
      if (from >= 0 && to >= 0) paths = files.slice(Math.min(from, to), Math.max(from, to) + 1).map(item => item.path)
      if (additive) paths = [...new Set([...selection.paths, ...paths])]
      anchor = selection.anchor
    } else if (additive && selection.group === group) {
      paths = selectedPaths.has(file.path) ? selection.paths.filter(path => path !== file.path) : [...selection.paths, file.path]
    }
    setSelection({ group, paths, anchor })
    return !event.shiftKey && !additive
  }, [groups, selection, selectedPaths])
  useEffect(() => {
    setSelection(previous => {
      if (!previous.group) return previous
      const valid = new Set(groups[previous.group].map(file => file.path))
      const paths = previous.paths.filter(path => valid.has(path))
      return paths.length === previous.paths.length ? previous : { ...previous, paths, anchor: previous.anchor && valid.has(previous.anchor) ? previous.anchor : null }
    })
  }, [groups])
  const menuPath = fileMenu?.file.path
  const menuRequest = fileMenu?.request
  useEffect(() => {
    if (!menuPath) return
    let current = true
    void readWorkspaceEntry(root.id, menuPath, () => current).then(entry => {
      if (current) setFileMenu(previous => previous && previous.request === menuRequest ? { ...previous, entry, loading: false } : previous)
    }).catch(() => {
      // Unreadable/missing metadata never enables actions that require a disk entry.
      if (current) setFileMenu(previous => previous && previous.request === menuRequest ? { ...previous, loading: false, metadataFailed: true } : previous)
    })
    return () => { current = false }
  }, [root.id, menuPath, menuRequest])

  useEffect(() => {
    if (!fileMenu || !status) return
    const files = fileMenu.group === 'conflicts' ? status.conflicts : fileMenu.group === 'staged'
      ? status.staged : [...status.changes, ...status.untracked]
    if (fileMenu.files.some(target => !files.some(file => file.path === target.path && file.status === target.status))) setFileMenu(null)
  }, [status, fileMenu])

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
    setAmend(false); setSkipHooks(false)
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
    if (!message.trim() || (status.staged.length === 0 && !(amend && status.head))) return
    void commit(root.id, message, { amend, skipHooks }).then((ok) => {
      if (ok) afterCommit()
    })
  }

  const canSubmit = operation
    ? status?.conflicts.length === 0 && status.staged.length > 0 && busy === null
    : Boolean(status && message.trim() && (status.staged.length > 0 || (amend && status.head)) && busy === null)

  const submitLabel = operation
    ? t(OP_SUBMIT_LABEL[operation.kind] ?? 'common.continue')
    : t(amend ? 'git.amendCommit' : 'git.commit')

  /**
   * Row shortcut on the left of the stage / discard buttons: jump straight into the worktree file when the
   * diff is not what is needed. A file deleted from the worktree has nothing to open, so it gets none.
   */
  const openFileAction = useCallback(
    (file: GitFile): RowAction[] =>
      file.status.includes('D')
        ? []
        : [
            {
              title: t('diff.openFile'),
              icon: 'pen',
              run: () => void openFile(root.id, file.path),
            },
          ],
    [openFile, root.id, t],
  )

  const onClickConflictFile = useCallback(
    (file: GitFile) => void openFile(root.id, file.path),
    [openFile, root.id],
  )
  const onClickStagedFile = useCallback(
    (file: GitFile) => void openDiff(root.id, file.path, true),
    [openDiff, root.id],
  )
  const onClickChangedFile = useCallback(
    (file: GitFile) => void openDiff(root.id, file.path, false),
    [openDiff, root.id],
  )

  const conflictRowActions = useCallback(
    (file: GitFile): RowAction[] => [
      { title: t('git.markResolved'), icon: 'check', run: () => void stage(root.id, [file.path]) },
      {
        title: t('git.regenerateMarkers'),
        icon: 'undo',
        run: () => void resetConflict(root.id, file.path),
      },
      { title: t('git.deleteFile'), icon: 'trash', danger: true, disabled: file.status.includes('D'), run: () => void removeFiles(root.id, [file.path]) },
    ],
    [resetConflict, root.id, stage, t, removeFiles],
  )
  const stagedRowActions = useCallback(
    (file: GitFile): RowAction[] => [
      ...openFileAction(file),
      { title: t('git.unstage'), icon: 'minus', run: () => void unstage(root.id, [file.path]) },
      { title: t('git.deleteFile'), icon: 'trash', danger: true, disabled: file.status === 'D', run: () => void removeFiles(root.id, [file.path]) },
    ],
    [openFileAction, root.id, t, unstage, removeFiles],
  )
  const changedRowActions = useCallback(
    (file: GitFile): RowAction[] => [
      ...openFileAction(file),
      { title: t('git.stage'), icon: 'plus', run: () => void stage(root.id, [file.path]) },
      ...(file.status === '?' ? [] : [{ title: t('git.discardChanges'), icon: 'undo' as const, danger: true, run: () => void discard(root.id, [file.path]) }]),
      { title: t('git.deleteFile'), icon: 'trash', danger: true, disabled: file.status === 'D', run: () => void removeFiles(root.id, [file.path]) },
    ],
    [discard, openFileAction, root.id, stage, t, removeFiles],
  )

  const renderGroup = (
    key: FileGroup,
    title: string,
    files: GitFile[],
    actions: { label: string; icon: IconName; run: () => void; disabled?: boolean; danger?: boolean }[],
    onClickFile: ClickFile,
    rowActions: RowActionFactory,
    conflictGroup = false,
  ) => {
    if (files.length === 0) return null
    const isCollapsed = collapsed[key]
    return (
      <div>
        <div className="group flex items-center gap-1.5 px-2 py-[3px]">
          <StagingCheckbox label={t(key === 'staged' ? 'git.unstageAll' : key === 'conflicts' ? 'git.markResolvedFirst' : 'git.stageAll')}
            checked={key === 'staged'} disabled={busy !== null || key === 'conflicts' || files.every(file => file.path.endsWith('/'))}
            onChange={() => { const paths = files.filter(file => !file.path.endsWith('/')).map(file => file.path); if (key === 'staged') void unstage(root.id, paths); else void stage(root.id, paths) }} />
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
                disabled={busy !== null || action.disabled}
                onClick={action.run}
                className={`flex h-[18px] w-[18px] shrink-0 cursor-pointer self-center items-center justify-center rounded-[4px] disabled:cursor-not-allowed disabled:opacity-40 ${action.danger ? 'text-danger hover:bg-danger/15' : 'text-muted hover:bg-hover hover:text-fg'}`}
              >
                <Icon name={action.icon} size={action.danger ? 14 : 12} />
              </button>
            ))}
          </div>
        </div>

        {!isCollapsed ? (
          <VirtualFileRows
            rootId={root.id}
            files={files}
            busy={busy !== null}
            conflictGroup={conflictGroup}
            rowActions={rowActions}
            onClickFile={onClickFile}
            group={key}
            onFileMenu={onFileMenu}
            selectedPaths={selection.group === key ? selectedPaths : new Set()}
            onSelectFile={onSelectFile}
            onToggleStaging={onToggleStaging}
            label={title}
          />
        ) : null}
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

  const changes = groups.changes

  const fileItems: MenuItem[] = []
  if (fileMenu) {
    const { file, files, group, entry, loading } = fileMenu
    const multiple = files.length > 1
    const paths = files.map(item => item.path)
    const removable = files.filter(item => item.status !== 'D' || (!multiple && Boolean(entry && !entry.isDir))).map(item => item.path)
    const ignored = files.filter(item => item.status === '?' && !item.path.endsWith('/')).map(item => item.path)
    const regularFile = entry && !entry.isDir && !entry.isSymlink
    const gitFile = !file.path.endsWith('/') && !entry?.isDir
    const mutationDisabled = busy !== null || loading || fileMenu.metadataFailed || files.some(item => item.path.endsWith('/'))
    if (!multiple && group !== 'conflicts' && gitFile && !entry?.isSymlink) fileItems.push({
      label: t('git.openChanges'), disabled: loading || fileMenu.metadataFailed,
      onClick: () => void openDiff(root.id, file.path, group === 'staged'),
    })
    if (!multiple && regularFile) fileItems.push({ label: t('diff.openFile'), onClick: () => void openFile(root.id, file.path) })
    if (gitFile) {
      if (fileItems.length) fileItems.push({ type: 'separator' })
      if (group === 'conflicts') {
        if (!multiple) fileItems.push({ label: t('git.markResolved'), disabled: mutationDisabled, onClick: () => void stage(root.id, paths) })
        if (!multiple && regularFile) fileItems.push({ label: t('git.regenerateMarkers'), disabled: mutationDisabled, onClick: () => void resetConflict(root.id, file.path) })
      } else if (group === 'staged') {
        fileItems.push({ label: t('git.unstage'), disabled: mutationDisabled, onClick: () => void unstage(root.id, paths) })
      } else {
        fileItems.push({ label: t('git.stage'), disabled: mutationDisabled, onClick: () => void stage(root.id, paths) })
        if (!entry?.isSymlink) fileItems.push({
          label: t('git.discardChanges'), danger: true,
          disabled: mutationDisabled, onClick: () => void discard(root.id, paths),
        })
      }
      fileItems.push({ label: t('git.ignoreFiles'), description: t('git.ignoreFilesHint'),
        disabled: mutationDisabled || !ignored.length, onClick: () => void ignoreFiles(root.id, ignored) })
      if (multiple || entry) fileItems.push({ label: multiple ? t('git.removeFiles') : t('git.deleteFile'), danger: true,
        disabled: mutationDisabled || !removable.length, onClick: () => void removeFiles(root.id, removable) })
    }
    if (!multiple && entry && !entry.isDir) {
      if (fileItems.length) fileItems.push({ type: 'separator' })
      if (agentEnabled && regularFile) fileItems.push({
        label: agentKeys ? t('titlebar.agentTip', { shortcut: agentKeys }) : t('commands.agent.ask'),
        onClick: () => { useAgent.getState().newChat(root.id, [{ rel: file.path, isDir: false }]) },
      })
      fileItems.push(
        { label: t('explorer.rename'), disabled: mutationDisabled, onClick: () => void renameEntryFlow(root.id, file.path) },
        { label: t('explorer.revealInFinder'), onClick: () => void revealEntry(root.id, file.path) },
      )
    }
    if (fileItems.length) fileItems.push({ type: 'separator' })
    fileItems.push(
      { label: t('explorer.copyRelativePath'), disabled: multiple, onClick: () => void copyText(paths.join('\n'), t('explorer.copyRelativePath')) },
      { label: t('explorer.copyAbsolutePath'), disabled: multiple, onClick: () => void copyText(paths.map(path => `${root.id}/${path}`).join('\n'), t('explorer.copyAbsolutePath')) },
      { label: t('explorer.copyName'), disabled: multiple, onClick: () => void copyText(paths.map(path => basename(path.replace(/\/+$/, ''))).join('\n'), t('explorer.copyName')) },
    )
  }

  const trackedChanges = status.staged.length + status.changes.length
  const moreItems: MenuItem[] = [
    { label: t('git.createBranch'), disabled: busy !== null || Boolean(operation) || !status.head,
      onClick: () => setDialog({ kind: 'create', root: root.id, current: status.branch }) },
    { label: t('git.forcePush'), danger: true, disabled: busy !== null || Boolean(operation) || !status.head,
      onClick: () => setDialog({ kind: 'forcePush', root: root.id, current: status.branch }) },
    { type: 'separator' },
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
    { type: 'separator' },
    {
      label: t('git.stashChanges'),
      disabled: busy !== null || Boolean(operation) || trackedChanges === 0,
        onClick: () => setDialog({ kind: 'stash', root: root.id, current: status.branch }),
    },
    {
      label: stashCount && stashCount > 0
        ? t('git.popStashCount', { count: stashCount })
        : t('git.popStash'),
      disabled: busy !== null || Boolean(operation) || stashCount === 0,
      onClick: () => setDialog({ kind: 'popStash', root: root.id, current: status.branch }),
    },
    { label: t('git.clearStash'), danger: true, disabled: busy !== null || stashCount === null || stashCount === 0,
      onClick: () => setDialog({ kind: 'clearStash', root: root.id, current: status.branch }) },
    { type: 'separator' },
    {
      label: t('git.resetAll'),
      danger: true,
      disabled: busy !== null || Boolean(operation) || !status.head || trackedChanges === 0,
      onClick: () => void resetAll(root.id),
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
      {historyMenu ? <GitCommitHistory root={root.id} {...historyMenu} onClose={closeHistory} onPick={pickHistory} /> : null}
      {dialog ? <GitDialogs key={`${dialog.kind}:${dialog.root}`} dialog={dialog} onClose={() => setDialog(null)} /> : null}
      {commitMenu ? <ContextMenu x={commitMenu.x} y={commitMenu.y} onClose={() => setCommitMenu(null)} items={[
        { label: t('git.amendOption'), checked: amend, keepOpen: true, disabled: busy !== null || Boolean(operation) || !status.head, onClick: () => setAmend(!amend) },
        { label: t('git.skipHooksOption'), description: t('git.skipHooksHint'), checked: skipHooks, keepOpen: true, danger: true, disabled: busy !== null || Boolean(operation), onClick: () => setSkipHooks(!skipHooks) },
      ]} /> : null}
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <button type="button" aria-label={status.branch} title={status.branch} data-tip={status.branch}
          aria-haspopup="dialog" disabled={busy !== null || !status.head}
          onClick={() => useUi.getState().openBranchMenu({ root: root.id, localOnly: true })}
          className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded text-left text-xs font-semibold text-fg/85 hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
          <Icon name="git" size={14} className="shrink-0 text-muted" />
          <span className="min-w-0 truncate">{status.branch}</span>
        </button>
        {status.ahead > 0 ? <span className="text-2xs text-muted">↑{status.ahead}</span> : null}
        {status.behind > 0 ? <span className="text-2xs text-muted">↓{status.behind}</span> : null}
        <div className="ml-auto flex items-center gap-0.5">
          <ActionButton icon="arrow-down" tip="Pull" disabled={busy !== null} onClick={() => void pull(root.id)} />
          <ActionButton icon="arrow-up" tip="Push" disabled={busy !== null} onClick={() => void push(root.id)} />
          <ActionButton icon="download" tip={t('git.fetchAllTip')} disabled={busy !== null} onClick={() => void fetch(root.id)} />
          <ActionButton icon="refresh" tip={t('git.refreshTip')} onClick={() => void refresh(root.id, true)} />
          <ActionButton
            icon="more"
            tip={t('git.moreActions')}
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect()
              setFileMenu(null)
              setCommitMenu(null)
              setStashCount(null)
              void api.gitStashCount(root.id).then(setStashCount).catch(() => setStashCount(null))
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

      {fileMenu ? (
        <ContextMenu x={fileMenu.x} y={fileMenu.y} items={fileItems}
          maxHeight={Math.max(0, Math.min(420, window.innerHeight - 16))} onClose={() => setFileMenu(null)} />
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
        <div className="relative">
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
          className="block w-full resize-none rounded-[4px] border border-line bg-bg pl-2 pr-[60px] py-1.5 text-sm outline-none placeholder:text-muted/60 focus:border-accent"
        />
        <div className="absolute right-1 top-1 flex items-center gap-0.5">
        <button type="button" aria-label={t('git.commitHistory')} data-tip={t('git.commitHistory')} aria-haspopup="dialog" aria-expanded={Boolean(historyMenu)} disabled={busy !== null}
          onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(null); setCommitMenu(null); setFileMenu(null); setHistoryMenu(previous => previous ? null : { x: rect.right, y: rect.bottom + 6 }) }}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"><Icon name="clock" size={13} /></button>
        <button type="button" aria-label={t('git.clearCommitMessage')} data-tip={t('git.clearCommitMessage')} disabled={!message.length || busy !== null}
          onClick={() => { touched.current = true; autoFilled.current = ''; setHistoryMenu(null); setMessage(''); textareaRef.current?.focus() }}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"><Icon name="close" size={12} /></button>
        </div>
        </div>
        <button type="button" aria-label={t('git.commitIdentity')} disabled={busy !== null} onClick={() => { setCommitMenu(null); setMenu(null); setFileMenu(null); setHistoryMenu(null); setDialog({ kind: 'identity', root: root.id }) }}
          title={identity?.name ? `${identity.name} (${identity.email})${temporaryIdentity ? '\n' + t('git.temporaryIdentityHint') : ''}` : t('git.identityUnset')}
          className="relative mt-1.5 flex w-full min-w-0 cursor-pointer items-center justify-start rounded pl-1 pr-5 py-1 text-left text-2xs text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40">
          <span className="flex min-w-0 flex-1 items-center gap-1">
            <Icon name="user" size={11} className="shrink-0" /><span className="min-w-0 truncate">{identity?.name ? `${identity.name} (${identity.email})` : t('git.identityUnset')}</span>
            {temporaryIdentity ? <span className="shrink-0 text-accent">{t('git.temporaryIdentity')}</span> : null}
          </span>
          <Icon name="chevron-down" size={10} className="absolute right-1 shrink-0" />
        </button>
        {skipHooks ? <p className="mb-1 truncate px-1 text-2xs text-warning" title={t('git.skipHooksHint')}>{t('git.skipHooksOption')}</p> : null}
        <div className="mt-1 flex items-stretch gap-px overflow-hidden rounded-[4px] bg-accent/60">
          <button
            disabled={!canSubmit}
            onClick={doCommit}
            className="min-w-0 flex-1 cursor-pointer bg-accent px-2 py-1 text-xs font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === 'commit' || busy === 'continue' ? t('git.processing') : submitLabel}
          </button>
          <button type="button" aria-label={t('git.commitOptions')} data-tip={t('git.commitOptions')} disabled={busy !== null || Boolean(operation)}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); setMenu(null); setFileMenu(null); setCommitMenu({ x: rect.right - 200, y: rect.bottom + 4 }) }}
            className="flex w-7 shrink-0 cursor-pointer items-center justify-center bg-accent text-accent-fg hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"><Icon name="chevron-down" size={12} /></button>
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
        onClickConflictFile,
        conflictRowActions,
        true,
      )}

      {renderGroup(
        'staged',
        t('git.section.staged'),
        status.staged,
        [{ label: t('git.unstageAll'), icon: 'minus', run: () => void unstage(root.id, status.staged.map((f) => f.path)) }],
        onClickStagedFile,
        stagedRowActions,
      )}

      {renderGroup(
        'changes',
        t('git.section.changes'),
        changes,
        [
          { label: t('git.stageAll'), icon: 'plus', run: () => void stage(root.id, changes.map((f) => f.path)) },
          {
            label: t('git.discardAllChanges'),
            icon: 'trash',
            danger: true,
            disabled: busy !== null,
            run: () => void discardAllChanges(root.id),
          },
        ],
        onClickChangedFile,
        changedRowActions,
      )}
    </div>
  )
})

export function GitPanel() {
  const t = useT()
  const roots = useWorkspace((s) => s.roots)
  const refresh = useGit((s) => s.refresh)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ scrollTop: 0, viewportHeight: 0 })
  const [layoutVersion, setLayoutVersion] = useState(0)

  const gitRoots = roots.filter((r) => r.isGitRepo)
  // Probe non-repo projects too: after a git init in the terminal this must discover it by itself
  // (the watcher is the main path; the 10s poll below only covers missed events)
  const probeKey = roots.map((r) => `${r.id}:${r.isGitRepo}`).join('|')

  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      setScroll((previous) =>
        previous.scrollTop === 0 && previous.viewportHeight === 0
          ? previous
          : { scrollTop: 0, viewportHeight: 0 },
      )
      return
    }
    let frame = 0
    let contentHeight = contentRef.current?.clientHeight ?? 0
    const update = () => {
      frame = 0
      const next = { scrollTop: scroller.scrollTop, viewportHeight: scroller.clientHeight }
      setScroll((previous) =>
        previous.scrollTop === next.scrollTop && previous.viewportHeight === next.viewportHeight
          ? previous
          : next,
      )
    }
    const measureContent = () => {
      const content = contentRef.current
      if (!content) return
      const height = content.clientHeight
      if (height === contentHeight) return
      contentHeight = height
      setLayoutVersion((version) => version + 1)
    }
    const schedule = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          measureContent()
          update()
        })
      }
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(scroller)
    if (contentRef.current) observer.observe(contentRef.current)
    scroller.addEventListener('scroll', schedule, { passive: true })
    update()
    return () => {
      observer.disconnect()
      scroller.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [gitRoots.length])

  const scrollValue = useMemo<GitScrollState>(
    () => ({ ...scroll, layoutVersion, scrollerRef }),
    [layoutVersion, scroll],
  )

  useEffect(() => {
    if (!probeKey) return
    void refresh(undefined, true)
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
    <GitScrollContext.Provider value={scrollValue}>
      <div className="flex h-full min-h-0 flex-col">
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
          <div ref={contentRef}>
            {gitRoots.map((root) => (
              <RepoSection key={root.id} root={root} />
            ))}
          </div>
        </div>
      </div>
    </GitScrollContext.Provider>
  )
}
