// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { workspace } = vi.hoisted(() => ({ workspace: {
  roots: [] as { id: string; name: string; isGitRepo: boolean }[],
  recent: [] as { path: string; name: string }[],
  activeRootId: null as string | null,
  setActiveRoot: vi.fn(), removeRecent: vi.fn(),
} }))

vi.mock('../lib/useShortcut', () => ({ useShortcut: () => '' }))
vi.mock('../lib/actions', () => ({
  newWindow: vi.fn(),
  openFileDialog: vi.fn(),
  openFolderDialog: vi.fn(),
  openWorkspace: vi.fn(),
}))
vi.mock('../store/workspace', () => ({
  useWorkspace: Object.assign((selector: (state: typeof workspace) => unknown) => selector(workspace),
    { getState: () => workspace }),
}))
vi.mock('../store/ui', () => ({
  useUi: (selector: (state: { setOverlay: () => void; openQuickOpen: () => void }) => unknown) =>
    selector({ setOverlay: vi.fn(), openQuickOpen: vi.fn() }),
}))
vi.mock('../i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../i18n')>()),
  useT: () => (key: string) => key,
}))

import { newWindow, openFileDialog, openWorkspace } from '../lib/actions'
import { Welcome } from './Welcome'

beforeEach(() => { vi.clearAllMocks(); workspace.roots = []; workspace.recent = []; workspace.activeRootId = null })
afterEach(cleanup)

it('puts Open file before Open folder and opens the native picker', () => {
  render(<Welcome />)
  const buttons = screen.getAllByRole('button')
  expect(buttons[0].textContent).toContain('welcome.openFile')
  expect(buttons[1].textContent).toContain('welcome.openFolder')
  expect(screen.getByText('welcome.commandPalette').closest('button')?.className).not.toContain('col-span-2')
  fireEvent.click(buttons[0])
  expect(openFileDialog).toHaveBeenCalledTimes(1)
})

it('shares the heading with the current project, caps recents at twelve and delegates switching', () => {
  workspace.roots = [{ id: '/current', name: 'Current', isGitRepo: false }]
  workspace.recent = [{ path: '/current', name: 'Current' },
    ...Array.from({ length: 15 }, (_, index) => ({ path: `/repo-${index}`, name: `Project ${index}` })),
  ]
  render(<Welcome />)
  const region = screen.getByRole('region', { name: 'welcome.recent' })
  const current = within(region).getByRole('button', { name: 'welcome.currentProject: Current' })
  expect(current.getAttribute('aria-current')).toBe('true')
  expect(within(region).getByRole('heading', { name: 'welcome.recent' }).parentElement?.contains(current)).toBe(true)
  const projects = within(region.querySelector<HTMLElement>('.welcome-project-grid')!).getAllByRole('button')
  expect(projects.map(button => button.textContent)).toEqual(Array.from({ length: 12 }, (_, index) => `Project ${index}`))
  expect(projects[0].title).toBe('/repo-0')
  fireEvent.click(projects[0])
  expect(openWorkspace).toHaveBeenCalledExactlyOnceWith('/repo-0')
  expect(workspace.setActiveRoot).not.toHaveBeenCalled()
})

it('keeps new-window and removal actions separate from a normal project switch', () => {
  workspace.recent = [{ path: '/repo', name: 'Repo' }]
  render(<Welcome />)
  const project = within(screen.getByRole('region', { name: 'welcome.recent' })).getByRole('button', { name: 'Repo' })
  fireEvent.contextMenu(project, { clientX: 20, clientY: 30 })
  fireEvent.click(screen.getByRole('button', { name: 'projects.openInNewWindowTip' }))
  expect(newWindow).toHaveBeenCalledExactlyOnceWith('/repo')
  expect(openWorkspace).not.toHaveBeenCalled()
  fireEvent.keyDown(project, { key: 'F10', shiftKey: true })
  fireEvent.click(screen.getByRole('button', { name: 'projects.removeRecentTip' }))
  expect(workspace.removeRecent).toHaveBeenCalledExactlyOnceWith('/repo')
  expect(openWorkspace).not.toHaveBeenCalled()
})

it('retains current project status without an empty grid when every recent project is open here', () => {
  workspace.roots = [{ id: '/current', name: 'Current', isGitRepo: false }]
  workspace.recent = [{ path: '/current', name: 'Current' }]
  render(<Welcome />)
  const region = screen.getByRole('region', { name: 'welcome.recent' })
  expect(region.querySelector('.welcome-project-grid')).toBeNull()
  expect(within(region).getAllByRole('button')).toHaveLength(1)
})

it('uses the active root for current project status', () => {
  workspace.roots = [{ id: '/first', name: 'First', isGitRepo: false }, { id: '/active', name: 'Active', isGitRepo: true }]
  workspace.activeRootId = '/active'
  render(<Welcome />)
  fireEvent.click(screen.getByRole('button', { name: 'welcome.currentProject: Active' }))
  expect(workspace.setActiveRoot).toHaveBeenCalledExactlyOnceWith('/active')
  expect(openWorkspace).not.toHaveBeenCalled()
})
