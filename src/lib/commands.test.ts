import { afterEach, expect, it, vi } from 'vitest'
const { state, addContext } = vi.hoisted(() => ({
  state: { agentEnabled: true, activeGroupId: 'primary', activeId: 'terminal', visible: true }, addContext: vi.fn(),
}))
vi.mock('./actions', () => ({ closeWorkspaceDialog: vi.fn(), newEntry: vi.fn(), newWindow: vi.fn(),
  openFolderDialog: vi.fn(), openSettings: vi.fn(), openTerminalHere: vi.fn(), removeRoot: vi.fn(), toggleSidebar: vi.fn(), toggleTerminal: vi.fn() }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => state } }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('../store/settings', () => ({ useSettings: { getState: () => state } }))
vi.mock('../store/git', () => ({ useGit: { getState: () => ({}) } }))
vi.mock('../store/workspace', () => ({ activeRoot: () => ({ id: '/repo' }), useWorkspace: { getState: () => ({}) } }))
vi.mock('../store/terminal', () => ({ useTerminal: { getState: () => state } }))
vi.mock('../store/search', () => ({ useSearch: { getState: () => ({}) } }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ addContext }) } }))
import { editorSelections } from '../editor/selectionRegistry'
import { terminalSelections } from './terminalSelection'
import { buildCommands } from './commands'
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); state.agentEnabled = true; vi.clearAllMocks() })

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
