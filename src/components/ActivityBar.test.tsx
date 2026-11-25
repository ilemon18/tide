// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ActivityBarVisibility } from '../lib/activityBar'

const { state, actions } = vi.hoisted(() => ({
  state: {
    git: { statuses: {} as Record<string, unknown>, busy: null as string | null },
    workspace: {
      roots: [{ id: '/repo', name: 'Repo', isGitRepo: true }],
      activeRootId: '/repo' as string | null,
    },
    terminal: { visible: false },
    tasks: { problems: { '/repo': [] as unknown[] } },
    settings: {
      patch: vi.fn(),
    },
  },
  actions: {
    openWelcome: vi.fn(),
    toggleTerminal: vi.fn(),
  },
}))

vi.mock('../store/git', () => ({ useGit: (select: (value: typeof state.git) => unknown) => select(state.git) }))
vi.mock('../store/workspace', () => ({
  useWorkspace: (select: (value: typeof state.workspace) => unknown) => select(state.workspace),
}))
vi.mock('../store/terminal', () => ({
  useTerminal: (select: (value: typeof state.terminal) => unknown) => select(state.terminal),
}))
vi.mock('../store/tasks', () => ({
  useTaskStore: (select: (value: typeof state.tasks) => unknown) => select(state.tasks),
}))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({ openWelcome: actions.openWelcome }) } }))
vi.mock('../store/settings', () => {
  const useSettings = Object.assign(
    (select: (value: typeof state.settings) => unknown) => select(state.settings),
    { getState: () => state.settings },
  )
  return { useSettings }
})
vi.mock('../lib/useShortcut', () => ({
  useShortcutTip: (_id: string, fallback: string) => fallback,
}))
vi.mock('../lib/actions', () => ({ toggleTerminal: actions.toggleTerminal }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: ({ name }: { name: string }) => <span data-icon={name} /> }))

import { ActivityBar } from './ActivityBar'

const visibleAll: ActivityBarVisibility = {
  welcome: true,
  git: true,
  structure: true,
  tasks: true,
}

function renderBar(overrides: Partial<React.ComponentProps<typeof ActivityBar>> = {}) {
  return render(
    <ActivityBar
      view="explorer"
      onChange={vi.fn()}
      welcomeActive={false}
      visibility={visibleAll}
      tasksEnabled
      onOpenSettings={vi.fn()}
      {...overrides}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

it('opens the welcome tab once and ignores the second click of a double-click', () => {
  renderBar()
  const welcome = screen.getByRole('button', { name: 'activity.welcomeTip' })
  fireEvent.click(welcome, { detail: 1 })
  fireEvent.click(welcome, { detail: 2 })
  expect(actions.openWelcome).toHaveBeenCalledOnce()
})

it('keeps Explorer and Search visible when every hideable item is hidden', () => {
  renderBar({
    visibility: { welcome: false, git: false, structure: false, tasks: false },
  })
  expect(screen.getByRole('button', { name: 'activity.explorerTip' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'activity.searchTip' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'activity.welcomeTip' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'activity.gitTip' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'activity.structureTip' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'activity.tasksTip' })).toBeNull()
})

it('double-click opens a checked visibility menu that can restore hidden items', () => {
  const { container } = renderBar({
    visibility: { welcome: false, git: false, structure: false, tasks: false },
  })
  fireEvent.doubleClick(container.querySelector('.tide-activity-bar')!, { clientX: 60, clientY: 40 })

  const welcome = screen.getByRole('button', { name: 'activity.welcomeTip' })
  expect(welcome.getAttribute('aria-pressed')).toBe('false')
  expect(screen.getByRole('button', { name: 'activity.gitTip' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'activity.structureTip' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'activity.tasksTip' })).toBeTruthy()

  fireEvent.click(welcome)
  expect(state.settings.patch).toHaveBeenCalledExactlyOnceWith({ activityBarWelcomeVisible: true })
  // keepOpen leaves the checklist available for the next item.
  expect(screen.getByRole('button', { name: 'activity.welcomeTip' })).toBeTruthy()
})
