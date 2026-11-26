import { create } from 'zustand'
import { api, errorText, type GitBranches, type GitFile, type GitStatus } from '../lib/ipc'
import { useUi } from './ui'
import { useWorkspace } from './workspace'
import { t } from '../i18n'

type GitStore = {
  statuses: Record<string, GitStatus>
  loading: Record<string, boolean>
  busy: string | null
  /** Number of queued Git index mutations per root. Index work is optimistic and coalesces its status refresh. */
  indexPending: Record<string, number>
  lastRefresh: number
  /** Branch list (status bar dropdown), cached per workspace root */
  branches: Record<string, GitBranches>
  branchesLoading: Record<string, boolean>
  /** Branch list cache time, for TTL and invalidation after external changes */
  branchesAt: Record<string, number>

  refresh: (root?: string, force?: boolean) => Promise<void>
  loadBranches: (root: string, force?: boolean) => Promise<void>
  invalidateBranches: (root: string) => void
  setBusy: (busy: string | null) => void
  scheduleRefresh: (root?: string) => void
  /** Whether a stage / unstage / discard is queued for this root (watchers skip their duplicate status run). */
  isIndexPending: (root: string) => boolean
  /**
   * Drop a project's state and caches after it is switched away / closed. Otherwise the changed-file count
   * in Source Control includes the previous project's numbers and looks unrefreshed on switch.
   */
  forget: (root: string) => void
  stage: (root: string, paths: string[]) => Promise<void>
  unstage: (root: string, paths: string[]) => Promise<void>
  discard: (root: string, paths: string[]) => Promise<void>
  discardAllChanges: (root: string) => Promise<void>
  commit: (root: string, message: string) => Promise<boolean>
  /** Undo the last commit (soft reset): changes stay staged, returns the previous commit message */
  undoLastCommit: (root: string) => Promise<string | null>
  /** Stash tracked index + worktree changes; untracked files stay in place */
  stashChanges: (root: string) => Promise<void>
  /** Pop the latest stash; a conflicted partial apply still refreshes the worktree */
  popStash: (root: string) => Promise<void>
  /** `git reset --hard HEAD`: staged + unstaged tracked changes, untracked files kept */
  resetAll: (root: string) => Promise<void>
  /** Continue an in-progress merge / cherry-pick / revert / rebase */
  continueOperation: (root: string, message: string) => Promise<boolean>
  abortOperation: (root: string) => Promise<boolean>
  skipOperation: (root: string) => Promise<boolean>
  /** Regenerate conflict markers from the index */
  resetConflict: (root: string, rel: string) => Promise<void>
  pull: (root: string) => Promise<void>
  push: (root: string) => Promise<void>
  /** Sync remote branches only (git fetch), no push */
  fetch: (root: string) => Promise<void>
  reset: () => void
}

/** Branch list cache TTL: avoids a for-each-ref run on every menu open */
const BRANCH_TTL = 30_000

const timers = new Map<string, ReturnType<typeof setTimeout>>()
const signatures = new Map<string, string>()
const statusRefreshes = new Map<string, Promise<void>>()
let discardAllConfirmPending = false
/** Roots whose changes are hidden optimistically while one bulk discard is in flight. */
const optimisticDiscards = new Set<string>()
/** Roots asked to force-refresh while a request is in flight; rerun once it finishes */
const pendingForceBranches = new Set<string>()
/** Per-root serial queue for index mutations: concurrent git add/restore calls would fight over index.lock. */
const indexQueues = new Map<string, Promise<void>>()

function signatureOf(s: GitStatus): string {
  const part = (files: { path: string; status: string }[]) =>
    files.map((f) => f.path + f.status).join(',')
  // Operation state and the pending message must be compared too, else conflict resolution / cherry-pick
  // progress is swallowed by the "no change" short circuit
  const op = s.operation ? `${s.operation.kind}:${s.pendingMessage}` : ''
  return `${s.branch}|${s.ahead}|${s.behind}|${part(s.staged)}|${part(s.changes)}|${part(s.untracked)}|${part(s.conflicts)}|${op}|${s.error ?? ''}`
}

function sortFiles(files: GitFile[]): GitFile[] {
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

function mergeFiles(files: GitFile[]): GitFile[] {
  return sortFiles([...new Map(files.map((file) => [file.path, file])).values()])
}

/** Predicted status after `git add`: changed/untracked rows move to staged. Conflicts need git's XY decision. */
function stageStatus(status: GitStatus, paths: readonly string[]): GitStatus {
  const selected = new Set(paths)
  const staged = [...status.staged]
  for (const file of [...status.changes, ...status.untracked]) {
    if (!selected.has(file.path)) continue
    staged.push({ path: file.path, status: file.status === '?' ? 'A' : file.status })
  }
  return {
    ...status,
    staged: mergeFiles(staged),
    changes: status.changes.filter((file) => !selected.has(file.path)),
    untracked: status.untracked.filter((file) => !selected.has(file.path)),
  }
}

/** Predicted status after `git restore --staged`: staged rows move back to worktree changes. */
function unstageStatus(status: GitStatus, paths: readonly string[]): GitStatus {
  const selected = new Set(paths)
  const changes = [...status.changes]
  const untracked = [...status.untracked]
  for (const file of status.staged) {
    if (!selected.has(file.path)) continue
    if (file.status === 'A') untracked.push({ path: file.path, status: '?' })
    else changes.push({ path: file.path, status: file.status })
  }
  return {
    ...status,
    staged: status.staged.filter((file) => !selected.has(file.path)),
    changes: mergeFiles(changes),
    untracked: mergeFiles(untracked),
  }
}

/** Predicted status after discarding worktree changes / deleting an untracked file. */
function discardStatus(status: GitStatus, paths: readonly string[]): GitStatus {
  const selected = new Set(paths)
  return {
    ...status,
    changes: status.changes.filter((file) => !selected.has(file.path)),
    untracked: status.untracked.filter((file) => !selected.has(file.path)),
  }
}

function enqueueIndex(root: string, task: () => Promise<void>): Promise<void> {
  const previous = indexQueues.get(root) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(task)
  const tracked = next.catch(() => {})
  indexQueues.set(root, tracked)
  void tracked.finally(() => {
    if (indexQueues.get(root) === tracked) indexQueues.delete(root)
  })
  return next
}

async function waitForIndexQueue(root: string): Promise<void> {
  await (indexQueues.get(root) ?? Promise.resolve())
}

function beginIndex(root: string): void {
  const pending = useGit.getState().indexPending
  useGit.setState({ indexPending: { ...pending, [root]: (pending[root] ?? 0) + 1 } })
}

function finishIndex(root: string): void {
  const state = useGit.getState()
  const pending = state.indexPending
  const count = Math.max(0, (pending[root] ?? 1) - 1)
  const next = { ...pending }
  if (count > 0) next[root] = count
  else delete next[root]
  useGit.setState({ indexPending: next })
  // An exclusive operation owns the next authoritative refresh. Otherwise one status run settles the burst.
  if (count === 0 && state.busy === null) {
    signatures.delete(root)
    void useGit.getState().refresh(root, true)
  }
}

function applyOptimistic(root: string, transform: (status: GitStatus) => GitStatus): void {
  if (!useWorkspace.getState().roots.some((node) => node.id === root)) return
  const state = useGit.getState()
  const status = state.statuses[root]
  if (!status || status.error) return
  signatures.delete(root)
  useGit.setState({ statuses: { ...state.statuses, [root]: transform(status) } })
}

export const useGit = create<GitStore>((set, get) => ({
  statuses: {},
  loading: {},
  busy: null,
  indexPending: {},
  lastRefresh: 0,
  branches: {},
  branchesLoading: {},
  branchesAt: {},

  loadBranches: async (root, force = false) => {
    if (get().branchesLoading[root]) {
      // A request is in flight: force (fetch / checkout) must not be dropped silently
      if (force) pendingForceBranches.add(root)
      return
    }
    // Cached and not expired: use it, opening the menu does not run git every time
    if (!force && get().branches[root] && Date.now() - (get().branchesAt[root] ?? 0) < BRANCH_TTL) {
      return
    }
    set({ branchesLoading: { ...get().branchesLoading, [root]: true } })
    try {
      const list = await api.gitBranches(root)
      set({
        branches: { ...get().branches, [root]: list },
        branchesAt: { ...get().branchesAt, [root]: Date.now() },
        branchesLoading: { ...get().branchesLoading, [root]: false },
      })
    } catch (e) {
      set({ branchesLoading: { ...get().branchesLoading, [root]: false } })
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      if (pendingForceBranches.delete(root)) void get().loadBranches(root, true)
    }
  },

  invalidateBranches: (root) => {
    if (!get().branchesAt[root]) return
    set({ branchesAt: { ...get().branchesAt, [root]: 0 } })
  },

  setBusy: (busy) => set({ busy }),

  refresh: async (root, force = false) => {
    // With a root (watcher callback / single project) refresh just that one; without, probe every root so a
    // git init / rm -rf .git in a terminal is corrected on focus or fallback polling even if the watcher
    // missed the event.
    const targets = root
      ? [root]
      : useWorkspace.getState().roots.map((r) => r.id)
    /** Is the project still open: drop stale results from a switch / close in progress */
    const isOpen = (id: string) => useWorkspace.getState().roots.some((r) => r.id === id)
    if (targets.length === 0) {
      signatures.clear()
      set({ statuses: {} })
      return
    }

    for (const target of targets) {
      if (!isOpen(target)) {
        get().forget(target)
        continue
      }
      // Watcher/focus refreshes must not put the rows back while discard-all is still running. The
      // operation finishes with one forced refresh, which becomes the authoritative state.
      if (optimisticDiscards.has(target)) {
        if (get().loading[target]) {
          set({ loading: { ...get().loading, [target]: false } })
        }
        continue
      }
      // The queue's final refresh is authoritative. Running status mid-burst would only race optimistic rows.
      if ((get().indexPending[target] ?? 0) > 0) continue
      const pending = statusRefreshes.get(target)
      if (pending) {
        if (force) {
          await pending
          await get().refresh(target, true)
        }
        continue
      }
      let finishRefresh = () => {}
      const completed = new Promise<void>((resolve) => {
        finishRefresh = resolve
      })
      statusRefreshes.set(target, completed)
      set({ loading: { ...get().loading, [target]: true } })
      try {
        const status = await api.gitStatus(target)
        // The project was switched away / closed before git status finished: the result belongs to the previous
        // project and would pin the changed-file count to it
        if (!isOpen(target)) {
          get().forget(target)
          continue
        }
        // A status request that started before the optimistic mutation must not overwrite it.
        if (optimisticDiscards.has(target)) {
          set({ loading: { ...get().loading, [target]: false } })
          continue
        }
        set({ loading: { ...get().loading, [target]: false }, lastRefresh: Date.now() })

        // git reported an error itself (concurrent index write, lock conflict): keep the last good state.
        // Must not flip the repo flag with isRepo=false, nor treat an empty list as a stale diff tab
        if (status.error) {
          if (force) useUi.getState().toast(status.error, 'error')
          continue
        }

        // Repo state may have just changed (git init / rm -rf .git in a terminal): sync back to the workspace
        // root, which the Git panel, status bar and .gitignore handling in the file tree all follow
        if (useWorkspace.getState().setGitRepo(target, status.isRepo)) {
          signatures.delete(target)
          if (status.isRepo) {
            get().invalidateBranches(target)
            void get().loadBranches(target, true)
          }
        }

        // Not a repo: nothing to show, don't cache an empty state
        if (!status.isRepo) {
          signatures.delete(target)
          if (get().statuses[target]) {
            const statuses = { ...get().statuses }
            delete statuses[target]
            set({ statuses })
          }
          continue
        }

        const signature = signatureOf(status)
        if (!force && signatures.get(target) === signature) continue
        signatures.set(target, signature)
        set({ statuses: { ...get().statuses, [target]: status } })
      } catch (e) {
        if (!isOpen(target)) {
          get().forget(target)
          continue
        }
        set({ loading: { ...get().loading, [target]: false } })
        if (optimisticDiscards.has(target)) continue
        if (force) useUi.getState().toast(errorText(e), 'error')
      } finally {
        statusRefreshes.delete(target)
        finishRefresh()
      }
    }
  },

  isIndexPending: (root) => (get().indexPending[root] ?? 0) > 0,

  forget: (root) => {
    const timer = timers.get(root)
    if (timer) {
      clearTimeout(timer)
      timers.delete(root)
    }
    signatures.delete(root)
    pendingForceBranches.delete(root)
    optimisticDiscards.delete(root)
    const indexPending = { ...get().indexPending }
    delete indexPending[root]

    const statuses = { ...get().statuses }
    const loading = { ...get().loading }
    const branches = { ...get().branches }
    const branchesLoading = { ...get().branchesLoading }
    const branchesAt = { ...get().branchesAt }
    if (
      !(root in statuses) &&
      !(root in loading) &&
      !(root in branches) &&
      !(root in branchesLoading) &&
      !(root in branchesAt) &&
      !(root in indexPending)
    ) {
      return
    }
    delete statuses[root]
    delete loading[root]
    delete branches[root]
    delete branchesLoading[root]
    delete branchesAt[root]
    set({ statuses, loading, branches, branchesLoading, branchesAt, indexPending })
  },

  scheduleRefresh: (root) => {
    const key = root ?? '__all__'
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        void useGit.getState().refresh(root)
      }, 350),
    )
  },

  stage: async (root, paths) => {
    if (get().busy || paths.length === 0) return
    const targets = [...new Set(paths)]
    applyOptimistic(root, (status) => stageStatus(status, targets))
    beginIndex(root)
    try {
      await enqueueIndex(root, async () => {
        await api.gitStage(root, targets)
      })
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      finishIndex(root)
    }
  },

  unstage: async (root, paths) => {
    if (get().busy || paths.length === 0) return
    const targets = [...new Set(paths)]
    applyOptimistic(root, (status) => unstageStatus(status, targets))
    beginIndex(root)
    try {
      await enqueueIndex(root, async () => {
        await api.gitUnstage(root, targets)
      })
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      finishIndex(root)
    }
  },

  discard: async (root, paths) => {
    if (get().busy || paths.length === 0) return
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitDiscard.title'),
      message: t('dialog.gitDiscard.message', { count: paths.length }),
      confirmText: t('dialog.gitDiscard.confirm'),
      danger: true,
    })
    if (!ok || get().busy) return
    const targets = [...new Set(paths)]
    applyOptimistic(root, (status) => discardStatus(status, targets))
    beginIndex(root)
    try {
      await enqueueIndex(root, async () => {
        await api.gitDiscard(root, targets)
      })
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      finishIndex(root)
    }
  },

  discardAllChanges: async (root) => {
    if (get().busy || discardAllConfirmPending || useUi.getState().confirmReq) return
    const confirmSnapshot = get().statuses[root]
    if (!confirmSnapshot || confirmSnapshot.error) return
    const confirmTracked = confirmSnapshot.changes.map((file) => file.path)
    const confirmUntracked = confirmSnapshot.untracked.map((file) => file.path)
    if (confirmTracked.length + confirmUntracked.length === 0) return
    discardAllConfirmPending = true
    let ok: boolean
    try {
      ok = await useUi.getState().confirm({
        title: t('dialog.gitDiscard.title'),
        message: t('dialog.gitDiscardAll.message', {
          restoreCount: confirmTracked.length,
          deleteCount: confirmUntracked.length,
        }),
        confirmText: t('dialog.gitDiscard.confirm'),
        danger: true,
      })
    } finally {
      discardAllConfirmPending = false
    }
    if (!ok || get().busy || !useWorkspace.getState().roots.some((node) => node.id === root)) return

    // Block new index actions immediately, then let queued stage/unstage work settle before taking the
    // authoritative snapshot for the bulk transaction.
    set({ busy: 'discard' })
    await waitForIndexQueue(root)
    if (!useWorkspace.getState().roots.some((node) => node.id === root)) {
      set({ busy: null })
      return
    }

    // Use the newest snapshot after the confirmation dialog. Keep it so an IPC-level failure can put
    // every row back immediately, before the forced refresh reports the real disk state.
    const snapshot = get().statuses[root]
    if (!snapshot || snapshot.error) {
      set({ busy: null })
      return
    }
    const trackedPaths = snapshot.changes.map((file) => file.path)
    const untrackedPaths = snapshot.untracked.map((file) => file.path)
    const targets = [...trackedPaths, ...untrackedPaths]
    if (targets.length === 0) {
      set({ busy: null })
      return
    }

    optimisticDiscards.add(root)
    signatures.delete(root)
    set({
      statuses: {
        ...get().statuses,
        [root]: { ...snapshot, changes: [], untracked: [] },
      },
    })

    let resumeSaves: ((reschedule?: boolean | readonly string[]) => void) | undefined
    const completed = new Set<string>()
    let receivedResult = false
    try {
      const { useTabs, suspendFileSaves } = await import('./tabs')
      resumeSaves = await suspendFileSaves(root, targets)
      const result = await api.gitDiscardChanges(root, trackedPaths, untrackedPaths)
      receivedResult = true
      for (const path of [...result.restored, ...result.deleted]) completed.add(path)
      // Remove deleted buffers before refreshing diffs, including dirty editors in both panes.
      for (const path of result.deleted) useTabs.getState().onDeleted(root, path)
      if (result.restored.length > 0) {
        await useTabs.getState().refreshFromDisk(root, { force: true, paths: result.restored })
      }
      if (result.error) {
        // A partial failure restores only the unprocessed rows right away; completed paths stay hidden.
        const remaining = new Set(targets.filter((path) => !completed.has(path)))
        if (useWorkspace.getState().roots.some((node) => node.id === root)) {
          set({
            statuses: {
              ...get().statuses,
              [root]: {
                ...snapshot,
                changes: snapshot.changes.filter((file) => remaining.has(file.path)),
                untracked: snapshot.untracked.filter((file) => remaining.has(file.path)),
              },
            },
          })
        }
        useUi.getState().toast(errorText(result.error), 'error')
      }
    } catch (error) {
      if (!receivedResult && useWorkspace.getState().roots.some((node) => node.id === root)) {
        set({ statuses: { ...get().statuses, [root]: snapshot } })
      }
      useUi.getState().toast(errorText(error), 'error')
    } finally {
      // Never reschedule a successful discard's old buffer, even if disk reload failed.
      resumeSaves?.(targets.filter((path) => !completed.has(path)))
      optimisticDiscards.delete(root)
      signatures.delete(root)
      try {
        await get().refresh(root, true)
      } finally {
        set({ busy: null })
      }
    }
  },

  commit: async (root, message) => {
    set({ busy: 'commit' })
    try {
      await waitForIndexQueue(root)
      await api.gitCommit(root, message)
      signatures.delete(root)
      await get().refresh(root, true)
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    } finally {
      set({ busy: null })
    }
  },

  undoLastCommit: async (root) => {
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitUndoCommit.title'),
      message: t('dialog.gitUndoCommit.message'),
      confirmText: t('dialog.gitUndoCommit.confirm'),
      danger: true,
    })
    if (!ok) return null

    set({ busy: 'undo' })
    try {
      await waitForIndexQueue(root)
      const result = await api.gitUndoCommit(root)
      signatures.delete(root)
      if (useWorkspace.getState().roots.some((node) => node.id === root)) {
        if (result.status) {
          signatures.set(root, signatureOf(result.status))
          set({ statuses: { ...get().statuses, [root]: result.status } })
        } else {
          await get().refresh(root, true)
        }
      }
      return result.message
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return null
    } finally {
      set({ busy: null })
    }
  },

  stashChanges: async (root) => {
    if (get().busy || useUi.getState().confirmReq) return
    set({ busy: 'stash' })
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    try {
      await waitForIndexQueue(root)
      const { useTabs, suspendFileSaves } = await import('./tabs')

      // Save dirty project files first so the stash contains the user's latest edits. Untitled
      // buffers are deliberately skipped: saving one would open a Save As dialog.
      for (const tab of useTabs.getState().tabs) {
        if (tab.root !== root || tab.kind !== 'file' || tab.external || !tab.dirty) continue
        if (!(await useTabs.getState().save(tab.id))) return
      }

      const snapshot = get().statuses[root]
      // A staged added/copied/renamed destination is removed from the worktree by `git stash push`;
      // its tab must close instead of being force-reloaded as a missing file.
      const removed = new Set(
        (snapshot?.staged ?? [])
          .filter((file) => /^[ARC]/.test(file.status.trim()))
          .map((file) => file.path),
      )
      const live = useTabs.getState()
      const paths = [...new Set(
        live.tabs
          .filter((tab) => tab.root === root && tab.kind === 'file' && !tab.external && tab.rel)
          .map((tab) => tab.rel),
      )]
      if (paths.length) resume = await suspendFileSaves(root, paths)

      await api.gitStash(root)
      signatures.delete(root)
      await get().refresh(root, true)
      for (const rel of removed) useTabs.getState().onDeleted(root, rel)
      const reload = paths.filter((rel) => !removed.has(rel))
      if (reload.length) {
        await useTabs.getState().refreshFromDisk(root, { force: true, paths: reload })
      }
      resume?.(false)
      resume = undefined
      useUi.getState().toast(t('toast.gitStashed'), 'success')
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      resume?.()
      set({ busy: null })
    }
  },

  popStash: async (root) => {
    if (get().busy || useUi.getState().confirmReq) return
    set({ busy: 'stash-pop' })
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    try {
      await waitForIndexQueue(root)
      const { useTabs, suspendFileSaves } = await import('./tabs')

      for (const tab of useTabs.getState().tabs) {
        if (tab.root !== root || tab.kind !== 'file' || tab.external || !tab.dirty) continue
        if (!(await useTabs.getState().save(tab.id))) return
      }

      const live = useTabs.getState()
      const paths = [...new Set(
        live.tabs
          .filter((tab) => tab.root === root && tab.kind === 'file' && !tab.external && tab.rel)
          .map((tab) => tab.rel),
      )]
      if (paths.length) resume = await suspendFileSaves(root, paths)

      let applied = false
      try {
        await api.gitStashPop(root)
        applied = true
        useUi.getState().toast(t('toast.gitStashPopped'), 'success')
      } catch (e) {
        // A conflict exits non-zero after partially writing conflict markers. Refresh regardless,
        // then surface git's own message; the stash entry is kept by git.
        applied = true
        useUi.getState().toast(errorText(e), 'error')
      }

      signatures.delete(root)
      await get().refresh(root, true)
      if (applied && paths.length) {
        await useTabs.getState().refreshFromDisk(root, { force: true, paths })
      }
      resume?.(false)
      resume = undefined
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      resume?.()
      set({ busy: null })
    }
  },

  resetAll: async (root) => {
    if (get().busy || useUi.getState().confirmReq) return
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitResetAll.title'),
      message: t('dialog.gitResetAll.message'),
      confirmText: t('dialog.gitResetAll.confirm'),
      danger: true,
      confirmOnEnter: false,
    })
    if (!ok) return

    set({ busy: 'reset-all' })
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    try {
      await waitForIndexQueue(root)
      const { useTabs, suspendFileSaves } = await import('./tabs')
      const snapshot = get().statuses[root]
      // Staged added/copied/renamed destinations are deleted from the worktree by reset --hard;
      // close their tabs instead of trying to reload a path that no longer exists.
      const removed = new Set(
        (snapshot?.staged ?? [])
          .filter((file) => /^[ARC]/.test(file.status.trim()))
          .map((file) => file.path),
      )
      const live = useTabs.getState()
      const paths = [...new Set(
        live.tabs
          .filter((tab) => tab.root === root && tab.kind === 'file' && !tab.external && tab.rel)
          .map((tab) => tab.rel),
      )]
      if (paths.length) resume = await suspendFileSaves(root, paths)

      await api.gitResetAll(root)
      signatures.delete(root)
      await get().refresh(root, true)
      for (const rel of removed) useTabs.getState().onDeleted(root, rel)
      const reload = paths.filter((rel) => !removed.has(rel))
      if (reload.length) {
        await useTabs.getState().refreshFromDisk(root, { force: true, paths: reload })
      }
      resume?.(false)
      resume = undefined
      useUi.getState().toast(t('toast.gitResetAll'), 'success')
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      resume?.()
      set({ busy: null })
    }
  },

  continueOperation: async (root, message) => {
    set({ busy: 'continue' })
    try {
      await waitForIndexQueue(root)
      await api.gitContinue(root, message.trim() ? message : null)
      signatures.delete(root)
      await get().refresh(root, true)
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    } finally {
      set({ busy: null })
    }
  },

  abortOperation: async (root) => {
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitAbort.title'),
      message: t('dialog.gitAbort.message'),
      confirmText: t('dialog.gitAbort.confirm'),
      danger: true,
    })
    if (!ok) return false
    set({ busy: 'abort' })
    try {
      await waitForIndexQueue(root)
      await api.gitAbort(root)
      signatures.delete(root)
      await get().refresh(root, true)
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    } finally {
      set({ busy: null })
    }
  },

  skipOperation: async (root) => {
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitSkip.title'),
      message: t('dialog.gitSkip.message'),
      confirmText: t('dialog.gitSkip.confirm'),
      danger: true,
    })
    if (!ok) return false
    set({ busy: 'skip' })
    try {
      await waitForIndexQueue(root)
      await api.gitSkip(root)
      signatures.delete(root)
      await get().refresh(root, true)
      useUi.getState().toast(t('toast.gitSkipped'), 'success')
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    } finally {
      set({ busy: null })
    }
  },

  resetConflict: async (root, rel) => {
    set({ busy: 'conflict-reset' })
    try {
      await waitForIndexQueue(root)
      await api.gitConflictReset(root, rel)
      signatures.delete(root)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  pull: async (root) => {
    set({ busy: 'pull' })
    try {
      await waitForIndexQueue(root)
      const out = await api.gitPull(root)
      if (out.trim()) useUi.getState().toast(out, 'success')
      signatures.delete(root)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  push: async (root) => {
    set({ busy: 'push' })
    try {
      await waitForIndexQueue(root)
      const out = await api.gitPush(root)
      if (out.trim()) useUi.getState().toast(out, 'success')
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  fetch: async (root) => {
    set({ busy: 'fetch' })
    try {
      await waitForIndexQueue(root)
      // Sync remote branches only, no push and no worktree merge
      await api.gitFetch(root)
      signatures.delete(root)
      await get().loadBranches(root, true)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  reset: () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    signatures.clear()
    optimisticDiscards.clear()
    pendingForceBranches.clear()
    set({
      statuses: {},
      loading: {},
      busy: null,
      indexPending: {},
      branches: {},
      branchesLoading: {},
      branchesAt: {},
    })
  },
}))
