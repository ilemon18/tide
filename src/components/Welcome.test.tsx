// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { workspace } = vi.hoisted(() => ({ workspace: {
  roots: [] as { id: string; name: string; isGitRepo: boolean }[],
  recent: [] as { path: string; name: string }[],
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

beforeEach(() => { vi.clearAllMocks(); workspace.roots = []; workspace.recent = [] })
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

it('shows the newest six other projects below the current project and delegates switching', () => {
  workspace.roots = [{ id: '/current', name: 'Current', isGitRepo: false }]
  workspace.recent = [{ path: '/current', name: 'Current' },
    ...Array.from({ length: 9 }, (_, index) => ({ path: `/repo-${index}`, name: `Project ${index}` })),
  ]
  render(<Welcome />)
  const region = screen.getByRole('region', { name: 'welcome.recent' })
  expect(screen.getByText('welcome.currentProject').compareDocumentPosition(region) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  const projects = within(region).getAllByRole('button')
  expect(projects.map(button => button.textContent)).toEqual(Array.from({ length: 6 }, (_, index) => `Project ${index}`))
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

it('omits the quick-switch row when all recent projects are already open here', () => {
  workspace.roots = [{ id: '/current', name: 'Current', isGitRepo: false }]
  workspace.recent = [{ path: '/current', name: 'Current' }]
  render(<Welcome />)
  expect(screen.queryByRole('region', { name: 'welcome.recent' })).toBeNull()
})
