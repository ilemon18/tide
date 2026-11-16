import { api } from './ipc'
import { looksLikeConflict } from '../editor/conflicts'
import { useGit } from '../store/git'

/**
 * Decide whether a file is really unmerged. Without `<<<<<<<` in the content, no IPC is sent at all;
 * if git status is already loaded use the cache, otherwise ask the backend for `git ls-files -u`.
 */
export async function isConflictedFile(
  root: string,
  rel: string,
  content: string,
): Promise<boolean> {
  if (!looksLikeConflict(content)) return false
  const status = useGit.getState().statuses[root]
  if (status?.isRepo && status.conflicts.some((file) => file.path === rel)) return true
  // Missing from the cache does not mean no conflict: git status may be stale (a cherry-pick just
  // ran in the terminal). Only files whose content really has markers ask the backend.
  try {
    return await api.gitUnmerged(root, rel)
  } catch {
    // git unavailable (not a repo / command failed): judge by content so the conflict view still works
    return true
  }
}