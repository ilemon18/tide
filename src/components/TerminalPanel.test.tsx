// @vitest-environment jsdom
import React, { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { mounts } = vi.hoisted(() => ({ mounts: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { ptyClose: vi.fn().mockResolvedValue(undefined) }, errorText: String }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({}) } }))
vi.mock('../store/workspace', () => ({ activeRoot: () => null }))
vi.mock('../store/settings', () => ({ useSettings: (select: (state: unknown) => unknown) => select({ panelVisible: true }) }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./TerminalView', () => ({ TerminalView: function View() {
  useEffect(() => { mounts() }, [])
  return <div data-testid="resident-terminal" />
} }))
import TerminalPanel from './TerminalPanel'
import { useTerminal } from '../store/terminal'
beforeEach(() => {
  mounts.mockClear()
  useTerminal.setState({ visible: true, maximized: false, activeId: 't', tabs: [
    { id: 't', ordinal: 1, ptyId: 'pty', exited: false, generation: 0, root: null, rel: '' },
  ] })
})
afterEach(cleanup)
it('maximizes and restores without remounting xterm or replacing the PTY identity', () => {
  const { rerender } = render(<TerminalPanel height={240} />)
  fireEvent.click(screen.getByLabelText('terminal.maximize'))
  expect(useTerminal.getState().maximized).toBe(true)
  rerender(<TerminalPanel height={696} />)
  fireEvent.click(screen.getByLabelText('terminal.restore'))
  rerender(<TerminalPanel height={240} />)
  expect(mounts).toHaveBeenCalledOnce()
  expect(useTerminal.getState().tabs[0].ptyId).toBe('pty')
  expect(useTerminal.getState().tabs[0].generation).toBe(0)
})
it('leaves maximize mode when hidden or when the last terminal closes', () => {
  useTerminal.getState().setMaximized(true)
  useTerminal.getState().setVisible(false)
  expect(useTerminal.getState().maximized).toBe(false)
  useTerminal.getState().setMaximized(true)
  useTerminal.getState().close('t')
  expect(useTerminal.getState().maximized).toBe(false)
  expect(useTerminal.getState().visible).toBe(false)
})
