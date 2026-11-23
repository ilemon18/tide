// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { assignShortcuts, startShortcutRecording } from './shortcuts'
const { state, ui, run, terminal } = vi.hoisted(() => ({
  state: { shortcutOverrides: {} as Record<string, string[]> }, ui: { overlay: null, confirmReq: null, promptReq: null },
  run: vi.fn(), terminal: { focused: false },
}))
vi.mock('../store/settings', () => ({ useSettings: { getState: () => state } }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ui } }))
vi.mock('../store/terminal', () => ({ terminalFocused: () => terminal.focused }))
vi.mock('./paths', () => ({ isMac: () => true }))
vi.mock('./commands', () => ({ commandAvailable: () => true,
  buildCommands: () => ['agent.ask', 'file.save', 'view.commands', 'tree.rename', 'editor.zoomIn', 'view.wordWrap'].map(id => ({ id, run: () => run(id) })) }))
import { dispatchShortcut } from './shortcutDispatch'

afterEach(() => { state.shortcutOverrides = {}; ui.overlay = null; ui.confirmReq = null; ui.promptReq = null;
  terminal.focused = false; document.body.innerHTML = ''; vi.clearAllMocks() })
const press = (key: string, options: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true, ...options })
  const element = document.activeElement instanceof HTMLElement ? document.activeElement : document.body
  element.addEventListener('keydown', dispatchShortcut, { once: true })
  element.dispatchEvent(event)
  return event
}

it('opens Agent in an input, keeps native select-all, and requires exact modifiers', () => {
  const input = document.createElement('input'); document.body.append(input); input.focus()
  expect(press('a').defaultPrevented).toBe(false)
  expect(press('A', { shiftKey: true }).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledExactlyOnceWith('agent.ask')
  expect(press('A', { shiftKey: true, altKey: true }).defaultPrevented).toBe(false)
})

it('executes only the new owner and disables old bindings immediately', () => {
  state.shortcutOverrides = assignShortcuts('agent.ask', ['Mod+s'], {}, true)
  press('s')
  expect(run).toHaveBeenCalledExactlyOnceWith('agent.ask')
  expect(press('A', { shiftKey: true }).defaultPrevented).toBe(false)
})

it('records before dispatch and prevents other key handlers, including Escape', () => {
  const record = vi.fn(), bubble = vi.fn()
  const stop = startShortcutRecording(record)
  window.addEventListener('keydown', dispatchShortcut, true)
  window.addEventListener('keydown', bubble)
  try {
    press('s'); press('Escape', { metaKey: false })
    expect(record).toHaveBeenCalledTimes(2)
    expect(run).not.toHaveBeenCalled()
    expect(bubble).not.toHaveBeenCalled()
  } finally { stop(); window.removeEventListener('keydown', dispatchShortcut, true); window.removeEventListener('keydown', bubble) }
})

it('respects modal state, tree focus and terminal-owned font input', () => {
  ui.overlay = 'commands' as never
  expect(press('A', { shiftKey: true }).defaultPrevented).toBe(false)
  ui.overlay = null
  expect(press('r').defaultPrevented).toBe(false)
  const tree = document.createElement('div'); tree.setAttribute('data-shortcut-tree', ''); tree.tabIndex = 0
  document.body.append(tree); tree.focus()
  expect(press('r').defaultPrevented).toBe(true)
  terminal.focused = true
  expect(press('=').defaultPrevented).toBe(false)
})

it('handles editor Option bindings inside CodeMirror while preserving ordinary text fields', () => {
  const editor = document.createElement('div'); editor.className = 'cm-editor'
  const content = document.createElement('div'); content.setAttribute('contenteditable', 'true'); content.tabIndex = 0
  editor.append(content); document.body.append(editor); content.focus()
  expect(press('z', { metaKey: false, altKey: true, code: 'KeyZ' }).defaultPrevented).toBe(true)
  expect(run).toHaveBeenCalledExactlyOnceWith('view.wordWrap')
  const input = document.createElement('input'); document.body.append(input); input.focus()
  expect(press('z', { metaKey: false, altKey: true, code: 'KeyZ' }).defaultPrevented).toBe(false)
})
