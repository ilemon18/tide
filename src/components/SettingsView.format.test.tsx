// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FormatToolInfo } from '../lib/ipc'

const { confirm, toast, patch, formatToolInfo, formatToolInstall, formatToolUpdate } = vi.hoisted(() => ({
  confirm: vi.fn().mockResolvedValue(true),
  toast: vi.fn(),
  patch: vi.fn(),
  formatToolInfo: vi.fn(),
  formatToolInstall: vi.fn(),
  formatToolUpdate: vi.fn(),
}))

vi.mock('../store/settings', async () => {
  const { create } = await import('zustand')
  return {
    useSettings: create(() => ({
      lightweightMode: false, locale: 'en', theme: 'tide', fontFamily: 'default', uiFontSize: 13,
      fontSize: 14, ligatures: false, autoSave: false, wordWrap: true, tabSize: 4, formatMode: 'off',
      formatTool: 'auto', inlineBlame: false, indentGuides: false, trimTrailingWhitespace: false,
      insertFinalNewline: true, iconTheme: 'default', showHidden: false, compactFolders: false,
      terminalFontSize: 13, terminalScrollback: 2000, terminalWebgl: false, agentEnabled: true,
      tasksEnabled: true, agentDefaultProvider: '', agentDefaultModel: '', agentDefaultEffort: '',
      agentDefaultPermissionMode: 'workspace-write', agentHistoryEnabled: true, autoUpdate: false,
      activityBarWelcomeVisible: true, activityBarGitVisible: true, activityBarStructureVisible: true,
      patch,
    })),
  }
})
vi.mock('../store/ui', async () => {
  const { create } = await import('zustand')
  const useUi = create(() => ({
    settingsSection: 'editor' as const,
    setSettingsSection: vi.fn(),
    toast,
    confirm,
  }))
  return { useUi }
})
vi.mock('../store/workspace', async () => {
  const { create } = await import('zustand')
  return { useWorkspace: create(() => ({ roots: [], activeRootId: null })) }
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
vi.mock('../lib/ipc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/ipc')>()
  return {
    ...actual,
    api: {
      ...actual.api,
      formatToolInfo,
      formatToolInstall,
      formatToolUpdate,
    },
  }
})
vi.mock('./Icon', () => ({ Icon: () => <span /> }))
vi.mock('./TideMark', () => ({ TideMark: () => <span /> }))
vi.mock('./AgentProviderIcon', () => ({ AgentProviderIcon: () => <span /> }))
vi.mock('./ShortcutSettings', () => ({ ShortcutSettings: () => <div /> }))

import { SettingsView } from './SettingsView'
import { applyLocale } from '../i18n'
import { useSettings } from '../store/settings'

const info = (overrides: Partial<FormatToolInfo>): FormatToolInfo => ({
  id: 'rustfmt',
  label: 'rustfmt',
  installed: true,
  source: 'system',
  version: '1.9.0-stable',
  language: 'rust',
  languageInstalled: true,
  languageVersion: '1.95.0',
  canInstall: false,
  canUpdate: true,
  installKind: 'rustup',
  ...overrides,
})

const infoFor = (id: string): FormatToolInfo => {
  if (id === 'prettier') return info({ id, label: 'Prettier', source: 'bundled', version: null, language: 'node', languageVersion: null, canUpdate: false, installKind: 'bundled' })
  if (id === 'gofmt') return info({ id, label: 'gofmt', installed: false, version: null, language: 'go', languageInstalled: false, languageVersion: null, canUpdate: false, installKind: 'manual' })
  if (id === 'black') return info({ id, label: 'Black', installed: true, language: 'python', version: '25.1.0', installKind: 'pip' })
  return info({ id })
}

const allInfos = () => {
  formatToolInfo.mockImplementation(async (id: string) => infoFor(id))
}

let originalScrollTo: PropertyDescriptor | undefined
beforeEach(() => {
  applyLocale('en')
  originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTo')
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: vi.fn() })
  vi.clearAllMocks()
  confirm.mockResolvedValue(true)
  allInfos()
  useSettings.setState({ formatTool: 'auto', formatMode: 'off' })
})
afterEach(() => {
  cleanup()
  if (originalScrollTo) Object.defineProperty(HTMLElement.prototype, 'scrollTo', originalScrollTo)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
})

it('installs a missing formatter and enables manual mode after confirmation', async () => {
  formatToolInfo.mockImplementation(async (id: string) =>
    id === 'rustfmt'
      ? info({ id, installed: false, version: null, canInstall: true })
      : infoFor(id),
  )
  render(<SettingsView />)
  const rustfmt = await screen.findByRole('button', { name: /rustfmt/ })
  await waitFor(() => expect((rustfmt.textContent ?? '')).toContain('Not installed'))
  fireEvent.click(rustfmt)
  await waitFor(() => expect(formatToolInstall).toHaveBeenCalledWith('rustfmt'))
  expect(confirm).toHaveBeenCalled()
  expect(patch).toHaveBeenCalledWith({ formatTool: 'rustfmt', formatMode: 'manual' })
})

it('does not install when the language environment is missing', async () => {
  render(<SettingsView />)
  const gofmt = await screen.findByRole('button', { name: /gofmt/ })
  await waitFor(() => expect((gofmt.textContent ?? '')).toContain('Not installed'))
  fireEvent.click(gofmt)
  await waitFor(() => expect(confirm).toHaveBeenCalled())
  expect(formatToolInstall).not.toHaveBeenCalled()
})

it('asks to update when the currently selected installed formatter is clicked', async () => {
  useSettings.setState({ formatTool: 'rustfmt', formatMode: 'manual' })
  formatToolUpdate.mockResolvedValue(info({ id: 'rustfmt', version: '1.9.1-stable' }))
  render(<SettingsView />)
  const rustfmt = await screen.findByRole('button', { name: /rustfmt/ })
  await waitFor(() => expect((rustfmt.textContent ?? '')).toContain('1.9.0-stable'))
  fireEvent.click(rustfmt)
  await waitFor(() => expect(formatToolUpdate).toHaveBeenCalledWith('rustfmt'))
  expect(confirm).toHaveBeenCalled()
})
