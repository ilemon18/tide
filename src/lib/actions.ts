import { open as openDialog } from '@tauri-apps/plugin-dialog'
import { api, errorText } from './ipc'
import { basename, dirname } from './paths'
import { activeRoot, useWorkspace } from '../store/workspace'
import { useTabs } from '../store/tabs'
import { useGit } from '../store/git'
import { useTerminal } from '../store/terminal'
import { useBlame } from '../store/blame'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { useFileIndex } from '../store/fileIndex'
import { beginBranchTransition, endBranchTransition } from '../store/watcher'
import type { SettingsSectionId } from './settingsSections'
import { t } from '../i18n'

/** Confirm unsaved changes can be discarded before replacing the project */
async function confirmReplaceWorkspace(): Promise<boolean> {
  const dirty = useTabs.getState().tabs.some((t) => t.dirty)
  if (!dirty) return true
  return useUi.getState().confirm({
    title: t('dialog.switchProject.title'),
    message: t('dialog.switchProject.message'),
    confirmText: t('dialog.switchProject.confirm'),
    danger: true,
  })
}

/**
 * Claim the project before opening: if another window has it, or is opening it, the backend
 * focuses that window and returns true. One project belongs to one window.
 *
 * The check and the claim must happen in one backend call — a frontend "check then open" has
 * several IPC hops in between, and two windows clicking the same project would both see it free
 * and each open a copy.
 */
async function claimProject(path: string): Promise<boolean> {
  try {
    if (!(await api.claimProject(path))) return false
  } catch {
    // A failed lookup is not fatal: open here as usual
    return false
  }
  useUi.getState().toast(t('toast.projectInOtherWindow'), 'info')
  return true
}

/**
 * Open a project. A window holds one project: opening a new directory closes the current one
 * (use "New window" for multiple), and a project already open elsewhere gets focused.
 */
export async function openWorkspace(path: string): Promise<string | null> {
  const workspace = useWorkspace.getState()
  if (workspace.roots.some((r) => r.id === path)) {
    workspace.setActiveRoot(path)
    return path
  }

  // Claim before touching the current project: on failure there is nothing to clean up here
  if (await claimProject(path)) return null

  let opened = false
  try {
    if (workspace.roots.length > 0) {
      if (!(await confirmReplaceWorkspace())) return null
      // Split view: tabs in the other pane must close too, closeAll only covers the current panel
      await useTabs.getState().closeEverything({ force: true })
      useGit.getState().reset()
      useBlame.getState().clear()
      await workspace.closeWorkspace()
    }

    const node = await workspace.openFolder(path)
    if (!node) return null
    opened = true
    // The terminal follows the project: the old root is gone, retarget after openFolder
    useTerminal.getState().retarget(node.id)
    void useGit.getState().refresh(node.id, true)
    return node.id
  } finally {
    // Not opened (cancel / failure / lost the race): hand the claim back
    if (!opened) void api.releaseProjectClaim(path).catch(() => {})
  }
}

/** Legacy call: opens only the first directory */
export async function openWorkspaces(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  await openWorkspace(paths[0])
}

export async function openFolderDialog(): Promise<void> {
  try {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: t('dialog.openFolder.title'),
    })
    if (typeof picked === 'string' && picked) {
      await openWorkspace(picked)
    }
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
  }
}

/**
 * Open a new window; with a path the new window opens that project. The backend checks first: if
 * the project is open or a blank window can be reused, it just focuses it (returns true).
 */
export async function newWindow(path?: string): Promise<void> {
  try {
    const focused = await api.newWindow(path ?? null)
    if (focused) {
      useUi
        .getState()
        .toast(
          path ? t('toast.projectInOtherWindow') : t('toast.blankWindowFocused'),
          'info',
        )
    }
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
  }
}

/**
 * A successful checkout already switched the worktree. Kick off the expensive explorer / status / open-file
 * refresh in the background so the status bar leaves "Switching…" immediately; the watcher stays suppressed
 * until these explicit reads finish, otherwise the same branch change scans everything twice.
 */
async function refreshAfterBranchChange(root: string): Promise<void> {
  const git = useGit.getState()
  git.invalidateBranches(root)
  useFileIndex.getState().invalidate(root)
  await Promise.allSettled([
    git.refresh(root, true),
    git.loadBranches(root, true),
    useWorkspace.getState().refreshTree(root, { quiet: true }),
    useTabs.getState().refreshFromDisk(root),
  ])
}

/** Checkout a branch: block on unsaved files, then let the worktree refresh run in the background */
export async function checkoutBranch(
  root: string,
  branch: string,
  kind: 'local' | 'remote',
): Promise<void> {
  const dirty = useTabs.getState().tabs.some((t) => t.root === root && t.dirty)
  if (dirty) {
    useUi.getState().toast(t('toast.saveBeforeCheckout'), 'error')
    return
  }
  const git = useGit.getState()
  git.setBusy('checkout')
  beginBranchTransition(root)
  let refreshStarted = false
  try {
    await api.gitCheckout(root, branch, kind)
    useBlame.getState().clear()
    refreshStarted = true
    // The checkout is complete; let the command stop blocking the status bar while the caches catch up.
    void refreshAfterBranchChange(root)
      .catch(() => {})
      .finally(() => endBranchTransition(root))
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
  } finally {
    if (!refreshStarted) endBranchTransition(root)
    git.setBusy(null)
  }
}

/** Create a branch and switch to it: same checks and background refresh. false keeps the dialog open so the name can be retried. */
export async function createBranch(root: string, name: string): Promise<boolean> {
  const dirty = useTabs.getState().tabs.some((t) => t.root === root && t.dirty)
  if (dirty) {
    useUi.getState().toast(t('toast.saveBeforeBranch'), 'error')
    return false
  }
  const git = useGit.getState()
  git.setBusy('checkout')
  beginBranchTransition(root)
  let refreshStarted = false
  try {
    await api.gitBranchCreate(root, name)
    useBlame.getState().clear()
    refreshStarted = true
    void refreshAfterBranchChange(root)
      .catch(() => {})
      .finally(() => endBranchTransition(root))
    return true
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
    return false
  } finally {
    if (!refreshStarted) endBranchTransition(root)
    git.setBusy(null)
  }
}

export async function closeWorkspaceDialog(): Promise<void> {
  const dirty = useTabs.getState().tabs.some((t) => t.dirty)
  if (dirty) {
    const ok = await useUi.getState().confirm({
      title: t('dialog.closeProject.title'),
      message: t('dialog.closeProject.message'),
      confirmText: t('dialog.closeProject.confirm'),
      danger: true,
    })
    if (!ok) return
  }
  // Unsaved files were confirmed above; close directly to avoid a second prompt
  await useTabs.getState().closeEverything({ force: true })
  await useWorkspace.getState().closeWorkspace()
  useGit.getState().reset()
  // The old root is no longer authorized; the terminal goes back to no-project (shell reopens in home)
  useTerminal.getState().retarget(null)
}

export async function removeRoot(rootId: string): Promise<void> {
  const openTabs = useTabs.getState().tabs.filter((t) => t.root === rootId)
  if (openTabs.some((t) => t.dirty)) {
    const ok = await useUi.getState().confirm({
      title: t('dialog.removeProject.title'),
      message: t('dialog.removeProject.message'),
      confirmText: t('dialog.removeProject.confirm'),
      danger: true,
    })
    if (!ok) return
  }
  await useTabs.getState().closeTabs(
    openTabs.map((tab) => tab.id),
    { force: true },
  )
  await useWorkspace.getState().removeRoot(rootId)
  // Project list is empty: reset the terminal, otherwise the shell sits in a removed workspace
  if (useWorkspace.getState().roots.length === 0) useTerminal.getState().retarget(null)
}

export async function newEntry(rootId: string | null, dir: string, kind: 'file' | 'dir'): Promise<void> {
  const root = rootId ?? activeRoot()?.id
  if (!root) {
    useUi.getState().toast(t('toast.openFolderFirst'), 'info')
    return
  }
  const name = await useUi.getState().askText({
    title: kind === 'file' ? t('dialog.newFile.title') : t('dialog.newFolder.title'),
    message: t('common.location', { path: dir || t('common.projectRoot') }),
    placeholder: kind === 'file' ? 'example.ts' : 'new-folder',
    confirmText: t('common.create'),
  })
  const trimmed = name?.trim()
  if (!trimmed) return
  const rel = await useWorkspace.getState().createEntry(root, dir, trimmed, kind)
  if (rel && kind === 'file') await useTabs.getState().openFile(root, rel)
}

export async function renameEntryFlow(root: string, rel: string): Promise<void> {
  const current = basename(rel)
  const next = await useUi.getState().askText({
    title: t('dialog.rename.title'),
    message: dirname(rel) || t('common.projectRoot'),
    value: current,
    confirmText: t('common.rename'),
  })
  const trimmed = next?.trim()
  if (!trimmed || trimmed === current) return
  const to = await useWorkspace.getState().renameEntry(root, rel, trimmed)
  if (to) {
    useTabs.getState().onRenamed(root, rel, to)
    useGit.getState().scheduleRefresh(root)
  }
}

export async function deleteEntryFlow(root: string, rel: string): Promise<void> {
  const ok = await useUi.getState().confirm({
    title: t('dialog.delete.title'),
    message: t('dialog.delete.message', { name: basename(rel) }),
    confirmText: t('common.delete'),
    danger: true,
  })
  if (!ok) return
  await useWorkspace.getState().deleteEntry(root, rel)
  useTabs.getState().onDeleted(root, rel)
  useGit.getState().scheduleRefresh(root)
}

export async function revealEntry(root: string, rel: string): Promise<void> {
  try {
    await api.revealInFinder(root, rel)
  } catch (e) {
    useUi.getState().toast(errorText(e), 'error')
  }
}

/** Switch back to the explorer and reveal/select the target in the file tree */
export function revealInExplorer(root: string, rel: string, isDir: boolean): void {
  useUi.getState().setActivityView('explorer')
  if (!useSettings.getState().sidebarVisible) useSettings.getState().patch({ sidebarVisible: true })
  useWorkspace.getState().setActiveRoot(root)
  useWorkspace.getState().requestTreeReveal({ root, rel, isDir })
}

/** Drop files/folders into the window */
export async function openDroppedPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return

  let dir: string | null = null
  let firstFile: { root: string; rel: string } | null = null

  for (const path of paths) {
    try {
      const info = await api.pathInfo(path)
      if (info.isDir && !dir) {
        dir = path
      } else if (!info.isDir && !firstFile) {
        firstFile = { root: dirname(path), rel: info.name }
      }
    } catch (e) {
      useUi.getState().toast(errorText(e), 'error')
    }
  }

  // One project at a time: the first dropped directory wins
  if (dir) {
    await openWorkspace(dir)
    return
  }
  if (firstFile) {
    const rootId = await openWorkspace(firstFile.root)
    if (rootId) await useTabs.getState().openFile(rootId, firstFile.rel)
  }
}

export function toggleSidebar(): void {
  const settings = useSettings.getState()
  settings.patch({ sidebarVisible: !settings.sidebarVisible })
}

/** Open (or focus) the settings tab. Settings is a normal editor tab, no dialog; pass section to land on a pane. */
export function openSettings(section?: SettingsSectionId): void {
  if (section) useUi.getState().setSettingsSection(section)
  useTabs.getState().openSettings()
}

export function toggleTerminal(): void {
  useTerminal.getState().toggle()
}

export function openTerminalTab(): void {
  useTerminal.getState().open()
}

/** Open a terminal in the current context directory: prefer the active file's directory */
export function openTerminalHere(): void {
  const activeId = useTabs.getState().activeId
  const tab = useTabs.getState().tabs.find((t) => t.id === activeId)
  const rootId = tab?.root ?? activeRoot()?.id ?? null
  const rel = tab ? dirname(tab.rel) : ''
  useTerminal.getState().open(rootId, rel)
}
