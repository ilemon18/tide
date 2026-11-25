import { commandDefinition } from './commandRegistry'
import { captureRuntimeCommand, runtimeCommandAvailable, runRuntimeCommand } from './commandRuntime'
import { shortcutLabel } from './useShortcut'
import { api } from './ipc'
import { terminalFocused } from '../store/terminal'
import {
  closeWorkspaceDialog,
  newEntry,
  newWindow,
  openFileDialog,
  openFolderDialog,
  openSettings,
  openTerminalHere,
  removeRoot,
  toggleSidebar,
  toggleTerminal,
} from './actions'
import { groupTabs, useTabs } from '../store/tabs'
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
import { editorSelections } from '../editor/selectionRegistry'
import { terminalSelections } from './terminalSelection'

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
  run: () => unknown | Promise<unknown>
}

const closeCommandIds = new Set([
  'tab.close', 'tab.closeCurrent', 'tab.closeOthers', 'tab.closeLeft', 'tab.closeRight',
  'tab.closeAll', 'tab.closeUnmodified',
])

function isRunningChatTab(tab: { id: string; kind: string } | undefined): boolean {
  return tab?.kind === 'chat' && useAgent.getState().chats[tab.id.slice('chat:'.length)]?.status === 'running'
}

/** Returns true when a close command would remove any chat whose turn is still running. */
function closeCommandBlocked(id: string): boolean {
  if (!closeCommandIds.has(id)) return false
  if (id === 'tab.closeCurrent' && terminalFocused()) return false
  const state = useTabs.getState()
  const tabs = state.tabs ?? []
  const activeGroup = state.groups?.find((group) => group.id === state.activeGroupId)
  const current = tabs.find((tab) => tab.id === (activeGroup?.activeId ?? state.activeId))
  if (id === 'tab.close' || id === 'tab.closeCurrent') return isRunningChatTab(current)
  const list = activeGroup ? groupTabs(tabs, activeGroup) : tabs
  const index = current ? list.findIndex((tab) => tab.id === current.id) : -1
  if (id === 'tab.closeOthers') return list.some((tab) => tab.id !== current?.id && !tab.pinned && isRunningChatTab(tab))
  if (id === 'tab.closeLeft') return index > 0 && list.slice(0, index).some((tab) => !tab.pinned && isRunningChatTab(tab))
  if (id === 'tab.closeRight') return index >= 0 && list.slice(index + 1).some((tab) => !tab.pinned && isRunningChatTab(tab))
  if (id === 'tab.closeUnmodified') return list.some((tab) => !tab.dirty && !tab.pinned && isRunningChatTab(tab))
  return list.some(isRunningChatTab)
}

export function buildCommands(includeUnavailable = false, captureSources = true): Command[] {
  const tabs = useTabs.getState()
  const workspace = useWorkspace.getState()
  const git = useGit.getState()
  const ui = useUi.getState()
  const terminal = useTerminal.getState()
  const terminalWasFocused = terminalFocused()
  const root = activeRoot()
  const agentEnabled = useSettings.getState().agentEnabled
  // Capture before command-palette focus changes the source. Closures retain immutable text.
  const editorSource = agentEnabled && captureSources ? editorSelections.read(tabs.activeGroupId) : null
  const terminalSource = agentEnabled && captureSources && terminal.activeId ? terminalSelections.read(terminal.activeId) : null

  const actions: { id: string; run: Command['run'] }[] = [
    { id: 'folder.open', run: () => openFolderDialog() },
    { id: 'file.open', run: () => openFileDialog() },
    { id: 'app.newWindow', run: () => newWindow() },
    { id: 'folder.close', run: () => closeWorkspaceDialog() },
    { id: 'file.new', run: () => { useTabs.getState().openUntitled() } },
    { id: 'file.newOnDisk', run: () => newEntry(root?.id ?? null, '', 'file') },
    { id: 'folder.new', run: () => newEntry(root?.id ?? null, '', 'dir') },
    { id: 'file.save', run: () => tabs.saveActive() },
    { id: 'file.saveAll', run: () => tabs.saveAll() },
    { id: 'editor.format', run: () => void tabs.formatActive() },
    { id: 'tab.close', run: () => { if (!closeCommandBlocked('tab.close')) return tabs.closeActive() } },
    { id: 'tab.next', run: () => tabs.activateOffset(1) },
    { id: 'tab.prev', run: () => tabs.activateOffset(-1) },
    { id: 'tab.welcome', run: () => tabs.openWelcome() },
    {
      id: 'agent.ask',
      run: () => void useAgent.getState().newChat(),
    },

    {
      id: 'tab.closeOthers',
      run: () => {
        if (closeCommandBlocked('tab.closeOthers')) return
        const id = useTabs.getState().activeId
        if (id) void tabs.closeOthers(id)
      },
    },
    {
      id: 'tab.closeLeft',
      run: () => {
        if (closeCommandBlocked('tab.closeLeft')) return
        const id = useTabs.getState().activeId
        if (id) void tabs.closeLeft(id)
      },
    },
    {
      id: 'tab.closeRight',
      run: () => {
        if (closeCommandBlocked('tab.closeRight')) return
        const id = useTabs.getState().activeId
        if (id) void tabs.closeRight(id)
      },
    },
    { id: 'tab.closeAll', run: () => { if (!closeCommandBlocked('tab.closeAll')) return tabs.closeAll() } },
    {
      id: 'tab.reopenClosed',
      run: () => tabs.reopenClosed(),
    },
    { id: 'view.gotoLine', run: () => ui.openQuickOpen(':') },
    {
      id: 'tab.closeUnmodified',
      run: () => { if (!closeCommandBlocked('tab.closeUnmodified')) return tabs.closeUnmodified() },
    },
    {
      id: 'tab.pin',
      run: () => {
        const state = useTabs.getState()
        const tab = state.tabs.find((t) => t.id === state.activeId)
        if (tab) state.pinTab(tab.id, !tab.pinned)
      },
    },
    { id: 'view.splitRight', run: () => void tabs.split('row', false) },
    { id: 'view.splitDown', run: () => void tabs.split('column', false) },
    { id: 'view.splitRightMove', run: () => void tabs.split('row', true) },
    { id: 'view.splitDownMove', run: () => void tabs.split('column', true) },
    { id: 'view.unsplit', run: () => tabs.unsplit() },

    {
      id: 'view.fold',
      run: () => withView(foldCode),
    },
    {
      id: 'view.unfold',
      run: () => withView(unfoldCode),
    },
    { id: 'view.foldAll', run: () => withView(foldAll) },
    { id: 'view.unfoldAll', run: () => withView(unfoldAll) },

    {
      id: 'view.wordWrap',
      run: () => useTabs.getState().toggleWordWrap(),
    },
    { id: 'view.sidebar', run: () => toggleSidebar() },
    { id: 'view.explorer', run: () => { ui.setActivityView('explorer'); useSettings.getState().patch({ sidebarVisible: true }) } },
    { id: 'view.search', run: () => { void runRuntimeCommand('view.search') } },
    { id: 'view.git', run: () => { ui.setActivityView('git'); useSettings.getState().patch({ sidebarVisible: true }) } },
    { id: 'view.structure', run: () => { ui.setActivityView('structure'); useSettings.getState().patch({ sidebarVisible: true }) } },
    { id: 'view.goToSymbol', run: () => ui.openQuickOpen('@') },
    { id: 'view.panel', run: () => toggleTerminal() },
    { id: 'view.projects', run: () => ui.setOverlay('projects') },

    { id: 'terminal.new', run: () => openTerminalHere() },
    { id: 'search.clear', run: () => useSearch.getState().clear() },

    { id: 'theme.cycle', run: () => useSettings.getState().cycleTheme() },
    { id: 'theme.eyecare', run: () => useSettings.getState().setTheme('eyecare') },
    { id: 'theme.dracula', run: () => useSettings.getState().setTheme('dracula') },
    {
      id: 'blame.toggle',
      run: () => {
        const settings = useSettings.getState()
        settings.patch({ inlineBlame: !settings.inlineBlame })
      },
    },
    { id: 'prefs.open', run: () => openSettings() },

    { id: 'tree.collapse', run: () => workspace.collapseAll() },
    { id: 'tree.refresh', run: () => workspace.refreshTree() },
    {
      id: 'workspace.remove',
      run: async () => {
        if (root) await removeRoot(root.id)
      },
    },

    { id: 'git.refresh', run: () => git.refresh(root?.id, true) },
    { id: 'git.pull', run: async () => { if (root) await git.pull(root.id) } },
    { id: 'git.push', run: async () => { if (root) await git.push(root.id) } },
  ]

  actions.push(
    { id: 'view.quickOpen', run: () => ui.openQuickOpen() },
    { id: 'view.commands', run: () => ui.setOverlay('commands') },
    { id: 'app.cycleWindow', run: () => api.cycleWindow() },
    { id: 'tab.closeCurrent', run: () => {
      if (closeCommandBlocked('tab.closeCurrent')) return
      const current = useTerminal.getState()
      if (terminalWasFocused && terminal.activeId) return current.close(terminal.activeId)
      return useTabs.getState().closeActive()
    } },
    { id: 'tab.newCurrent', run: () => {
      const current = useTerminal.getState()
      if (terminalWasFocused) {
        const tab = terminal.tabs.find(tab => tab.id === terminal.activeId)
        void current.open(tab?.root ?? undefined, tab?.rel ?? '')
      } else useTabs.getState().openWelcome()
    } },
    { id: 'editor.zoomIn', run: () => { const s = useSettings.getState(); s.patch({ fontSize: Math.min(24, s.fontSize + 1) }) } },
    { id: 'editor.zoomOut', run: () => { const s = useSettings.getState(); s.patch({ fontSize: Math.max(10, s.fontSize - 1) }) } },
    { id: 'panel.show', run: () => { terminal.setVisible(true) } },
  )
  for (const id of ['editor.find', 'tree.rename', 'tree.delete', 'terminal.clear', 'context.openOrLatest']) {
    const run = captureRuntimeCommand(id)
    actions.push({ id, run: () => run?.() })
  }
  const list: Command[] = actions.map(action => {
    const definition = commandDefinition(action.id)!
    return { ...action, titleKey: definition.titleKey, groupKey: definition.groupKey }
  })

  if (agentEnabled) {
    if (editorSource?.attachments.length) {
      for (const intent of ['add', 'explain', 'refactor'] as const) {
        list.push({
          id: 'agent.context.' + intent, groupKey: 'commands.group.agent',
          titleKey: intent === 'add' ? 'agent.context.add' : intent === 'explain' ? 'agent.context.explain' : 'agent.context.refactor',
          run: () => { useAgent.getState().addContext(editorSource.root, editorSource.attachments, intent) },
        })
      }
    }
    if (terminalSource?.attachments.length) list.push({
      id: 'agent.context.terminal', groupKey: 'commands.group.agent', titleKey: 'agent.context.terminal',
      run: () => { useAgent.getState().addContext(terminalSource.root, terminalSource.attachments) },
    })
  }

  const resolved = list.map(command => ({ ...command, shortcut: shortcutLabel(command.id) }))
  if (includeUnavailable) return resolved
  return resolved.filter(command => commandAvailable(command.id))
}

/** Availability is shared by the palette and dispatch. Focus-specific runtime actions retain their owners. */
export function commandAvailable(id: string): boolean {
  if (closeCommandBlocked(id)) return false
  if (id.startsWith('agent.context.')) {
    if (!useSettings.getState().agentEnabled) return false
    if (id === 'agent.context.terminal') {
      const terminal = useTerminal.getState()
      return Boolean(terminal.activeId && terminalSelections.read(terminal.activeId)?.attachments.length)
    }
    return Boolean(editorSelections.read(useTabs.getState().activeGroupId)?.attachments.length)
  }
  if (id === 'agent.ask') return useSettings.getState().agentEnabled && Boolean(activeRoot())
  if (['editor.find', 'tree.rename', 'tree.delete', 'terminal.clear', 'context.openOrLatest', 'view.search'].includes(id)) {
    return runtimeCommandAvailable(id)
  }
  const definition = commandDefinition(id)
  if (!definition) return false
  if (definition.scope === 'editor') {
    const tabs = useTabs.getState()
    const tab = tabs.tabs?.find(tab => tab.id === tabs.activeId)
    return Boolean(tab && (tab.kind === 'file' || tab.kind === 'untitled') && !tab.preview)
  }
  if (id === 'panel.show') return !useTerminal.getState().visible
  if (/^(git\.|tree\.|workspace\.|folder\.(close|new)$|file.newOnDisk$|terminal.new$)/.test(id)) return Boolean(activeRoot())
  return true
}
