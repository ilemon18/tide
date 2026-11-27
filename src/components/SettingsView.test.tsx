// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SettingsSectionId } from '../lib/settingsSections'

vi.mock('../store/settings', async () => {
  const { create } = await import('zustand')
  return { useSettings: create(() => ({
    lightweightMode: false, locale: 'en', theme: 'tide', fontFamily: 'default', uiFontSize: 13,
    fontSize: 14, ligatures: false, autoSave: false, wordWrap: true, tabSize: 4, formatMode: 'off',
    formatTool: 'auto', inlineBlame: false, indentGuides: false, trimTrailingWhitespace: false,
    insertFinalNewline: true, iconTheme: 'default', showHidden: false, compactFolders: false,
    terminalFontSize: 13, terminalScrollback: 2000, terminalWebgl: false, agentEnabled: true, tasksEnabled: true,
    agentDefaultProvider: '', agentDefaultModel: '', agentDefaultEffort: '',
    agentDefaultPermissionMode: 'workspace-write', agentHistoryEnabled: true, autoUpdate: false,
    configBackupEnabled: false, configBackupFolder: '', configBackupInterval: 'daily', configBackupMode: 'dated', configBackupLastAt: 0,
    activityBarWelcomeVisible: true, activityBarGitVisible: true, activityBarStructureVisible: true,
    patch: vi.fn(),
  })) }
})
vi.mock('../store/ui', async () => {
  const { create } = await import('zustand')
  const useUi = create(() => ({
    settingsSection: 'general' as SettingsSectionId,
    setSettingsSection: (settingsSection: SettingsSectionId) => useUi.setState({ settingsSection }),
    toast: vi.fn(),
  }))
  return { useUi }
})
vi.mock('../store/agent', async () => {
  const { create } = await import('zustand')
  return { useAgent: create(() => ({
    providers: [], providersLoading: false, catalogs: {},
    loadProviders: vi.fn().mockResolvedValue(undefined), loadCatalog: vi.fn().mockResolvedValue(undefined),
  })) }
})
vi.mock('../store/update', async () => {
  const { create } = await import('zustand')
  return { useUpdate: create(() => ({
    status: 'idle', info: null, percent: 0, error: null, installedTo: '',
    check: vi.fn(), download: vi.fn(), install: vi.fn(), openPage: vi.fn(),
  })) }
})
vi.mock('../lib/update', () => ({
  updateApi: { appVersion: vi.fn().mockResolvedValue('1.0.0'), openPage: vi.fn() },
}))
vi.mock('./Icon', () => ({ Icon: () => <span /> }))
vi.mock('./TideMark', () => ({ TideMark: () => <span /> }))
vi.mock('./AgentProviderIcon', () => ({ AgentProviderIcon: () => <span /> }))

import { SettingsView } from './SettingsView'
import { ACTIVITY_BAR_ITEMS } from '../lib/activityBar'
import { applyLocale, t } from '../i18n'
import { useUi } from '../store/ui'
import { useSettings } from '../store/settings'
import { useUpdate } from '../store/update'

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
beforeEach(() => {
  applyLocale('en')
  useUi.setState({ settingsSection: 'general' })
  useUpdate.setState({ status: 'idle', info: null, percent: 0, error: null, installedTo: '' })
  vi.clearAllMocks()
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
})
afterEach(() => {
  cleanup()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

function selectSection(section: SettingsSectionId) {
  fireEvent.click(screen.getByRole('button', { name: t(`settings.section.${section}.label`) }))
}

it('exposes one Tasks and Problems switch in the activity bar card', () => {
  render(<SettingsView />)
  const card = screen.getByRole('heading', { name: t('settings.activityBar.card') }).closest('section')!
  const toggles = within(card).getAllByRole('button', { name: t('activity.tasksTip') })
  expect(toggles).toHaveLength(1)
  expect(toggles[0].getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(toggles[0])
  expect(useSettings.getState().patch).toHaveBeenCalledExactlyOnceWith({ tasksEnabled: false })
})

it('exposes activity bar visibility toggles under General', () => {
  render(<SettingsView />)
  const card = screen.getByRole('heading', { name: t('settings.activityBar.card') }).closest('section')!
  for (const item of ACTIVITY_BAR_ITEMS) {
    const toggle = within(card).getByRole('button', { name: t(item.labelKey) })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  }
  fireEvent.click(within(card).getByRole('button', { name: t('activity.welcomeTip') }))
  expect(useSettings.getState().patch).toHaveBeenCalledExactlyOnceWith({ activityBarWelcomeVisible: false })
})

it('places the history preference under Agent and patches it when toggled', () => {
  render(<SettingsView />)
  selectSection('agent')
  const toggle = screen.getByRole('button', { name: t('settings.agent.history') })
  expect(toggle.getAttribute('aria-pressed')).toBe('true')
  fireEvent.click(toggle)
  expect(useSettings.getState().patch).toHaveBeenCalledExactlyOnceWith({ agentHistoryEnabled: false })

  selectSection('about')
  expect(screen.queryByText(t('settings.agent.history'))).toBeNull()
})

it('places automatic updates in the About update card and removes them from General', () => {
  render(<SettingsView />)
  expect(screen.queryByText(t('settings.about.autoUpdate'))).toBeNull()

  selectSection('about')
  const card = screen.getByRole('heading', { name: t('settings.about.updates') }).closest('section')!
  const toggle = within(card).getByRole('button', { name: t('settings.about.autoUpdate') })
  expect(toggle.getAttribute('aria-pressed')).toBe('false')
  expect(within(card).getByRole('button', { name: t('settings.about.checkUpdates') })).toBeTruthy()
  fireEvent.click(toggle)
  expect(useSettings.getState().patch).toHaveBeenCalledExactlyOnceWith({ autoUpdate: true })

  selectSection('general')
  expect(screen.queryByText(t('settings.about.autoUpdate'))).toBeNull()
})

it.each(['checking', 'downloading', 'installing'] as const)('shows the %s state once in the update card', status => {
  useUpdate.setState({ status, percent: 42 })
  render(<SettingsView />)
  selectSection('about')
  const card = screen.getByRole('heading', { name: t('settings.about.updates') }).closest('section')!
  const label = status === 'downloading' ? t('update.downloading', { percent: 42 })
    : t(status === 'checking' ? 'settings.about.checking' : 'settings.about.installing')
  expect(within(card).getAllByText(label)).toHaveLength(1)
  expect(within(card).getByRole('button', { name: label }).getAttribute('aria-busy')).toBe('true')
  if (status === 'installing') expect(within(card).getByText(t('settings.about.restartAfterInstall'))).toBeTruthy()
})

it('omits the downloaded instruction when the install button already expresses it', () => {
  useUpdate.setState({ status: 'ready' })
  render(<SettingsView />)
  selectSection('about')
  expect(screen.getByRole('button', { name: t('settings.about.install') })).toBeTruthy()
  expect(screen.queryByText(t('settings.about.downloaded'))).toBeNull()
})

it('removes the default permission picker and explanation from Agent settings', () => {
  render(<SettingsView />)
  selectSection('agent')
  expect(screen.queryByText('Default permissions')).toBeNull()
  expect(screen.queryByRole('heading', { name: 'Permissions' })).toBeNull()
  expect(screen.queryByText(/Choose permissions per chat/)).toBeNull()
  expect(screen.queryByRole('button', { name: t('agent.permission.workspace-write') })).toBeNull()
  expect(screen.getByText(t('settings.agent.defaultAgent'))).toBeTruthy()
  expect(screen.getByText(t('settings.agent.defaultModel'))).toBeTruthy()
  expect(screen.getByText(t('settings.agent.defaultComplexity'))).toBeTruthy()
})

it('places configuration export above About and keeps automatic sync disabled initially', () => {
  render(<SettingsView />)
  const config = screen.getByRole('button', { name: t('settings.section.config.label') })
  const about = screen.getByRole('button', { name: t('settings.section.about.label') })
  expect(config.compareDocumentPosition(about) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  fireEvent.click(config)
  expect(screen.getByRole('switch', { name: t('config.automatic') }).getAttribute('aria-checked')).toBe('false')
  expect(screen.getByRole('button', { name: t('config.export') })).toBeTruthy()
  expect(screen.getByRole('button', { name: t('config.importFile') })).toBeTruthy()
})
it('shows incoming release notes from the update manifest in About', () => {
  useUpdate.setState({ info: { available: true, hasRelease: true, current: '1.0.0', latest: '9.0.0', publishedAt: '2026-11-27', notes: '- Export preferences to JSON' } as never })
  render(<SettingsView />)
  selectSection('about')
  expect(screen.getByRole('heading', { name: t('settings.about.changelog') })).toBeTruthy()
  expect(screen.getByText('Export preferences to JSON')).toBeTruthy()
})

it('does not show release notes while up to date or before checking updates', () => {
  render(<SettingsView />)
  selectSection('about')
  expect(screen.queryByRole('heading', { name: t('settings.about.changelog') })).toBeNull()
  act(() => useUpdate.setState({ info: { available: false, hasRelease: true, current: '1.0.0', latest: '1.0.0', publishedAt: '2026-11-27', notes: '- Old changes' } as never }))
  expect(screen.queryByRole('heading', { name: t('settings.about.changelog') })).toBeNull()
})
