import { create } from 'zustand'
import {
  api,
  errorText,
  type AgentTurnChanges,
  type GitBranches,
  type GitFile,
  type GitStatus,
  type GitIdentity, type GitIdentityInfo, type GitCommitOptions, type GitBranchTarget, type GitPreferences,
} from '../lib/ipc'
import { useUi } from './ui'
import { useWorkspace } from './workspace'
import { t } from '../i18n'

export const DEFAULT_GIT_PREFERENCES: GitPreferences = { mergeAutoCommit: true, mergeLog: false, mergeNoFf: false, pullRebase: false,
  autoRefresh: true, backgroundFetch: false, disableSubmoduleRecursion: false }
let preferencesLoaded = false
let preferencesPromise: Promise<void> | null = null

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
  /** Window-only identity override: never persisted or broadcast to other windows. */
  temporaryIdentity: GitIdentity | null
  identities: Record<string, GitIdentityInfo>
  loadIdentity: (root: string, force?: boolean) => Promise<void>
  setTemporaryIdentity: (identity: GitIdentity | null) => void
  preferences: GitPreferences
  projectPreferences: Record<string, GitPreferences>
  loadProjectPreferences: (root: string, force?: boolean) => Promise<void>
  setProjectPreferences: (root: string, patch: Partial<GitPreferences>) => Promise<void>
  loadPreferences: (force?: boolean) => Promise<void>
  setPreferences: (patch: Partial<GitPreferences>) => Promise<void>
  clearStash: (root: string) => Promise<boolean>
  forcePush: (root: string) => Promise<boolean>
  fetchBranch: (root: string, target: GitBranchTarget) => Promise<boolean>
  renameBranch: (root: string, target: GitBranchTarget, name: string) => Promise<boolean>
  deleteBranch: (root: string, target: GitBranchTarget, deleteRemote: boolean, force: boolean) => Promise<boolean>
  integrateBranch: (root: string, target: GitBranchTarget, rebase: boolean) => Promise<boolean>

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
  discardAllChanges: (root: string, selectedPaths?: string[]) => Promise<void>
  discardFiles: (root: string, paths: string[]) => Promise<void>
  removeFiles: (root: string, paths: string[]) => Promise<void>
  ignoreFiles: (root: string, paths: string[]) => Promise<void>
  /**
   * Restore the files an agent turn changed to their content before that turn. `stale` means the
   * baseline snapshot is gone (pruned by `git gc`); `error` already toasted.
   */
  revertTurnChanges: (root: string, changes: AgentTurnChanges) => Promise<'ok' | 'stale' | 'error'>
  commit: (root: string, message: string, options?: GitCommitOptions) => Promise<boolean>
  /** Undo the last commit (soft reset): changes stay staged, returns the previous commit message */
  undoLastCommit: (root: string) => Promise<string | null>
  /** Stash tracked index + worktree changes; untracked files stay in place */
  stashChanges: (root: string, message?: string) => Promise<boolean>
  /** Pop the latest stash; a conflicted partial apply still refreshes the worktree */
  popStash: (root: string, sha?: string) => Promise<void>
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
  fetch: (root: string, quiet?: boolean) => Promise<void>
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

export function commitIdentity(root: string): GitIdentity | null {
  const state = useGit.getState()
  if (state.temporaryIdentity) return state.temporaryIdentity
  const info = state.identities[root]
  const identity = info?.effective
  return identity?.name && identity.email ? identity : null
}

async function suspendRootEdits(root: string): Promise<() => void> {
  const { setGitEditLocked, gitEditCompartment, gitEditLock } = await import('../editor/stateCache')
  const { getEditorView } = await import('../editor/viewRef')
  const { useTabs } = await import('./tabs')
  const apply = (locked: boolean) => {
    setGitEditLocked(root, locked)
    const state = useTabs.getState()
    for (const group of state.groups) {
      if (!state.tabs.some(tab => tab.id === group.activeId && tab.root === root)) continue
      const view = getEditorView(group.id)
      if (view) view.dispatch({ effects: gitEditCompartment.reconfigure(gitEditLock(locked)) })
    }
  }
  apply(true)
  return () => apply(false)
}

async function branchMutation(root: string, action: string, run: () => Promise<unknown>, worktree = false): Promise<boolean> {
  const git = useGit.getState()
  if (git.busy) return false
  git.setBusy(action)
  let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
  let finishTransition: (() => void) | undefined
  let resumeEdits: (() => void) | undefined
  let changed = false
  try {
    await waitForIndexQueue(root)
    if (!useWorkspace.getState().roots.some(node => node.id === root)) return false
    if (worktree) {
      resumeEdits = await suspendRootEdits(root)
      const { useTabs, suspendFileSaves } = await import('./tabs')
      if (useTabs.getState().tabs.some(tab => tab.root === root && tab.dirty)) {
        useUi.getState().toast(t('toast.saveBeforeCheckout'), 'error'); return false
      }
      const { beginBranchTransition, endBranchTransition } = await import('./watcher')
      beginBranchTransition(root); finishTransition = () => endBranchTransition(root)
      const paths = useTabs.getState().tabs.filter(tab => tab.root === root && tab.kind === 'file' && !tab.external).map(tab => tab.rel)
      resume = await suspendFileSaves(root, paths)
    }
    // A conflict may change the worktree even when Git exits with an error.
    changed = worktree
    await run()
    return true
  } catch (error) { useUi.getState().toast(errorText(error), 'error'); return false }
  finally {
    try {
      if (useWorkspace.getState().roots.some(node => node.id === root)) {
      signatures.delete(root)
      git.invalidateBranches(root)
      if (changed) {
        const { useTabs } = await import('./tabs')
        const { useBlame } = await import('./blame')
        const { useFileIndex } = await import('./fileIndex')
        useBlame.getState().clear(); useFileIndex.getState().invalidate(root)
        await Promise.allSettled([useWorkspace.getState().refreshTree(root, { quiet: true }), useTabs.getState().refreshFromDisk(root, { force: true })])
      }
      await Promise.allSettled([git.refresh(root, true), git.loadBranches(root, true)])
      }
    } finally { resume?.(!changed); resumeEdits?.(); finishTransition?.(); git.setBusy(null) }
  }
}

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

export async function waitForIndexQueue(root: string): Promise<void> {
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
  temporaryIdentity: null,
  identities: {},
  preferences: DEFAULT_GIT_PREFERENCES,
  projectPreferences: {},
  loadProjectPreferences: async (root, force = false) => {
    if (!force && get().projectPreferences[root]) return
    try { const preferences = await api.gitProjectPreferences(root); if (useWorkspace.getState().roots.some(node => node.id === root)) set({ projectPreferences: { ...get().projectPreferences, [root]: preferences } }) }
    catch (error) { if (force) useUi.getState().toast(errorText(error), 'error') }
  },
  setProjectPreferences: async (root, patch) => {
    try { const preferences = await api.gitSetProjectPreferences(root, patch); if (useWorkspace.getState().roots.some(node => node.id === root)) set({ projectPreferences: { ...get().projectPreferences, [root]: preferences } }) }
    catch (error) { useUi.getState().toast(errorText(error), 'error'); await get().loadProjectPreferences(root, true) }
  },
  loadPreferences: async (force = false) => {
    if (preferencesPromise) { await preferencesPromise; if (!force) return }
    if (preferencesLoaded && !force) return
    preferencesPromise = (async () => {
      try { const preferences = await api.gitPreferences(); set({ preferences }); preferencesLoaded = true }
      catch (error) { if (force) useUi.getState().toast(errorText(error), 'error') }
      finally { preferencesPromise = null }
    })()
    await preferencesPromise
  },
  setPreferences: async patch => {
    try { set({ preferences: await api.gitSetPreferences(patch) }) }
    catch (error) { useUi.getState().toast(errorText(error), 'error'); await get().loadPreferences(true) }
  },
  setTemporaryIdentity: temporaryIdentity => set({ temporaryIdentity }),
  loadIdentity: async (root, force = false) => {
    if (!force && get().identities[root]) return
    try {
      const info = await api.gitIdentity(root)
      if (useWorkspace.getState().roots.some(node => node.id === root)) set({ identities: { ...get().identities, [root]: info } })
    } catch (error) { useUi.getState().toast(errorText(error), 'error') }
  },
  forcePush: root => branchMutation(root, 'force-push', () => api.gitForcePush(root)),
  clearStash: root => branchMutation(root, 'clear-stash', () => api.gitClearStash(root)),
  fetchBranch: (root, target) => branchMutation(root, 'fetch', () => api.gitFetchBranch(root, target)),
  renameBranch: (root, target, name) => branchMutation(root, 'rename-branch', () => api.gitRenameBranch(root, target, name)),
  deleteBranch: (root, target, deleteRemote, force) => branchMutation(root, 'delete-branch', async () => {
    const result = await api.gitDeleteBranch(root, target, deleteRemote, force)
    if (result.error) throw new Error((result.localDeleted ? t('git.branchDeletePartial') + ' ' : '') + errorText(result.error))
  }),
  integrateBranch: (root, target, rebase) => branchMutation(root, rebase ? 'rebase' : 'merge', () => api.gitIntegrateBranch(root, target, rebase, commitIdentity(root)), true),

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
      if (!useWorkspace.getState().roots.some(node => node.id === root)) { get().forget(root); return }
      set({
        branches: { ...get().branches, [root]: list },
        branchesAt: { ...get().branchesAt, [root]: Date.now() },
        branchesLoading: { ...get().branchesLoading, [root]: false },
      })
    } catch (e) {
      set({ branchesLoading: { ...get().branchesLoading, [root]: false } })
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      if (pendingForceBranches.delete(root) && useWorkspace.getState().roots.some(node => node.id === root)) void get().loadBranches(root, true)
    }
  },

  invalidateBranches: (root) => {
    if (!get().branchesAt[root]) return
    set({ branchesAt: { ...get().branchesAt, [root]: 0 } })
  },

  setBusy: (busy) => set({ busy }),

  refresh: async (root, force = false) => {
    if (!force && root && !(get().projectPreferences[root] ?? get().preferences).autoRefresh) return
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
      if (!force && !(get().projectPreferences[target] ?? get().preferences).autoRefresh) continue
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
    const identities = { ...get().identities }
    const projectPreferences = { ...get().projectPreferences }
    if (
      !(root in statuses) &&
      !(root in loading) &&
      !(root in branches) &&
      !(root in branchesLoading) &&
      !(root in branchesAt) &&
      !(root in identities) &&
      !(root in projectPreferences) &&
      !(root in indexPending)
    ) {
      return
    }
    delete statuses[root]
    delete loading[root]
    delete branches[root]
    delete branchesLoading[root]
    delete branchesAt[root]
    delete identities[root]
    delete projectPreferences[root]
    set({ statuses, loading, branches, branchesLoading, branchesAt, indexPending, identities, projectPreferences })
  },

  scheduleRefresh: (root) => {
    if (root && !(get().projectPreferences[root] ?? get().preferences).autoRefresh) return
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

  discardFiles: async (root, paths) => { if (paths.length) await get().discardAllChanges(root, paths) },

  discardAllChanges: async (root, selectedPaths) => {
    if (get().busy || discardAllConfirmPending || useUi.getState().confirmReq) return
    const confirmSnapshot = get().statuses[root]
    if (!confirmSnapshot || confirmSnapshot.error) return
    const selection = selectedPaths ? new Set(selectedPaths) : null
    const selected = (file: GitFile) => !selection || selection.has(file.path)
    const confirmTracked = confirmSnapshot.changes.filter(selected).map((file) => file.path)
    const confirmUntracked = confirmSnapshot.untracked.filter(selected).map((file) => file.path)
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
    const trackedPaths = snapshot.changes.filter(selected).map((file) => file.path)
    const untrackedPaths = snapshot.untracked.filter(selected).map((file) => file.path)
    const targets = [...trackedPaths, ...untrackedPaths]
    const targetSet = new Set(targets)
    if (targets.length === 0) {
      set({ busy: null })
      return
    }

    optimisticDiscards.add(root)
    signatures.delete(root)
    set({
      statuses: {
        ...get().statuses,
        [root]: { ...snapshot, changes: snapshot.changes.filter(file => !targetSet.has(file.path)), untracked: snapshot.untracked.filter(file => !targetSet.has(file.path)) },
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
                changes: snapshot.changes.filter((file) => !targetSet.has(file.path) || remaining.has(file.path)),
                untracked: snapshot.untracked.filter((file) => !targetSet.has(file.path) || remaining.has(file.path)),
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

  removeFiles: async (root, paths) => {
    if (get().busy || useUi.getState().confirmReq || !paths.length) return
    const targets = [...new Set(paths)]
    const ok = await useUi.getState().confirm({ title: t('git.removeFiles'),
      message: t('git.removeFilesConfirm', { count: targets.length }), confirmText: t('common.delete'), danger: true })
    if (!ok || get().busy || !useWorkspace.getState().roots.some(node => node.id === root)) return
    set({ busy: 'remove' })
    await waitForIndexQueue(root)
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    const deleted = new Set<string>()
    try {
      if (!useWorkspace.getState().roots.some(node => node.id === root)) return
      const { useTabs, suspendFileSaves } = await import('./tabs')
      resume = await suspendFileSaves(root, targets)
      const result = await api.gitRemoveFiles(root, targets)
      for (const path of result.deleted) { deleted.add(path); useTabs.getState().onDeleted(root, path) }
      if (result.deleted.length) {
        const { useFileIndex } = await import('./fileIndex')
        useFileIndex.getState().invalidate(root)
        const { dirname } = await import('../lib/paths')
        for (const dir of new Set(result.deleted.map(dirname))) await useWorkspace.getState().refreshDir(root, dir)
      }
      if (result.error) useUi.getState().toast(errorText(result.error), 'error')
    } catch (error) { useUi.getState().toast(errorText(error), 'error') }
    finally {
      resume?.(targets.filter(path => !deleted.has(path)))
      signatures.delete(root)
      try { await get().refresh(root, true) } finally { set({ busy: null }) }
    }
  },

  ignoreFiles: async (root, paths) => {
    if (get().busy || !paths.length) return
    const targets = [...new Set(paths)]
    set({ busy: 'ignore' })
    await waitForIndexQueue(root)
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    try {
      if (!useWorkspace.getState().roots.some(node => node.id === root)) return
      const { useTabs, suspendFileSaves } = await import('./tabs')
      resume = await suspendFileSaves(root, ['.gitignore'])
      if (useTabs.getState().tabs.some(tab => tab.root === root && tab.rel === '.gitignore' && tab.dirty)) {
        useUi.getState().toast(t('git.ignoreDirty'), 'info')
        return
      }
      await api.gitIgnoreFiles(root, targets)
      resume(false)
      resume = undefined
      await useTabs.getState().refreshFromDisk(root, { paths: ['.gitignore'] })
      const { useFileIndex } = await import('./fileIndex')
      useFileIndex.getState().invalidate(root)
      await useWorkspace.getState().refreshDir(root, '')
    } catch (error) { useUi.getState().toast(errorText(error), 'error') }
    finally {
      resume?.()
      signatures.delete(root)
      try { await get().refresh(root, true) } finally { set({ busy: null }) }
    }
  },

  revertTurnChanges: async (root, changes) => {
    if (get().busy || useUi.getState().confirmReq) return 'error'
    set({ busy: 'turn-revert' })
    // Keep index mutations from racing a concurrent stage / unstage on the same repo
    await waitForIndexQueue(root)
    const targets = [...new Set(changes.files.flatMap((file) =>
      file.oldPath ? [file.path, file.oldPath] : [file.path]))]
    let resumeSaves: ((reschedule?: boolean | readonly string[]) => void) | undefined
    let restored: string[] = []
    let deleted: string[] = []
    let completed = false
    try {
      const { useTabs, suspendFileSaves } = await import('./tabs')
      if (targets.length) resumeSaves = await suspendFileSaves(root, targets)
      const result = await api.gitTurnRevert(root, changes.snapshot, changes.files)
      restored = result.restored
      deleted = result.deleted
      // Remove buffers for files the turn created before refreshing diffs
      for (const path of deleted) useTabs.getState().onDeleted(root, path)
      if (restored.length > 0) {
        await useTabs.getState().refreshFromDisk(root, { force: true, paths: restored })
      }
      completed = result.error === null
      if (result.error) {
        useUi.getState().toast(errorText(result.error), 'error')
      } else if (result.skipped.length > 0) {
        useUi.getState().toast(t('toast.agentChangesSkipped', { count: result.skipped.length }), 'error')
      }
      return completed ? 'ok' : 'error'
    } catch (error) {
      // The baseline tree is gone: the card hides the action instead of offering a dead one
      if ((error as { code?: unknown } | null)?.code === 'git.turnSnapshotMissing') return 'stale'
      useUi.getState().toast(errorText(error), 'error')
      return 'error'
    } finally {
      // Never reschedule a successfully reverted buffer, even if the disk reload failed
      const keep = new Set([...restored, ...deleted])
      resumeSaves?.(completed ? targets.filter((path) => !keep.has(path)) : undefined)
      signatures.delete(root)
      try {
        await get().refresh(root, true)
      } finally {
        set({ busy: null })
      }
    }
  },

  commit: async (root, message, options) => {
    if (get().busy) return false
    set({ busy: 'commit' })
    try {
      await waitForIndexQueue(root)
      const identity = options?.identity ?? commitIdentity(root)
      const result = options || identity ? await api.gitCommit(root, message, { ...options, identity,
        resetAuthor: options?.resetAuthor ?? Boolean(get().temporaryIdentity) }) : await api.gitCommit(root, message)
      if (result?.historyError) useUi.getState().toast(t('git.historySaveFailed', { error: errorText(result.historyError) }), 'info')
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

  stashChanges: async (root, message) => {
    if (get().busy || useUi.getState().confirmReq) return false
    set({ busy: 'stash' })
    let resume: ((reschedule?: boolean | readonly string[]) => void) | undefined
    try {
      await waitForIndexQueue(root)
      const { useTabs, suspendFileSaves } = await import('./tabs')

      // Save dirty project files first so the stash contains the user's latest edits. Untitled
      // buffers are deliberately skipped: saving one would open a Save As dialog.
      for (const tab of useTabs.getState().tabs) {
        if (tab.root !== root || tab.kind !== 'file' || tab.external || !tab.dirty) continue
        if (!(await useTabs.getState().save(tab.id))) return false
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

      const identity = commitIdentity(root)
      if (message !== undefined || identity) await api.gitStash(root, message, identity)
      else await api.gitStash(root)
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
      return true
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return false
    } finally {
      resume?.()
      set({ busy: null })
    }
  },

  popStash: async (root, sha) => {
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
      if (sha) await api.gitStashPop(root, sha)
      else await api.gitStashPop(root)
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
      const identity = commitIdentity(root)
      const result = identity ? await api.gitContinue(root, message.trim() ? message : null, identity) : await api.gitContinue(root, message.trim() ? message : null)
      if (result?.historyError) useUi.getState().toast(t('git.historySaveFailed', { error: errorText(result.historyError) }), 'info')
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
    if (get().busy) return
    // Keep the editor available during network I/O, then guard only the worktree phase.
    set({ busy: 'pull' })
    try { await api.gitFetch(root) }
    catch (error) { useUi.getState().toast(errorText(error), 'error'); return }
    finally { set({ busy: null }) }
    await branchMutation(root, 'pull', async () => {
      const out = await api.gitPull(root, commitIdentity(root))
      if (out.trim()) useUi.getState().toast(out, 'success')
    }, true)
  },

  push: async (root) => {
    if (get().busy) return
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

  fetch: async (root, quiet = false) => {
    if (get().busy) return
    set({ busy: 'fetch' })
    try {
      await waitForIndexQueue(root)
      // Sync remote branches only, no push and no worktree merge
      await api.gitFetch(root)
      signatures.delete(root)
      await get().loadBranches(root, true)
      await get().refresh(root, true)
    } catch (e) {
      if (!quiet) useUi.getState().toast(errorText(e), 'error')
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
      identities: {},
      projectPreferences: {},
    })
  },
}))
