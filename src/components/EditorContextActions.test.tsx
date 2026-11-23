// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentContextAttachment } from '../lib/ipc'
const { settings, addContext } = vi.hoisted(() => ({ settings: { agentEnabled: true }, addContext: vi.fn() }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: typeof settings) => unknown) => select(settings) }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({ addContext }) } }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { editorSelections } from '../editor/selectionRegistry'
import { terminalSelections } from '../lib/terminalSelection'
import { EditorContextActions } from './EditorContextActions'
import { TerminalContextAction } from './TerminalContextAction'
const disposers: Array<() => void> = []
const source = (text: string) => ({ root: '/repo', attachments: [{
  id: text, kind: 'terminal-selection', sourceRoot: '/repo', capturedAt: 1, text, label: 'Terminal', startupRel: '',
}] as AgentContextAttachment[] })
beforeEach(() => { vi.clearAllMocks(); settings.agentEnabled = true })
afterEach(() => { cleanup(); disposers.splice(0).forEach(dispose => dispose()) })

it('captures the requested editor group before menu focus and retains that snapshot for all actions', () => {
  let current = source('left')
  disposers.push(editorSelections.register('primary', () => current, () => true))
  disposers.push(editorSelections.register('secondary', () => source('right'), () => true))
  render(<EditorContextActions groupId="primary" />)
  fireEvent.mouseDown(screen.getByRole('button', { name: 'agent.context.add' }))
  fireEvent.click(screen.getByRole('button', { name: 'agent.context.add' }))
  current = source('changed after opening menu')
  fireEvent.click(screen.getByRole('button', { name: 'agent.context.explain' }))
  expect(addContext).toHaveBeenCalledWith('/repo', source('left').attachments, 'explain')
})

it('disables empty editor selection and hides the action when AI is disabled', () => {
  const { rerender } = render(<EditorContextActions groupId="primary" />)
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
  settings.agentEnabled = false
  rerender(<EditorContextActions groupId="primary" />)
  expect(screen.queryByRole('button')).toBeNull()
})

it('uses the active terminal reader and releases availability on teardown', () => {
  const first = terminalSelections.register('one', () => source('first'), () => true)
  const second = terminalSelections.register('two', () => source('second'), () => true)
  disposers.push(first, second)
  const { rerender } = render(<TerminalContextAction tabId="one" />)
  fireEvent.click(screen.getByRole('button'))
  expect(addContext).toHaveBeenLastCalledWith('/repo', source('first').attachments)
  rerender(<TerminalContextAction tabId="two" />)
  fireEvent.click(screen.getByRole('button'))
  expect(addContext).toHaveBeenLastCalledWith('/repo', source('second').attachments)
  act(() => second())
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true)
})
