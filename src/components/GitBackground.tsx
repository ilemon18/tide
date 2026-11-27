import { useEffect } from 'react'
import { listen } from '@tauri-apps/api/event'
import { useGit } from '../store/git'
import { useWorkspace } from '../store/workspace'
import { budget } from '../lib/memoryBudget'

/** One lazy serial remote sweep per visible window; no timer when disabled. */
export function GitBackground() {
  const roots = useWorkspace((s) => s.roots)
  const projectPreferences = useGit((s) => s.projectPreferences)
  const fallback = useGit((s) => s.preferences.backgroundFetch)
  const enabled = roots.some(
    (root) => root.isGitRepo && (projectPreferences[root.id]?.backgroundFetch ?? fallback),
  )
  const rootKey = roots.map((root) => `${root.id}:${root.isGitRepo}`).join('|')
  useEffect(() => {
    for (const root of roots)
      if (root.isGitRepo) void useGit.getState().loadProjectPreferences(root.id)
  }, [rootKey])
  useEffect(() => {
    let disposed = false,
      stop: (() => void) | undefined
    void useGit.getState().loadPreferences()
    const reload = () => {
      const git = useGit.getState()
      void git.loadPreferences(true)
      for (const root of useWorkspace.getState().roots)
        if (root.isGitRepo) {
          void git.loadIdentity(root.id, true)
          void git.loadProjectPreferences(root.id, true)
        }
    }
    void listen('git:config-changed', reload)
      .then((unlisten) => {
        if (disposed) unlisten()
        else stop = unlisten
      })
      .catch(() => {})
    // Manual config edits are picked up on the next window focus too.
    window.addEventListener('focus', reload)
    return () => {
      disposed = true
      stop?.()
      window.removeEventListener('focus', reload)
    }
  }, [])
  useEffect(() => {
    if (!enabled) return
    let disposed = false,
      timer: ReturnType<typeof setTimeout>
    const sweep = async () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        for (const root of useWorkspace.getState().roots) {
          if (disposed) break
          if (
            !(useGit.getState().projectPreferences[root.id] ?? useGit.getState().preferences)
              .backgroundFetch
          )
            continue
          if (
            root.isGitRepo &&
            !useGit.getState().busy &&
            !useGit.getState().isIndexPending(root.id)
          )
            await useGit.getState().fetch(root.id, true)
        }
      }
      if (!disposed) timer = setTimeout(() => void sweep(), budget.gitFetchInterval())
    }
    timer = setTimeout(() => void sweep(), budget.gitFetchInterval())
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [enabled])
  return null
}
