// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../lib/useShortcut', () => ({ useShortcut: () => '' }))
vi.mock('../lib/actions', () => ({
  newWindow: vi.fn(),
  openFileDialog: vi.fn(),
  openFolderDialog: vi.fn(),
  openWorkspace: vi.fn(),
}))
vi.mock('../store/workspace', () => ({
  useWorkspace: (selector: (state: { roots: unknown[]; recent: unknown[] }) => unknown) =>
    selector({ roots: [], recent: [] }),
}))
vi.mock('../store/ui', () => ({
  useUi: (selector: (state: { setOverlay: () => void; openQuickOpen: () => void }) => unknown) =>
    selector({ setOverlay: vi.fn(), openQuickOpen: vi.fn() }),
}))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))

import { openFileDialog } from '../lib/actions'
import { Welcome } from './Welcome'

afterEach(cleanup)

it('puts Open file before Open folder and opens the native picker', () => {
  render(<Welcome />)
  const buttons = screen.getAllByRole('button')
  expect(buttons[0].textContent).toContain('welcome.openFile')
  expect(buttons[1].textContent).toContain('welcome.openFolder')
  fireEvent.click(buttons[0])
  expect(openFileDialog).toHaveBeenCalledTimes(1)
})
