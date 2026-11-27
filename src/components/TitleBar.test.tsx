// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { state, actions } = vi.hoisted(() => ({
  state: {
    workspace: {
      roots: [{ id: '/repo', name: 'flash' }],
      activeRootId: '/repo' as string | null,
    },
    tabs: {
      tabs: [] as Array<{ id: string; root: string; rel: string }>,
      activeId: null as string | null,
    },
    settings: {
      sidebarVisible: true,
      agentEnabled: false,
    },
  },
  actions: {
    revealInExplorer: vi.fn(),
    newWindow: vi.fn(),
    openWelcome: vi.fn(),
    newChat: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: 'main' }),
}))
vi.mock('../store/workspace', () => ({
  IS_PRIMARY_WINDOW: true,
  useWorkspace: (select: (value: typeof state.workspace) => unknown) => select(state.workspace),
}))
vi.mock('../store/tabs', () => ({
  useTabs: Object.assign(
    (select: (value: typeof state.tabs) => unknown) => select(state.tabs),
    { getState: () => ({ openWelcome: actions.openWelcome }) },
  ),
}))
vi.mock('../store/settings', () => ({
  useSettings: (select: (value: typeof state.settings) => unknown) => select(state.settings),
}))
vi.mock('../store/agent', () => ({
  useAgent: { getState: () => ({ newChat: actions.newChat }) },
}))
vi.mock('../lib/useShortcut', () => ({
  useShortcut: () => '',
  useShortcutTip: (_id: string, fallback: string) => fallback,
}))
vi.mock('../lib/actions', () => ({
  newWindow: actions.newWindow,
  revealInExplorer: actions.revealInExplorer,
}))
vi.mock('../lib/paths', () => ({ isMac: () => false }))
vi.mock('../i18n', () => {
  const messages: Record<string, string> = {
    'titlebar.projectAria': 'Project {name}',
    'titlebar.agentTip': 'Ask agent ({shortcut})',
    'commands.agent.ask': 'Ask agent',
    'titlebar.newWindowTip': 'New window',
    'titlebar.welcomeTip': 'Welcome',
  }
  return {
    useT: () => (key: string, params: Record<string, string | number> = {}) =>
      (messages[key] ?? key).replace(/\{(\w+)\}/g, (_match: string, name: string) => String(params[name] ?? '')),
  }
})
vi.mock('./UpdateBadge', () => ({ UpdateBadge: () => null }))
vi.mock('./BreadcrumbMenu', () => ({ BreadcrumbMenu: () => null }))
vi.mock('./Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }))

import { revealInExplorer } from '../lib/actions'
import { TitleBar } from './TitleBar'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

it('keeps the project badge accessible without a hover tooltip', () => {
  render(<TitleBar />)

  const badge = screen.getByRole('button', { name: 'Project flash' })
  expect(badge.textContent).toBe('FL')
  expect(badge.hasAttribute('data-tip')).toBe(false)
  expect(badge.getAttribute('aria-label')).toBe('Project flash')

  fireEvent.click(badge)
  expect(revealInExplorer).toHaveBeenCalledWith('/repo', '', true)
})
