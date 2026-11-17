import { create } from 'zustand'
import { api, errorText, type GitBranches, type GitStatus } from '../lib/ipc'
import { useUi } from './ui'
import { useWorkspace } from './workspace'
import { t } from '../i18n'

type GitStore = {
  statuses: Record<string, GitStatus>
  loading: Record<string, boolean>
  busy: string | null
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
  /**
   * Drop a project's state and caches after it is switched away / closed. Otherwise the changed-file count
   * in Source Control includes the previous project's numbers and looks unrefreshed on switch.
   */
  forget: (root: string) => void
  stage: (root: string, paths: string[]) => Promise<void>
  unstage: (root: string, paths: string[]) => Promise<void>
  discard: (root: string, paths: string[]) => Promise<void>
  commit: (root: string, message: string) => Promise<boolean>
  /** Undo the last commit (soft reset): changes stay staged, returns the previous commit message */
  undoLastCommit: (root: string) => Promise<string | null>
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
/** Roots asked to force-refresh while a request is in flight; rerun once it finishes */
const pendingForceBranches = new Set<string>()

function signatureOf(s: GitStatus): string {
  const part = (files: { path: string; status: string }[]) =>
    files.map((f) => f.path + f.status).join(',')
  // Operation state and the pending message must be compared too, else conflict resolution / cherry-pick
  // progress is swallowed by the "no change" short circuit
  const op = s.operation ? `${s.operation.kind}:${s.pendingMessage}` : ''
  return `${s.branch}|${s.ahead}|${s.behind}|${part(s.staged)}|${part(s.changes)}|${part(s.untracked)}|${part(s.conflicts)}|${op}|${s.error ?? ''}`
}

export const useGit = create<GitStore>((set, get) => ({
  statuses: {},
  loading: {},
  busy: null,
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
      if (get().loading[target]) continue
      set({ loading: { ...get().loading, [target]: true } })
      try {
        const status = await api.gitStatus(target)
        // The project was switched away / closed before git status finished: the result belongs to the previous
        // project and would pin the changed-file count to it
        if (!isOpen(target)) {
          get().forget(target)
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
        if (force) useUi.getState().toast(errorText(e), 'error')
      }
    }
  },

  forget: (root) => {
    const timer = timers.get(root)
    if (timer) {
      clearTimeout(timer)
      timers.delete(root)
    }
    signatures.delete(root)
    pendingForceBranches.delete(root)

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
      !(root in branchesAt)
    ) {
      return
    }
    delete statuses[root]
    delete loading[root]
    delete branches[root]
    delete branchesLoading[root]
    delete branchesAt[root]
    set({ statuses, loading, branches, branchesLoading, branchesAt })
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
    if (paths.length === 0) return
    set({ busy: 'stage' })
    try {
      await api.gitStage(root, paths)
      signatures.delete(root)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  unstage: async (root, paths) => {
    if (paths.length === 0) return
    set({ busy: 'unstage' })
    try {
      await api.gitUnstage(root, paths)
      signatures.delete(root)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  discard: async (root, paths) => {
    if (paths.length === 0) return
    const ok = await useUi.getState().confirm({
      title: t('dialog.gitDiscard.title'),
      message: t('dialog.gitDiscard.message', { count: paths.length }),
      confirmText: t('dialog.gitDiscard.confirm'),
      danger: true,
    })
    if (!ok) return
    set({ busy: 'discard' })
    try {
      await api.gitDiscard(root, paths)
      signatures.delete(root)
      await get().refresh(root, true)
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    } finally {
      set({ busy: null })
    }
  },

  commit: async (root, message) => {
    set({ busy: 'commit' })
    try {
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
      const message = await api.gitUndoCommit(root)
      signatures.delete(root)
      await get().refresh(root, true)
      return message
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
      return null
    } finally {
      set({ busy: null })
    }
  },

  continueOperation: async (root, message) => {
    set({ busy: 'continue' })
    try {
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
      const out = await api.gitPull(root)
      useUi.getState().toast(out || t('toast.pullDone'), 'success')
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
      const out = await api.gitPush(root)
      useUi.getState().toast(out || t('toast.pushDone'), 'success')
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
      // Sync remote branches only, no push and no worktree merge
      await api.gitFetch(root)
      useUi.getState().toast(t('toast.fetchDone'), 'success')
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
    set({
      statuses: {},
      loading: {},
      busy: null,
      branches: {},
      branchesLoading: {},
      branchesAt: {},
    })
  },
}))
