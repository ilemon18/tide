// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ShortcutOverrides } from '../lib/shortcuts'
vi.mock('../store/settings', async () => {
  const { create } = await import('zustand')
  const useSettings = create(() => ({ shortcutOverrides: {} as ShortcutOverrides,
    patch: (patch: { shortcutOverrides: ShortcutOverrides }) => useSettings.setState(patch) }))
  return { useSettings }
})
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
vi.mock('../lib/paths', () => ({ isMac: () => true }))
import { ShortcutSettings } from './ShortcutSettings'
import { useShortcut } from '../lib/useShortcut'
import { useSettings } from '../store/settings'
import { applyLocale, t } from '../i18n'

beforeEach(() => { applyLocale('en'); useSettings.setState({ shortcutOverrides: {} }) })
afterEach(cleanup)
const row = (container: HTMLElement, id: string) => within(container.querySelector<HTMLElement>('[data-command-id="' + id + '"]')!)

it('records, previews a conflict, and transfers ownership only when saved', () => {
  const { container } = render(<ShortcutSettings />)
  fireEvent.click(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.editBinding', { keys: '⌘⇧A' }) }))
  fireEvent.keyDown(window, { key: 'P', code: 'KeyP', metaKey: true, shiftKey: true })
  expect(screen.getByText(t('shortcuts.conflict', { commands: t('shortcuts.action.view.commands') }))).toBeTruthy()
  expect(useSettings.getState().shortcutOverrides).toEqual({})
  fireEvent.click(screen.getByRole('button', { name: t('shortcuts.save') }))
  expect(useSettings.getState().shortcutOverrides).toEqual({ 'view.commands': [], 'agent.ask': ['Mod+Shift+p'] })
  expect(row(container, 'view.commands').getByText(t('shortcuts.unbound'))).toBeTruthy()
  expect(document.activeElement).toBe(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.editBinding', { keys: '⌘⇧P' }) }))
})

it('keeps reserved keys out, cancels with Escape and releases the recording listener on unmount', () => {
  const { container, unmount } = render(<ShortcutSettings />)
  fireEvent.click(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.add') }))
  fireEvent.keyDown(window, { key: 'a', metaKey: true })
  expect(screen.getByText(t('shortcuts.invalid'))).toBeTruthy()
  expect((screen.getByRole('button', { name: t('shortcuts.save') }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(useSettings.getState().shortcutOverrides).toEqual({})
  fireEvent.click(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.add') }))
  unmount()
  const event = new KeyboardEvent('keydown', { key: 's', metaKey: true, cancelable: true })
  window.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(false)
})

it('searches ids and keys, removes a single alias and restores default ownership', () => {
  const { container } = render(<ShortcutSettings />)
  fireEvent.click(row(container, 'tree.rename').getByRole('button', { name: t('shortcuts.removeBinding', { keys: 'F2' }) }))
  expect(useSettings.getState().shortcutOverrides['tree.rename']).toEqual(['Mod+r'])
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'tree.rename' } })
  expect(container.querySelectorAll('[data-command-id]')).toHaveLength(1)
  fireEvent.click(row(container, 'tree.rename').getByRole('button', { name: t('shortcuts.reset') }))
  expect(useSettings.getState().shortcutOverrides['tree.rename']).toBeUndefined()
  expect(row(container, 'tree.rename').getByText('F2')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: t('shortcuts.resetAll') }))
  expect(useSettings.getState().shortcutOverrides).toEqual({})
})

it('updates mounted shortcut hints immediately after external settings changes', () => {
  function Hint() { return <span data-testid="hint">{useShortcut('agent.ask')}</span> }
  render(<Hint />)
  expect(screen.getByTestId('hint').textContent).toBe('⌘⇧A')
  act(() => useSettings.setState({ shortcutOverrides: { 'agent.ask': ['Mod+Shift+i'] } }))
  expect(screen.getByTestId('hint').textContent).toBe('⌘⇧I')
  act(() => useSettings.setState({ shortcutOverrides: { 'agent.ask': [] } }))
  expect(screen.getByTestId('hint').textContent).toBe('')
})

it('opens a portal with the action, scope and original binding, focuses the recorder and returns focus on cancel', () => {
  const { container } = render(<ShortcutSettings />)
  const trigger = row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.editBinding', { keys: '⌘⇧A' }) })
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog', { name: t('shortcuts.recordTitle') })
  expect(container.contains(dialog)).toBe(false)
  expect(dialog.getAttribute('aria-modal')).toBe('true')
  expect(within(dialog).getByText(t('commands.agent.ask'))).toBeTruthy()
  expect(within(dialog).getByText(t('shortcuts.scope.app'))).toBeTruthy()
  expect(within(dialog).getByText(t('shortcuts.currentBinding', { keys: '⌘⇧A' }))).toBeTruthy()
  expect(document.activeElement).toBe(within(dialog).getByRole('textbox'))
  fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(useSettings.getState().shortcutOverrides).toEqual({})
})

it('keeps Tab navigation inside the dialog and records only while the recording field has focus', () => {
  const { container } = render(<ShortcutSettings />)
  fireEvent.click(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.add') }))
  const dialog = screen.getByRole('dialog')
  const input = within(dialog).getByRole('textbox') as HTMLInputElement
  fireEvent.keyDown(input, { key: 'k', code: 'KeyK', metaKey: true, shiftKey: true })
  expect(input.value).toBe('⌘⇧K')
  fireEvent.keyDown(input, { key: 'Tab' })
  const cancel = within(dialog).getByRole('button', { name: t('common.cancel') })
  expect(document.activeElement).toBe(cancel)
  fireEvent.keyDown(cancel, { key: 'p', code: 'KeyP', metaKey: true })
  expect(input.value).toBe('⌘⇧K')
  fireEvent.keyDown(cancel, { key: 'Tab' })
  const save = within(dialog).getByRole('button', { name: t('shortcuts.save') })
  expect(document.activeElement).toBe(save)
  const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  save.dispatchEvent(enter)
  expect(enter.defaultPrevented).toBe(false)
  fireEvent.keyDown(save, { key: 'Tab' })
  expect(document.activeElement).toBe(input)
  fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(save)
  fireEvent.click(save)
  expect(useSettings.getState().shortcutOverrides['agent.ask']).toEqual(['Mod+Shift+a', 'Mod+Shift+k'])
})

it('discards a recording on backdrop click and retains the candidate through modifier and repeated events', () => {
  const { container } = render(<ShortcutSettings />)
  fireEvent.click(row(container, 'agent.ask').getByRole('button', { name: t('shortcuts.add') }))
  const input = within(screen.getByRole('dialog')).getByRole('textbox') as HTMLInputElement
  fireEvent.keyDown(input, { key: 'k', code: 'KeyK', metaKey: true })
  fireEvent.keyDown(input, { key: 'Shift', shiftKey: true })
  fireEvent.keyDown(input, { key: 'p', code: 'KeyP', metaKey: true, repeat: true })
  expect(input.value).toBe('⌘K')
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(useSettings.getState().shortcutOverrides).toEqual({})
})
