// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../store/tabs'
import type { LiveInfo } from '../lib/ipc'
const { actions } = vi.hoisted(() => ({ actions: { start: vi.fn(), open: vi.fn(), refresh: vi.fn(), stop: vi.fn(), stopAll: vi.fn() } }))
vi.mock('../store/goLive', async () => {
  const { create } = await import('zustand')
  return { canGoLive: (tab?: Tab) => Boolean(tab?.kind === 'file' && /\.html?$/i.test(tab.rel)),
    useGoLive: create(() => ({ servers: [] as LiveInfo[], busy: false, ...actions })) }
})
vi.mock('../store/tabs', async () => {
  const { create } = await import('zustand')
  return { useTabs: create(() => ({ activeId: 'html', tabs: [] as Tab[] })) }
})
vi.mock('../store/workspace', async () => {
  const { create } = await import('zustand')
  return { useWorkspace: create(() => ({ roots: [] })) }
})
vi.mock('../store/settings', async () => {
  const { create } = await import('zustand')
  return { useSettings: create(() => ({ goLiveEnabled: true })) }
})
vi.mock('./Icon', () => ({ Icon: () => null }))
import { GoLive } from './GoLive'
import { useGoLive } from '../store/goLive'
import { useSettings } from '../store/settings'
import { useTabs } from '../store/tabs'
import { applyLocale, t } from '../i18n'
const file = { id: 'html', kind: 'file', root: '/repo', rel: 'index.html', name: 'index.html' } as Tab
const server: LiveInfo = { id: 'one', root: '/repo', rel: 'index.html', port: 5500, url: 'http://127.0.0.1:5500/one/index.html' }
beforeEach(() => {
  applyLocale('en'); vi.clearAllMocks()
  useTabs.setState({ activeId: 'html', tabs: [file] })
  useGoLive.setState({ servers: [], busy: false })
  useSettings.setState({ goLiveEnabled: true })
  actions.start.mockResolvedValue(server); actions.open.mockResolvedValue(undefined)
})
afterEach(cleanup)
it('does not request native state while idle and opens the started preview on click', async () => {
  render(<GoLive />)
  expect(actions.refresh).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: t('live.button') }))
  await waitFor(() => expect(actions.open).toHaveBeenCalledWith('one'))
  expect(actions.start).toHaveBeenCalledWith(file)
})
it('opens and closes the running list without starting another server, with separate stop controls', () => {
  useGoLive.setState({ servers: [server] })
  render(<GoLive />)
  fireEvent.click(screen.getByRole('button', { name: t('live.running') }))
  expect(screen.getByRole('dialog')).toBeTruthy()
  expect(screen.queryByText(/Local only/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: t('live.stop', { port: 5500 }) }))
  expect(actions.stop).toHaveBeenCalledWith('one')
  fireEvent.click(screen.getByRole('button', { name: t('live.running') }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(actions.start).not.toHaveBeenCalled()
})

it('hides the entry and stops running previews when disabled', () => {
  useGoLive.setState({ servers: [server] })
  render(<GoLive />)
  act(() => useSettings.setState({ goLiveEnabled: false }))
  expect(screen.queryByRole('button', { name: t('live.button') })).toBeNull()
  expect(screen.queryByRole('button', { name: t('live.running') })).toBeNull()
  expect(actions.stopAll).toHaveBeenCalledTimes(1)
})

it('does not mount controls or start services when disabled from the start', () => {
  useSettings.setState({ goLiveEnabled: false })
  render(<GoLive />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(actions.start).not.toHaveBeenCalled()
})
it('keeps the empty running list available for a non-HTML tab without launching services', () => {
  useTabs.setState({ tabs: [{ ...file, rel: 'index.ts' }] })
  render(<GoLive />)
  const button = screen.getByRole('button', { name: t('live.button') })
  expect(button.getAttribute('aria-disabled')).toBe('true')
  expect(button.classList.contains('cursor-not-allowed')).toBe(true)
  expect(button.getAttribute('data-tip')).toBe(t('live.selectHtml'))
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('button', { name: t('live.running') }))
  expect(screen.getByText(t('live.empty'))).toBeTruthy()
  expect(actions.start).not.toHaveBeenCalled()
})
