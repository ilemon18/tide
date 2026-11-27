// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { RootNode, TreeReveal } from '../store/workspace'

const { workspace, settings, tabs, chains, toggleRootCollapsed } = vi.hoisted(() => ({
  workspace: {
    roots: [] as RootNode[], treeReveal: null as TreeReveal | null, toggleDir: vi.fn(), loadMore: vi.fn(), moveEntry: vi.fn(),
    revealPath: vi.fn(), clearTreeReveal: vi.fn(),
  },
  settings: { showHidden: false, compactFolders: false, agentEnabled: true },
  tabs: { tabs: [], activeId: null, openFile: vi.fn() },
  chains: { chains: {}, revision: 0 },
  toggleRootCollapsed: vi.fn(),
}))
vi.mock('../store/workspace', () => ({
  useWorkspace: Object.assign((select: (state: unknown) => unknown) => select({ ...workspace, toggleRootCollapsed }),
    { getState: () => ({ ...workspace, toggleRootCollapsed }) }),
}))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select(settings) }))
vi.mock('../store/tabs', () => ({ useTabs: (select: (state: unknown) => unknown) => select(tabs) }))
vi.mock('../store/git', () => ({ useGit: (select: (state: unknown) => unknown) => select({ statuses: {} }) }))
vi.mock('../store/folderChain', () => ({ useFolderChain: (select: (state: unknown) => unknown) => select(chains) }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('../store/agent', () => ({ useAgent: { getState: () => ({}) } }))
vi.mock('../store/search', () => ({ useSearch: { getState: () => ({}) } }))
vi.mock('../store/terminal', () => ({ useTerminal: { getState: () => ({}) } }))
vi.mock('../lib/useShortcut', () => ({ useShortcut: () => '' }))
vi.mock('../lib/actions', () => ({ deleteEntryFlow: vi.fn(), newEntry: vi.fn(), revealEntry: vi.fn(), openFolderDialog: vi.fn() }))
vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))
vi.mock('../lib/fileDragState', () => ({ beginFilePointerDrag: vi.fn(), wasFileDragJustFinished: () => false }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key, useLocale: () => 'en', t: (key: string) => key }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./ContextMenu', () => ({ ContextMenu: () => null }))
import { FileTree, ROW_H, centeredTreeLeft, centeredTreeTop } from './FileTree'

beforeEach(() => {
  vi.clearAllMocks()
  workspace.treeReveal = null
  workspace.revealPath.mockReset()
  workspace.clearTreeReveal.mockReset()
  workspace.roots = [{ id: '/repo', name: 'Repo', isGitRepo: false, collapsed: false, expanded: {},
    tree: { '': { entries: [], total: 0, hasMore: false, loading: false } } }]
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})
afterEach(() => { cleanup(); vi.unstubAllGlobals() })

it.each([false, true])('leaves a loaded tree blank without a placeholder (hidden entries=%s)', hidden => {
  if (hidden) workspace.roots[0].tree[''].entries = [{
    name: '.hidden', path: '.hidden', isDir: false, isSymlink: false, ignored: false, size: 0, mtime: 0,
  }]
  const { container } = render(<FileTree />)
  const tree = container.querySelector('.tree-pane')!
  expect(tree.textContent).toBe('')
  // Only the virtual row spacer remains; an empty-state container must not occupy space.
  expect(tree.childElementCount).toBe(1)
  expect(screen.queryByText('explorer.reading')).toBeNull()
  expect(screen.queryByRole('button', { name: 'explorer.collapsed' })).toBeNull()
})

it('shows the reading hint until the root has loaded, then removes its container', () => {
  workspace.roots[0].tree = {}
  const { container, rerender } = render(<FileTree />)
  expect(screen.getByText('explorer.reading')).toBeTruthy()
  workspace.roots[0] = { ...workspace.roots[0], tree: {
    '': { entries: [], total: 0, hasMore: false, loading: false },
  } }
  workspace.roots = [...workspace.roots]
  rerender(<FileTree />)
  expect(screen.queryByText('explorer.reading')).toBeNull()
  expect(container.querySelector('.tree-pane')!.childElementCount).toBe(1)
})

it('keeps the collapsed hint actionable even when the roots have not been read', () => {
  workspace.roots = ['/repo', '/other'].map(id => ({
    id, name: id, isGitRepo: false, collapsed: true, expanded: {}, tree: {},
  }))
  render(<FileTree />)
  expect(screen.queryByText('explorer.reading')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'explorer.collapsed' }))
  expect(toggleRootCollapsed.mock.calls).toEqual([['/repo'], ['/other']])
})


it('centers a row in the tree viewport and clamps at both ends', () => {
  expect(centeredTreeTop(0, 10 * ROW_H, 100)).toBe(0)
  expect(centeredTreeTop(50, 10 * ROW_H, 100)).toBe(50 * ROW_H - (10 * ROW_H - ROW_H) / 2)
  expect(centeredTreeTop(99, 10 * ROW_H, 100)).toBe(100 * ROW_H - 10 * ROW_H)
  expect(centeredTreeTop(3, 20 * ROW_H, 5)).toBe(0)
})

it('centers a deep row label horizontally and clamps to the scroll range', () => {
  expect(centeredTreeLeft(0, 40, 200, 400)).toBe(0)
  expect(centeredTreeLeft(100, 40, 200, 400)).toBe(20)
  expect(centeredTreeLeft(350, 40, 200, 400)).toBe(200)
})

it('reveals a paged file row and centers it vertically', async () => {
  const entries = Array.from({ length: 300 }, (_, i) => ({
    name: `f${i}.ts`, path: `f${i}.ts`, isDir: false, isSymlink: false, ignored: false, size: 1, mtime: 1,
  }))
  workspace.roots = [{
    id: '/repo', name: 'Repo', isGitRepo: false, collapsed: false, expanded: {},
    tree: { '': { entries, total: entries.length, hasMore: false, loading: false } },
  }]
  workspace.treeReveal = { root: '/repo', rel: 'f299.ts', isDir: false, nonce: 1, center: true }
  workspace.revealPath.mockResolvedValue({ found: true, fallbackRel: 'f299.ts' })

  const { container } = render(<FileTree />)
  await act(async () => {})

  expect(workspace.revealPath).toHaveBeenCalledWith('/repo', 'f299.ts', false)
  const tree = container.querySelector<HTMLElement>('.tree-pane')!
  await waitFor(() => expect(tree.scrollTop).toBe(299 * ROW_H + ROW_H / 2))
  expect(workspace.clearTreeReveal).toHaveBeenCalledWith(1)
})
