import { COMMANDS } from './commandRegistry'
import { buildCommands, commandAvailable } from './commands'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { terminalFocused } from '../store/terminal'
import { isMac } from './paths'
import { captureShortcutRecording, resolveShortcuts, shortcutFromEvent, shortcutIdentity } from './shortcuts'

export function dispatchShortcut(event: KeyboardEvent): boolean {
  if (captureShortcutRecording(event)) return true
  if (event.defaultPrevented || event.key === 'Escape') return false
  const ui = useUi.getState()
  if (ui.confirmReq || ui.promptReq || ui.overlay) return false
  const mac = isMac()
  const key = shortcutFromEvent(event, mac)
  if (!key) return false
  // Candidate selection/composition always owns ordinary text. Modified app shortcuts remain usable
  // with WebKit's Process events, just as they were before customization.
  if ((event.isComposing || event.keyCode === 229) && !event.metaKey && !event.ctrlKey) return false
  const identity = shortcutIdentity(key, mac)
  const resolved = resolveShortcuts(useSettings.getState().shortcutOverrides, mac)
  const definition = COMMANDS.find(command => resolved[command.id]?.some(binding => shortcutIdentity(binding, mac) === identity))
  if (!definition || !commandAvailable(definition.id)) return false
  if (definition.id === 'context.openOrLatest' && (event.isComposing || event.keyCode === 229)) return false
  const target = event.target instanceof Element ? event.target : null
  const terminal = terminalFocused()
  const field = target?.closest('input, textarea, [contenteditable="true"]')
  const editor = target?.closest('.cm-editor')
  if (field && !editor && !event.metaKey && !event.ctrlKey && !/^F[0-9]+$/.test(event.key)) return false
  if (definition.scope === 'editor') {
    if (terminal || (field && !editor)) return false
  }
  if (definition.scope === 'tree' && !target?.closest('[data-shortcut-tree]')) return false
  if (definition.scope === 'terminal' && !terminal) return false
  // Ctrl+U is readline/native field editing on Ctrl platforms.
  if (definition.id === 'view.structure' && !event.metaKey && event.ctrlKey && (terminal || field)) return false
  if (event.repeat && ['agent.ask', 'tab.closeCurrent', 'tab.close', 'tab.newCurrent', 'context.openOrLatest', 'tree.delete'].includes(definition.id)) return false
  const command = buildCommands(false, definition.id.startsWith('agent.context.')).find(command => command.id === definition.id)
  if (!command) return false
  event.preventDefault()
  event.stopPropagation()
  void Promise.resolve(command.run()).catch(error => console.error('Shortcut command failed', error))
  return true
}
