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
import { useSettings } from '../store/settings'
import { Icon, type IconName } from './Icon'
import { FileIcon } from './FileIcon'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { api, type DirEntryInfo, type GitFile } from '../lib/ipc'
import { basename, dirname } from '../lib/paths'
import { readWorkspaceEntry } from '../lib/workspaceEntries'
import { deleteEntryFlow, renameEntryFlow, revealEntry } from '../lib/actions'
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

type RowAction = { icon: IconName; title: string; run: () => void }
type RowActionFactory = (file: GitFile) => RowAction[]
type ClickFile = (file: GitFile) => void
type FileGroup = 'conflicts' | 'staged' | 'changes'
type OpenFileMenu = (file: GitFile, group: FileGroup, x: number, y: number) => void
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
      disabled={disabled}
      onClick={onClick}
      className="flex h-6 w-6 items-center justify-center rounded-[5px] text-muted hover:bg-hover hover:text-fg disabled:opacity-40"
    >
      <Icon name={icon} size={14} />
    </button>
  )
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
}: GitFileRowProps) {
  const [actionsVisible, setActionsVisible] = useState(false)
  const hovered = useRef(false)
  const focused = useRef(false)

  const updateActions = () => setActionsVisible(hovered.current || focused.current)
  const openFile = () => {
    if (wasFileDragJustFinished()) return
    onClickFile(file)
  }

  return (
    <div
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return
        beginFilePointerDrag(event, { root: rootId, rel: file.path })
      }}
      onClick={event => { if (event.detail <= 1) openFile() }}
      onDoubleClick={event => {
        if ((event.target as HTMLElement).closest('button') || wasFileDragJustFinished()) return
        onFileMenu(file, group, event.clientX, event.clientY)
      }}
      onContextMenu={event => {
        event.preventDefault()
        if ((event.target as HTMLElement).closest('button')) return
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
        openFile()
      }}
      tabIndex={0}
      data-active={active}
      className={`group absolute left-0 right-0 top-0 flex h-7 cursor-pointer items-center gap-1.5 overflow-hidden pl-7 pr-2 text-sm text-fg/90 row-hover ${
        active ? 'git-file-row-active' : ''
      }`}
      style={{ transform: `translateY(${index * FILE_ROW_H}px)` }}
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
      {actionsVisible ? (
        <span className="row-actions-float absolute inset-y-0 right-[2px] flex items-center self-center gap-0.5 pl-5">
          {rowActions(file).map((action) => (
            <button
              key={action.title}
              disabled={busy}
              data-tip={action.title}
              aria-label={action.title}
              onClick={(event) => {
                event.stopPropagation()
                action.run()
              }}
              className="flex h-[18px] w-[18px] shrink-0 self-center items-center justify-center rounded-[4px] text-muted hover:bg-hover-strong hover:text-fg"
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
    <div ref={bodyRef} className="relative" style={{ height: files.length * FILE_ROW_H }}>
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
  const stashChanges = useGit((s) => s.stashChanges)
  const popStash = useGit((s) => s.popStash)
  const resetAll = useGit((s) => s.resetAll)
  const openDiff = useTabs((s) => s.openDiff)
  const openFile = useTabs((s) => s.openFile)
  const refreshFromDisk = useTabs((s) => s.refreshFromDisk)
  const agentKeys = useShortcut('agent.ask')
  const agentEnabled = useSettings(s => s.agentEnabled)

  const [message, setMessage] = useState('')
  /** Last content auto-filled into the box: only overwrite while it still equals it */
  const autoFilled = useRef('')
  /** Whether the user has touched the box */
  const touched = useRef(false)
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  /** null = not asked yet; only read when the more-actions menu opens */
  const [stashCount, setStashCount] = useState<number | null>(null)
  const [fileMenu, setFileMenu] = useState<{
    x: number; y: number; file: GitFile; group: FileGroup; request: symbol; entry?: DirEntryInfo; loading: boolean; metadataFailed?: boolean
  } | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const onFileMenu = useCallback<OpenFileMenu>((file, group, x, y) => {
    setMenu(null)
    setFileMenu({ file, group, x, y, request: Symbol(), loading: true })
  }, [])
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
    if (!files.some(file => file.path === fileMenu.file.path && file.status === fileMenu.file.status)) setFileMenu(null)
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
    ],
    [resetConflict, root.id, stage, t],
  )
  const stagedRowActions = useCallback(
    (file: GitFile): RowAction[] => [
      ...openFileAction(file),
      { title: t('git.unstage'), icon: 'minus', run: () => void unstage(root.id, [file.path]) },
    ],
    [openFileAction, root.id, t, unstage],
  )
  const changedRowActions = useCallback(
    (file: GitFile): RowAction[] => [
      ...openFileAction(file),
      { title: t('git.stage'), icon: 'plus', run: () => void stage(root.id, [file.path]) },
      {
        title: file.status === '?' ? t('git.deleteFile') : t('git.discardChanges'),
        icon: file.status === '?' ? 'trash' : 'undo',
        run: () => void discard(root.id, [file.path]),
      },
    ],
    [discard, openFileAction, root.id, stage, t],
  )

  const renderGroup = (
    key: FileGroup,
    title: string,
    files: GitFile[],
    actions: { label: string; icon: IconName; run: () => void; disabled?: boolean }[],
    onClickFile: ClickFile,
    rowActions: RowActionFactory,
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
                disabled={busy !== null || action.disabled}
                onClick={action.run}
                className="flex h-[18px] w-[18px] shrink-0 self-center items-center justify-center rounded-[4px] text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Icon name={action.icon} size={12} />
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

  const changes = [...status.changes, ...status.untracked]

  const fileItems: MenuItem[] = []
  if (fileMenu) {
    const { file, group, entry, loading } = fileMenu
    const regularFile = entry && !entry.isDir && !entry.isSymlink
    const gitFile = !file.path.endsWith('/') && !entry?.isDir
    const mutationDisabled = busy !== null || loading || fileMenu.metadataFailed
    if (group !== 'conflicts' && gitFile && !entry?.isSymlink) fileItems.push({
      label: t('git.openChanges'), disabled: loading || fileMenu.metadataFailed,
      onClick: () => void openDiff(root.id, file.path, group === 'staged'),
    })
    if (regularFile) fileItems.push({ label: t('diff.openFile'), onClick: () => void openFile(root.id, file.path) })
    if (gitFile) {
      if (fileItems.length) fileItems.push({ type: 'separator' })
      if (group === 'conflicts') {
        fileItems.push({ label: t('git.markResolved'), disabled: mutationDisabled, onClick: () => void stage(root.id, [file.path]) })
        if (regularFile) fileItems.push({ label: t('git.regenerateMarkers'), disabled: mutationDisabled, onClick: () => void resetConflict(root.id, file.path) })
      } else if (group === 'staged') {
        fileItems.push({ label: t('git.unstage'), disabled: mutationDisabled, onClick: () => void unstage(root.id, [file.path]) })
      } else {
        fileItems.push({ label: t('git.stage'), disabled: mutationDisabled, onClick: () => void stage(root.id, [file.path]) })
        if (!entry?.isSymlink) fileItems.push({
          label: file.status === '?' ? t('git.deleteFile') : t('git.discardChanges'), danger: true,
          disabled: mutationDisabled, onClick: () => void discard(root.id, [file.path]),
        })
      }
    }
    if (entry && !entry.isDir) {
      if (fileItems.length) fileItems.push({ type: 'separator' })
      if (agentEnabled && regularFile) fileItems.push({
        label: agentKeys ? t('titlebar.agentTip', { shortcut: agentKeys }) : t('commands.agent.ask'),
        onClick: () => { useAgent.getState().newChat(root.id, [{ rel: file.path, isDir: false }]) },
      })
      fileItems.push(
        { label: t('explorer.rename'), disabled: mutationDisabled, onClick: () => void renameEntryFlow(root.id, file.path) },
        { label: t('explorer.delete'), danger: true, disabled: mutationDisabled, onClick: () => void deleteEntryFlow(root.id, file.path) },
        { label: t('explorer.revealInFinder'), onClick: () => void revealEntry(root.id, file.path) },
      )
    }
    if (fileItems.length) fileItems.push({ type: 'separator' })
    fileItems.push(
      { label: t('explorer.copyRelativePath'), onClick: () => void copyText(file.path, t('explorer.copyRelativePath')) },
      { label: t('explorer.copyAbsolutePath'), onClick: () => void copyText(`${root.id}/${file.path}`, t('explorer.copyAbsolutePath')) },
      { label: t('explorer.copyName'), onClick: () => void copyText(basename(file.path.replace(/\/+$/, '')), t('explorer.copyName')) },
    )
  }

  const trackedChanges = status.staged.length + status.changes.length
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
    { type: 'separator' },
    {
      label: t('git.stashChanges'),
      disabled: busy !== null || Boolean(operation) || trackedChanges === 0,
      onClick: () => void stashChanges(root.id),
    },
    {
      label: stashCount && stashCount > 0
        ? t('git.popStashCount', { count: stashCount })
        : t('git.popStash'),
      disabled: busy !== null || Boolean(operation) || stashCount === 0,
      onClick: () => void popStash(root.id),
    },
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
              setFileMenu(null)
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
            icon: 'undo',
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
