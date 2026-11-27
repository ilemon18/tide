// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Tab } from '../store/tabs'

vi.mock('../lib/useShortcut', () => ({ useShortcut: () => '⇧⌥F' }))

import { EditorContextMenu } from './EditorContextMenu'

const tab = (overrides: Partial<Tab> = {}): Tab => ({
  id: 'file',
  kind: 'file',
  root: '/repo',
  rel: 'src/App.tsx',
  name: 'App.tsx',
  dirty: false,
  readOnly: false,
  pinned: false,
  temporary: false,
  tier: 'full',
  mtime: 0,
  ...overrides,
})

afterEach(cleanup)

it('offers Format current file and invokes the callback', () => {
  const onFormat = vi.fn()
  render(<EditorContextMenu x={20} y={30} tab={tab()} formatting={false} onFormat={onFormat} onClose={vi.fn()} />)
  const item = screen.getByRole('button', { name: /Format current file/ })
  expect((item as HTMLButtonElement).disabled).toBe(false)
  expect(screen.getByText('⇧⌥F')).toBeTruthy()
  fireEvent.click(item)
  expect(onFormat).toHaveBeenCalledOnce()
})

it('disables formatting for a read-only editor', () => {
  render(
    <EditorContextMenu
      x={20}
      y={30}
      tab={tab({ readOnly: true })}
      formatting={false}
      onFormat={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  expect((screen.getByRole('button', { name: /Format current file/ }) as HTMLButtonElement).disabled).toBe(true)
})
