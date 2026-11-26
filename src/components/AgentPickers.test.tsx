// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentPermissionMode } from '../lib/ipc'
import { applyLocale, awaitCatalog, t } from '../i18n'

vi.mock('../store/agent', () => ({
  useAgent: (select: (state: unknown) => unknown) => select({
    providers: [
      { id: 'codex', name: 'Codex', installed: true, supported: true },
      { id: 'claude', name: 'Claude', installed: true, supported: true },
    ],
  }),
}))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('./Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }))

import { AgentPicker, PermissionPicker } from './AgentPickers'

beforeEach(() => applyLocale('en'))
afterEach(() => { cleanup(); applyLocale('en'); vi.restoreAllMocks(); vi.unstubAllGlobals() })

const modes: { value: AgentPermissionMode; icon: string }[] = [
  { value: 'read-only', icon: 'eye' },
  { value: 'workspace-write', icon: 'edit' },
  { value: 'full-access', icon: 'unlock' },
]

it.each(['en', 'zh-CN'] as const)('shows each permission name and updates its icon in %s', async locale => {
  await awaitCatalog(locale)
  applyLocale(locale)
  const onPick = vi.fn()
  const view = render(<PermissionPicker provider="codex" value="read-only" onPick={onPick} />)

  for (const { value, icon } of modes) {
    view.rerender(<PermissionPicker provider="codex" value={value} onPick={onPick} />)
    const label = t(`agent.permission.${value}`)
    const button = screen.getByRole('button', { name: label })
    expect(within(button).getByText(label)).toBeTruthy()
    expect(button.textContent).toBe(label)
    expect(button.getAttribute('data-tip')).toBe(label)
    expect(button.querySelector(`[data-icon="${icon}"]`)).toBeTruthy()
    expect(button.querySelector('[data-icon="chevron-down"]')).toBeTruthy()
  }
})

it.each(['codex', 'claude'] as const)('keeps %s permission descriptions and selects a new mode', provider => {
  const onPick = vi.fn()
  render(<PermissionPicker provider={provider} value="workspace-write" onPick={onPick} />)
  fireEvent.click(screen.getByRole('button', { name: t('agent.permission.workspace-write') }))

  for (const { value } of modes) {
    expect(screen.getByText(t(`agent.permission.${provider}.${value}`))).toBeTruthy()
  }
  const current = screen.getByRole('button', {
    name: name => name.includes(t('agent.permission.workspace-write')) &&
      name.includes(t(`agent.permission.${provider}.workspace-write`)),
  })
  expect((current as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', {
    name: name => name.includes(t('agent.permission.full-access')) &&
      name.includes(t(`agent.permission.${provider}.full-access`)),
  }))
  expect(onPick).toHaveBeenCalledExactlyOnceWith('full-access')
  expect(screen.queryByText(t(`agent.permission.${provider}.full-access`))).toBeNull()
})

it('keeps the current permission visible while disabled and does not open the menu', () => {
  const onPick = vi.fn()
  render(<PermissionPicker provider="codex" value="workspace-write" onPick={onPick} disabled />)
  const label = t('agent.permission.workspace-write')
  const button = screen.getByRole('button', { name: label })
  expect((button as HTMLButtonElement).disabled).toBe(true)
  expect(within(button).getByText(label)).toBeTruthy()
  fireEvent.click(button)
  expect(screen.queryByText(t('agent.permission.full-access'))).toBeNull()
  expect(onPick).not.toHaveBeenCalled()
})

it('preserves the compact icon-only agent picker and its accessible provider name', () => {
  const onPick = vi.fn()
  render(<AgentPicker value="codex" onPick={onPick} />)
  const label = `${t('agent.picker.agent')}: Codex`
  const button = screen.getByRole('button', { name: label })
  expect(button.textContent).toBe('')
  expect(button.querySelector('img')).toBeNull()
  expect(button.querySelector('[style*="mask-image"]')).toBeTruthy()
  expect(button.querySelector('[data-icon="chevron-down"]')).toBeNull()
  expect(button.getAttribute('data-tip')).toBe(label)
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('button', { name: 'Claude' }))
  expect(onPick).toHaveBeenCalledExactlyOnceWith('claude')
})

function mockPermissionSizes(initialAvailable: number, initialRequired: number) {
  const sizes = { available: initialAvailable, required: initialRequired }
  const callbacks = new Set<() => void>()
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const width = this.getAttribute('aria-hidden') === 'true' ? sizes.required : sizes.available
    return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: 24, width, height: 24, toJSON: () => ({}) }
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) { callbacks.add(callback) }
    observe() {}
    disconnect() { callbacks.delete(this.callback) }
  })
  return {
    resize(available: number, required = sizes.required) {
      sizes.available = available
      sizes.required = required
      act(() => { for (const callback of callbacks) callback() })
    },
    callbacks,
  }
}

it('hides the entire permission label when it cannot fit and restores it exactly at the fit boundary', () => {
  const { resize, callbacks } = mockPermissionSizes(120, 120)
  const onPick = vi.fn()
  const view = render(<PermissionPicker provider="codex" value="workspace-write" onPick={onPick} />)
  const label = t('agent.permission.workspace-write')
  const button = screen.getByRole('button', { name: label })
  expect(within(button).getByText(label)).toBeTruthy()

  resize(119.5)
  expect(button.textContent).toBe('')
  expect(button.querySelector('[data-icon="edit"]')).toBeTruthy()
  expect(button.querySelector('[data-icon="chevron-down"]')).toBeNull()
  expect(button.getAttribute('data-tip')).toBe(label)
  // Repeated notifications at the same width must keep the compact state stable.
  resize(119.5)
  expect(button.textContent).toBe('')
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('button', {
    name: name => name.includes(t('agent.permission.full-access')) &&
      name.includes(t('agent.permission.codex.full-access')),
  }))
  expect(onPick).toHaveBeenCalledExactlyOnceWith('full-access')

  resize(120)
  expect(within(button).getByText(label)).toBeTruthy()
  expect(button.querySelector('[data-icon="chevron-down"]')).toBeTruthy()
  view.unmount()
  expect(callbacks.size).toBe(0)
})

it('remeasures permission and locale changes and reacts to content width changes', async () => {
  await awaitCatalog('zh-CN')
  const { resize } = mockPermissionSizes(80, 100)
  const onPick = vi.fn()
  const view = render(<PermissionPicker provider="codex" value="workspace-write" onPick={onPick} />)
  expect(screen.getByRole('button').textContent).toBe('')

  resize(80, 60)
  view.rerender(<PermissionPicker provider="codex" value="read-only" onPick={onPick} />)
  expect(screen.getByRole('button').textContent).toBe(t('agent.permission.read-only'))

  act(() => applyLocale('zh-CN'))
  const button = screen.getByRole('button', { name: t('agent.permission.read-only') })
  expect(within(button).getByText(t('agent.permission.read-only'))).toBeTruthy()
  // A font/content change can require compact mode even when the slot width stays unchanged.
  resize(80, 90)
  expect(button.textContent).toBe('')
  resize(80, 80)
  expect(within(button).getByText(t('agent.permission.read-only'))).toBeTruthy()
})
