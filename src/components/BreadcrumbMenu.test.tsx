// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readDirectoryEntries } from '../lib/workspaceEntries'
const { openFile } = vi.hoisted(() => ({ openFile: vi.fn().mockResolvedValue(undefined) }))
vi.mock('../lib/workspaceEntries', () => ({ readDirectoryEntries: vi.fn() }))
vi.mock('../store/settings', () => ({
  useSettings: (select: (state: unknown) => unknown) => select({ showHidden: false }),
}))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({ openFile }) } }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { BreadcrumbMenu } from './BreadcrumbMenu'
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView')
beforeEach(() => {
  vi.clearAllMocks()
  HTMLElement.prototype.scrollIntoView = vi.fn()
})
afterEach(() => {
  cleanup()
  if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView')
})
it('opens sibling files, expands folders, and leaves symlinks unavailable', async () => {
  const entry = (name: string, path: string, isDir = false, isSymlink = false) => ({
    name,
    path,
    isDir,
    isSymlink,
    size: 0,
    mtime: 0,
    ignored: false,
  })
  vi.mocked(readDirectoryEntries).mockImplementation(async (_root, dir) =>
    dir === 'src'
      ? [
          entry('a.ts', 'src/a.ts'),
          entry('b.ts', 'src/b.ts'),
          entry('nested', 'src/nested', true),
          entry('.hidden', 'src/.hidden'),
          entry('link', 'src/link', true, true),
        ]
      : [entry('c.ts', 'src/nested/c.ts')],
  )
  const close = vi.fn()
  render(<BreadcrumbMenu root="/repo" rel="src/a.ts" x={20} y={40} onClose={close} />)
  const nested = await screen.findByRole('treeitem', { name: 'nested' })
  expect(screen.queryByRole('treeitem', { name: '.hidden' })).toBeNull()
  expect((screen.getByRole('treeitem', { name: 'link' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(nested)
  fireEvent.click(await screen.findByRole('treeitem', { name: 'c.ts' }))
  expect(openFile).toHaveBeenCalledWith('/repo', 'src/nested/c.ts')
  expect(close).toHaveBeenCalledOnce()
})
it('dismisses on Escape without forwarding it to editor handlers', async () => {
  vi.mocked(readDirectoryEntries).mockResolvedValue([])
  const close = vi.fn(),
    bubble = vi.fn()
  document.addEventListener('keydown', bubble)
  render(<BreadcrumbMenu root="/repo" rel="src/a.ts" x={20} y={40} onClose={close} />)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(close).toHaveBeenCalledOnce()
  expect(bubble).not.toHaveBeenCalled()
  document.removeEventListener('keydown', bubble)
})
