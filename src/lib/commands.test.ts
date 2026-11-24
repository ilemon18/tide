// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
const { state, addContext } = vi.hoisted(() => ({
  state: { page: 'workspace', agentEnabled: true, activeGroupId: 'primary', activeId: 'terminal', visible: true,
    tabs: [] as Array<{ id: string; kind: string; pinned?: boolean; dirty?: boolean }>,
    chats: {} as Record<string, { status: string }>, shortcutOverrides: {} as Record<string, string[]> }, addContext: vi.fn(),
}))
vi.mock('./actions', () => ({ closeWorkspaceDialog: vi.fn(), newEntry: vi.fn(), newWindow: vi.fn(),
  openFolderDialog: vi.fn(), openSettings: vi.fn(), openTerminalHere: vi.fn(), removeRoot: vi.fn(), toggleSidebar: vi.fn(), toggleTerminal: vi.fn() }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => state }, groupTabs: (tabs: unknown[], group: { order?: string[] }) =>
  (group?.order ?? []).map(id => tabs.find((tab: unknown) => (tab as { id: string }).id === id)).filter(Boolean) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => state } }))
vi.mock('../store/settings', () => ({ useSettings: { getState: () => state } }))
vi.mock('../store/git', () => ({ useGit: { getState: () => ({}) } }))
vi.mock('../store/workspace', () => ({ activeRoot: () => ({ id: '/repo' }), useWorkspace: { getState: () => ({}) } }))
vi.mock('../store/terminal', () => ({ terminalFocused: () => false, useTerminal: { getState: () => state } }))
vi.mock('../store/search', () => ({ useSearch: { getState: () => ({}) } }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ addContext, chats: state.chats }) } }))
import { editorSelections } from '../editor/selectionRegistry'
import { terminalSelections } from './terminalSelection'
import { buildCommands, commandAvailable } from './commands'
import { registerCommandHandlers } from './commandRuntime'
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); state.page = 'workspace'; state.agentEnabled = true; state.tabs = []; state.activeId = 'terminal'; state.chats = {}; vi.clearAllMocks() })

it('retains editor and terminal source snapshots while the command palette takes focus', () => {
  let text = 'captured'
  const read = () => ({ root: '/repo', attachments: [{ id: text, kind: 'terminal-selection' as const,
    sourceRoot: '/repo', capturedAt: 1, text, label: 'Terminal', startupRel: '' }] })
  disposers.push(editorSelections.register('primary', read, () => true), terminalSelections.register('terminal', read, () => true))
  const commands = buildCommands()
  text = 'changed'
  commands.find(command => command.id === 'agent.context.refactor')!.run()
  expect(addContext).toHaveBeenLastCalledWith('/repo', expect.arrayContaining([expect.objectContaining({ text: 'captured' })]), 'refactor')
  commands.find(command => command.id === 'agent.context.terminal')!.run()
  expect(addContext).toHaveBeenLastCalledWith('/repo', expect.arrayContaining([expect.objectContaining({ text: 'captured' })]))
  expect(commands.filter(command => command.id.startsWith('agent.context.'))).toHaveLength(4)
})

it('omits context commands when there is no selection or AI is disabled', () => {
  expect(buildCommands().some(command => command.id.startsWith('agent.context.'))).toBe(false)
  state.agentEnabled = false
  disposers.push(editorSelections.register('primary', () => ({ root: '/repo', attachments: [] }), () => true))
  expect(buildCommands().some(command => command.id.startsWith('agent.context.'))).toBe(false)
})

it('retains a runtime action captured before palette autofocus and reads current key labels', () => {
  let focused = true
  const clear = vi.fn()
  disposers.push(registerCommandHandlers({ 'terminal.clear': { available: () => focused, run: clear } }))
  const commands = buildCommands()
  focused = false
  commands.find(command => command.id === 'terminal.clear')!.run()
  expect(clear).toHaveBeenCalledTimes(1)
  state.shortcutOverrides = { 'agent.ask': [] }
  expect(buildCommands(true).find(command => command.id === 'agent.ask')!.shortcut).toBe('')
  state.shortcutOverrides = {}
})

it('blocks close commands while the active chat is running', () => {
  state.tabs = [{ id: 'chat:one', kind: 'chat', pinned: false, dirty: false }]
  state.activeId = 'chat:one'
  state.chats = { one: { status: 'running' } }
  expect(commandAvailable('tab.close')).toBe(false)
  expect(commandAvailable('tab.closeCurrent')).toBe(false)
  expect(buildCommands().some(command => command.id === 'tab.close')).toBe(false)
})

it('blocks bulk close commands when their target set contains a running chat', () => {
  state.tabs = [
    { id: 'file', kind: 'file', pinned: false, dirty: false },
    { id: 'chat:one', kind: 'chat', pinned: false, dirty: false },
  ]
  state.activeId = 'file'
  state.chats = { one: { status: 'running' } }
  expect(commandAvailable('tab.closeAll')).toBe(false)
  expect(commandAvailable('tab.closeUnmodified')).toBe(false)
  expect(commandAvailable('tab.closeRight')).toBe(false)
})


it('keeps hidden workspace commands unavailable while history owns find and navigation', () => {
  state.page = 'history'
  const find = vi.fn()
  disposers.push(registerCommandHandlers({ 'editor.find': { available: () => true, run: find } }))
  for (const id of ['tab.closeCurrent', 'tab.closeAll', 'tab.next', 'view.splitRight', 'context.openOrLatest', 'file.save', 'terminal.clear', 'agent.context.add']) {
    expect(commandAvailable(id)).toBe(false)
  }
  expect(commandAvailable('editor.find')).toBe(true)
  expect(commandAvailable('view.explorer')).toBe(true)
  expect(commandAvailable('agent.ask')).toBe(true)
  buildCommands().find(command => command.id === 'editor.find')!.run()
  expect(find).toHaveBeenCalledOnce()
})
