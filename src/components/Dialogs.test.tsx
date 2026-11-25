// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const { ui } = vi.hoisted(() => ({
  ui: {
    confirmReq: null as null | {
      title: string
      message: string
      confirmText?: string
      danger?: boolean
      confirmOnEnter?: boolean
      resolve: (ok: boolean) => void
    },
    answerConfirm: vi.fn(),
  },
}))

vi.mock('../store/ui', () => ({ useUi: (selector: (state: typeof ui) => unknown) => selector(ui) }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
import { ConfirmDialog } from './Dialogs'

beforeEach(() => {
  vi.clearAllMocks()
  ui.confirmReq = {
    title: 'agent.history.deleteTitle',
    message: 'Delete this chat?',
    confirmOnEnter: true,
    resolve: vi.fn(),
  }
})
afterEach(cleanup)

it('confirms on Enter when confirmOnEnter is enabled', () => {
  render(<ConfirmDialog />)
  const confirm = screen.getByRole('button', { name: 'dialog.confirm' })
  expect(document.activeElement).toBe(confirm)
  fireEvent.keyDown(confirm, { key: 'Enter' })
  expect(ui.answerConfirm).toHaveBeenCalledExactlyOnceWith(true)
})

it('cancels on Enter when the cancel button has focus', () => {
  render(<ConfirmDialog />)
  const cancel = screen.getByRole('button', { name: 'common.cancel' })
  cancel.focus()
  fireEvent.keyDown(cancel, { key: 'Enter' })
  expect(ui.answerConfirm).toHaveBeenCalledExactlyOnceWith(false)
})

it('keeps Escape as cancel', () => {
  render(<ConfirmDialog />)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(ui.answerConfirm).toHaveBeenCalledExactlyOnceWith(false)
})

it('leaves other confirmation dialogs on their default keyboard behavior', () => {
  ui.confirmReq!.confirmOnEnter = undefined
  render(<ConfirmDialog />)
  fireEvent.keyDown(screen.getByRole('button', { name: 'dialog.confirm' }), { key: 'Enter' })
  expect(ui.answerConfirm).not.toHaveBeenCalled()
})
