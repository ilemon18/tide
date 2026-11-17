import {
  closeWorkspaceDialog,
  newEntry,
  newWindow,
  openFolderDialog,
  openSettings,
  openTerminalHere,
  removeRoot,
  toggleSidebar,
  toggleTerminal,
} from './actions'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { useGit } from '../store/git'
import { activeRoot, useWorkspace } from '../store/workspace'
import { useTerminal } from '../store/terminal'
import { useSearch } from '../store/search'
import { useAgent } from '../store/agent'
import { foldAll, foldCode, unfoldAll, unfoldCode } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import { getEditorView } from '../editor/viewRef'
import type { MessageKey } from '../i18n'

/** Folding commands all act on the focused pane's view */
function withView(fn: (view: EditorView) => boolean) {
  const view = getEditorView()
  if (view) fn(view)
}

export type Command = {
  id: string
  /** Title / group hold catalog keys: the command palette follows a language switch immediately */
  titleKey: MessageKey
  groupKey: MessageKey
  shortcut?: string
  run: () => void | Promise<void>
}

export function buildCommands(): Command[] {
  const tabs = useTabs.getState()
  const workspace = useWorkspace.getState()
  const git = useGit.getState()
  const ui = useUi.getState()
  const terminal = useTerminal.getState()
  const root = activeRoot()

  const list: Command[] = [
    { id: 'folder.open', groupKey: 'commands.group.file', titleKey: 'commands.folder.open', shortcut: 'Mod O', run: () => openFolderDialog() },
    { id: 'app.newWindow', groupKey: 'commands.group.file', titleKey: 'commands.app.newWindow', shortcut: 'Mod ⇧ N', run: () => newWindow() },
    { id: 'folder.close', groupKey: 'commands.group.file', titleKey: 'commands.folder.close', run: () => closeWorkspaceDialog() },
    { id: 'file.new', groupKey: 'commands.group.file', titleKey: 'commands.file.new', shortcut: 'Mod N', run: () => { useTabs.getState().openUntitled() } },
    { id: 'file.newOnDisk', groupKey: 'commands.group.file', titleKey: 'commands.file.newOnDisk', run: () => newEntry(root?.id ?? null, '', 'file') },
    { id: 'folder.new', groupKey: 'commands.group.file', titleKey: 'commands.folder.new', run: () => newEntry(root?.id ?? null, '', 'dir') },
    { id: 'file.save', groupKey: 'commands.group.file', titleKey: 'commands.file.save', shortcut: 'Mod S', run: () => tabs.saveActive() },
    { id: 'file.saveAll', groupKey: 'commands.group.file', titleKey: 'commands.file.saveAll', shortcut: 'Mod ⇧ S', run: () => tabs.saveAll() },
    { id: 'editor.format', groupKey: 'commands.group.file', titleKey: 'commands.editor.format', shortcut: '⇧⌥F', run: () => void tabs.formatActive() },
    { id: 'tab.close', groupKey: 'commands.group.file', titleKey: 'commands.tab.close', shortcut: 'Mod ⇧ W', run: () => tabs.closeActive() },
    { id: 'tab.next', groupKey: 'commands.group.file', titleKey: 'commands.tab.next', shortcut: 'Mod ⇧ ]', run: () => tabs.activateOffset(1) },
    { id: 'tab.prev', groupKey: 'commands.group.file', titleKey: 'commands.tab.prev', shortcut: 'Mod ⇧ [', run: () => tabs.activateOffset(-1) },
    { id: 'tab.welcome', groupKey: 'commands.group.file', titleKey: 'commands.tab.welcome', shortcut: 'Mod T', run: () => tabs.openWelcome() },
    {
      id: 'agent.ask',
      groupKey: 'commands.group.agent',
      titleKey: 'commands.agent.ask',
      run: () => useAgent.getState().newChat(),
    },

    {
      id: 'tab.closeOthers',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.closeOthers',
      run: () => {
        const id = useTabs.getState().activeId
        if (id) void tabs.closeOthers(id)
      },
    },
    {
      id: 'tab.closeLeft',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.closeLeft',
      run: () => {
        const id = useTabs.getState().activeId
        if (id) void tabs.closeLeft(id)
      },
    },
    {
      id: 'tab.closeRight',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.closeRight',
      run: () => {
        const id = useTabs.getState().activeId
        if (id) void tabs.closeRight(id)
      },
    },
    { id: 'tab.closeAll', groupKey: 'commands.group.tabs', titleKey: 'commands.tab.closeAll', run: () => tabs.closeAll() },
    {
      id: 'tab.reopenClosed',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.reopenClosed',
      shortcut: 'Mod ⇧ T',
      run: () => tabs.reopenClosed(),
    },
    { id: 'view.gotoLine', groupKey: 'commands.group.view', titleKey: 'commands.view.gotoLine', shortcut: '⌃G', run: () => ui.openQuickOpen(':') },
    {
      id: 'tab.closeUnmodified',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.closeUnmodified',
      run: () => tabs.closeUnmodified(),
    },
    {
      id: 'tab.pin',
      groupKey: 'commands.group.tabs',
      titleKey: 'commands.tab.pin',
      run: () => {
        const state = useTabs.getState()
        const tab = state.tabs.find((t) => t.id === state.activeId)
        if (tab) state.pinTab(tab.id, !tab.pinned)
      },
    },
    { id: 'view.splitRight', groupKey: 'commands.group.tabs', titleKey: 'commands.view.splitRight', shortcut: 'Mod \\', run: () => void tabs.split('row', false) },
    { id: 'view.splitDown', groupKey: 'commands.group.tabs', titleKey: 'commands.view.splitDown', shortcut: 'Mod ⇧ \\', run: () => void tabs.split('column', false) },
    { id: 'view.splitRightMove', groupKey: 'commands.group.tabs', titleKey: 'commands.view.splitRightMove', run: () => void tabs.split('row', true) },
    { id: 'view.splitDownMove', groupKey: 'commands.group.tabs', titleKey: 'commands.view.splitDownMove', run: () => void tabs.split('column', true) },
    { id: 'view.unsplit', groupKey: 'commands.group.tabs', titleKey: 'commands.view.unsplit', run: () => tabs.unsplit() },

    {
      id: 'view.fold',
      groupKey: 'commands.group.view',
      titleKey: 'commands.view.fold',
      shortcut: 'Mod ⌥ [',
      run: () => withView(foldCode),
    },
    {
      id: 'view.unfold',
      groupKey: 'commands.group.view',
      titleKey: 'commands.view.unfold',
      shortcut: 'Mod ⌥ ]',
      run: () => withView(unfoldCode),
    },
    { id: 'view.foldAll', groupKey: 'commands.group.view', titleKey: 'commands.view.foldAll', run: () => withView(foldAll) },
    { id: 'view.unfoldAll', groupKey: 'commands.group.view', titleKey: 'commands.view.unfoldAll', run: () => withView(unfoldAll) },

    {
      id: 'view.wordWrap',
      groupKey: 'commands.group.view',
      titleKey: 'commands.view.wordWrap',
      shortcut: '⌥Z',
      run: () => useTabs.getState().toggleWordWrap(),
    },
    { id: 'view.sidebar', groupKey: 'commands.group.view', titleKey: 'commands.view.sidebar', shortcut: 'Mod B', run: () => toggleSidebar() },
    { id: 'view.explorer', groupKey: 'commands.group.view', titleKey: 'commands.view.explorer', shortcut: 'Mod ⇧ E', run: () => ui.setActivityView('explorer') },
    { id: 'view.search', groupKey: 'commands.group.view', titleKey: 'commands.view.search', shortcut: 'Mod ⇧ F', run: () => ui.setActivityView('search') },
    { id: 'view.git', groupKey: 'commands.group.view', titleKey: 'commands.view.git', shortcut: 'Mod ⇧ G', run: () => ui.setActivityView('git') },
    { id: 'view.structure', groupKey: 'commands.group.view', titleKey: 'commands.view.structure', shortcut: 'Mod U', run: () => ui.setActivityView('structure') },
    { id: 'view.goToSymbol', groupKey: 'commands.group.view', titleKey: 'commands.view.goToSymbol', run: () => ui.openQuickOpen('@') },
    { id: 'view.panel', groupKey: 'commands.group.view', titleKey: 'commands.view.panel', shortcut: 'Mod J', run: () => toggleTerminal() },
    { id: 'view.projects', groupKey: 'commands.group.view', titleKey: 'commands.view.projects', shortcut: 'Mod ⇧ O', run: () => ui.setOverlay('projects') },

    { id: 'terminal.new', groupKey: 'commands.group.terminal', titleKey: 'commands.terminal.new', run: () => openTerminalHere() },
    { id: 'search.focus', groupKey: 'commands.group.search', titleKey: 'commands.search.focus', shortcut: 'Mod ⇧ F', run: () => ui.setActivityView('search') },
    { id: 'search.clear', groupKey: 'commands.group.search', titleKey: 'commands.search.clear', run: () => useSearch.getState().clear() },

    { id: 'theme.cycle', groupKey: 'commands.group.appearance', titleKey: 'commands.theme.cycle', shortcut: 'Mod ⇧ K', run: () => useSettings.getState().cycleTheme() },
    { id: 'theme.eyecare', groupKey: 'commands.group.appearance', titleKey: 'commands.theme.eyecare', run: () => useSettings.getState().setTheme('eyecare') },
    { id: 'theme.dracula', groupKey: 'commands.group.appearance', titleKey: 'commands.theme.dracula', run: () => useSettings.getState().setTheme('dracula') },
    {
      id: 'blame.toggle',
      groupKey: 'commands.group.appearance',
      titleKey: 'commands.blame.toggle',
      run: () => {
        const settings = useSettings.getState()
        settings.patch({ inlineBlame: !settings.inlineBlame })
      },
    },
    { id: 'prefs.open', groupKey: 'commands.group.appearance', titleKey: 'commands.prefs.open', shortcut: 'Mod ,', run: () => openSettings() },

    { id: 'tree.collapse', groupKey: 'commands.group.project', titleKey: 'commands.tree.collapse', run: () => workspace.collapseAll() },
    { id: 'tree.refresh', groupKey: 'commands.group.project', titleKey: 'commands.tree.refresh', run: () => workspace.refreshTree() },
    {
      id: 'workspace.remove',
      groupKey: 'commands.group.project',
      titleKey: 'commands.workspace.remove',
      run: async () => {
        if (root) await removeRoot(root.id)
      },
    },

    { id: 'git.refresh', groupKey: 'commands.group.git', titleKey: 'commands.git.refresh', run: () => git.refresh(root?.id, true) },
    { id: 'git.pull', groupKey: 'commands.group.git', titleKey: 'commands.git.pull', run: async () => { if (root) await git.pull(root.id) } },
    { id: 'git.push', groupKey: 'commands.group.git', titleKey: 'commands.git.push', run: async () => { if (root) await git.push(root.id) } },
  ]

  if (!root) {
    return list.filter(
      (c) =>
        c.id === 'folder.open' ||
        c.id === 'view.projects' ||
        c.id.startsWith('theme.') ||
        c.id === 'prefs.open' ||
        // An untitled buffer / its word wrap need no project
        c.id === 'file.new' ||
        c.id === 'view.wordWrap' ||
        c.id === 'view.structure' ||
        c.id === 'view.goToSymbol',
    )
  }

  if (!terminal.visible) {
    list.push({ id: 'panel.show', groupKey: 'commands.group.view', titleKey: 'commands.panel.show', run: () => terminal.setVisible(true) })
  }

  return list
}
