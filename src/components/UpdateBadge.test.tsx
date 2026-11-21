// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateInfo } from '../lib/update'
import type { UpdateStatus } from '../store/update'

vi.mock('../store/update', async () => {
  const { create } = await import('zustand')
  return { useUpdate: create(() => ({
    status: 'available' as UpdateStatus,
    debugBuild: false as boolean | null,
    manual: false,
    info: null as UpdateInfo | null,
    percent: 0,
    error: null as string | null,
    installedTo: '',
    download: vi.fn(), install: vi.fn(), check: vi.fn(), openPage: vi.fn(),
  })) }
})
vi.mock('../i18n', async () => {
  const { en } = await import('../i18n/messages/en')
  const t = (key: keyof typeof en, params: Record<string, string | number> = {}) =>
    en[key].replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ''))
  return { t, useT: () => t }
})

import { useUpdate } from '../store/update'
import { UpdateBadge } from './UpdateBadge'

beforeEach(() => {
  vi.clearAllMocks()
  useUpdate.setState({
    status: 'available', debugBuild: false, manual: false, percent: 0, error: null, installedTo: '',
    info: { available: true, latest: '1.1.0', downloadUrl: 'https://github.com/tide/update.exe', assetSize: 1024 } as UpdateInfo,
  })
})
afterEach(cleanup)

it('shows the update action as visible text and starts it on click', () => {
  render(<UpdateBadge primary />)
  const button = screen.getByRole('button', { name: /Download update/ })
  expect(button.querySelector('span:not(.sr-only)')?.textContent).toBe('Download update')
  fireEvent.click(button)
  expect(useUpdate.getState().download).toHaveBeenCalledOnce()
})

it('renders a separate circular progress indicator with space around the text', () => {
  useUpdate.setState({ status: 'downloading', percent: 42 })
  render(<UpdateBadge primary />)
  const button = screen.getByRole('button', { name: 'Downloading 42%' })
  const svg = button.querySelector('svg')!
  expect(svg.getAttribute('width')).toBe('16')
  expect(svg.getAttribute('height')).toBe('16')
  expect(svg.querySelectorAll('circle')).toHaveLength(2)
  expect(svg.querySelector('circle[pathLength]')?.getAttribute('stroke-dashoffset')).toBe('58')
  expect(button.querySelector('span:not(.sr-only)')?.textContent).toBe('Downloading 42%')
  expect(svg.parentElement).toBe(button)
  expect(button.classList.contains('gap-2')).toBe(true)
  expect(button.classList.contains('px-2')).toBe(true)
  expect(button.getAttribute('aria-disabled')).toBe('true')
  fireEvent.click(button)
  expect(useUpdate.getState().download).not.toHaveBeenCalled()
  expect(screen.getByRole('status').textContent).toBe('Downloading 40%')

  act(() => useUpdate.setState({ percent: 100 }))
  expect(svg.querySelector('circle[pathLength]')?.getAttribute('stroke-dashoffset')).toBe('0')
})

it('disables the action during installation and restores retry after failure', () => {
  useUpdate.setState({ status: 'installing' })
  render(<UpdateBadge primary />)
  fireEvent.click(screen.getByRole('button'))
  expect(useUpdate.getState().install).not.toHaveBeenCalled()
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  act(() => useUpdate.setState({ status: 'error', error: 'Network failed' }))
  const retry = screen.getByRole('button', { name: 'Network failed' })
  expect(retry.querySelector('span:not(.sr-only)')?.textContent).toBe('Retry')
  fireEvent.click(retry)
  expect(useUpdate.getState().download).toHaveBeenCalledOnce()
})

it.each([
  [false, false, 'available'],
  [true, true, 'available'],
  [true, null, 'available'],
  [true, false, 'idle'],
  [true, false, 'uptodate'],
  [true, false, 'checking'],
] as const)('hides for primary=%s debug=%s status=%s', (primary, debugBuild, status) => {
  useUpdate.setState({ debugBuild, status })
  render(<UpdateBadge primary={primary} />)
  expect(screen.queryByRole('button')).toBeNull()
})

it('shows manual checks and offers the release page when no installer exists', () => {
  useUpdate.setState({ status: 'checking', manual: true })
  render(<UpdateBadge primary />)
  expect(screen.getByRole('button').getAttribute('aria-busy')).toBe('true')
  act(() => useUpdate.setState({ status: 'available', info: { ...useUpdate.getState().info!, downloadUrl: '' } }))
  fireEvent.click(screen.getByRole('button'))
  expect(useUpdate.getState().openPage).toHaveBeenCalledOnce()
  expect(useUpdate.getState().download).not.toHaveBeenCalled()
})
