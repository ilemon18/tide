// @vitest-environment jsdom
import React, { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { mounts, lock, unlock } = vi.hoisted(() => ({ mounts: vi.fn(), lock: vi.fn(), unlock: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { ptyClose: vi.fn().mockResolvedValue(undefined) }, errorText: String }))
vi.mock('../lib/fileDragState', () => ({ lockTextSelection: () => { lock(); return unlock } }))
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
  lock.mockClear()
  unlock.mockClear()
  vi.stubGlobal('PointerEvent', MouseEvent)
  useTerminal.setState({ visible: true, maximized: false, activeId: 't', tabs: [
    { id: 't', ordinal: 1, ptyId: 'pty', exited: false, generation: 0, root: null, rel: '' },
  ] })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
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

it('creates a terminal only when blank tab-strip space is double-clicked', () => {
  const { container } = render(<TerminalPanel height={240} />)
  const tab = screen.getByRole('tab')
  fireEvent.click(tab, { detail: 2 })
  expect(useTerminal.getState().tabs).toHaveLength(1)
  fireEvent.click(container.firstElementChild!.firstElementChild!, { detail: 2 })
  expect(useTerminal.getState().tabs).toHaveLength(2)
})
it('marks Close all as dangerous and closes every terminal through the menu', () => {
  render(<TerminalPanel height={240} />)
  fireEvent.contextMenu(screen.getByRole('tab'), { clientX: 50, clientY: 50 })
  const closeAll = screen.getByRole('button', { name: 'tabs.closeAll' })
  expect(closeAll.classList.contains('text-danger')).toBe(true)
  fireEvent.click(closeAll)
  expect(useTerminal.getState().tabs).toEqual([])
  expect(useTerminal.getState().visible).toBe(false)
})

it('follows the grabbed point, moves neighbors, and preserves terminals through sorting', () => {
  const base = useTerminal.getState().tabs[0]
  useTerminal.setState({ tabs: [base, { ...base, id: 'u', ordinal: 2, ptyId: 'pty-u' }, { ...base, id: 'v', ordinal: 3, ptyId: 'pty-v' }] })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  const { unmount } = render(<TerminalPanel height={240} />)
  const first = screen.getAllByRole('tab')[0]
  fireEvent.pointerDown(first, { button: 0, clientX: 20, clientY: 15 })
  fireEvent.pointerMove(window, { clientX: 22, clientY: 15 })
  expect(lock).not.toHaveBeenCalled()
  fireEvent.pointerMove(window, { clientX: 160, clientY: 15 })
  expect(first.style.transform).toBe('translate(140px, -50%)')
  expect(first.getAttribute('data-dragging')).toBe('true')
  expect(useTerminal.getState().tabs.map(tab => tab.id)).toEqual(['u', 't', 'v'])
  expect(screen.getAllByRole('tab')[0].style.transform).toBe('translate(0px, -50%)')
  fireEvent.pointerMove(window, { clientX: 280, clientY: 15 })
  expect(useTerminal.getState().tabs.map(tab => tab.id)).toEqual(['u', 'v', 't'])
  fireEvent.pointerUp(window)
  expect(unlock).toHaveBeenCalledOnce()
  expect(first.getAttribute('data-dragging')).toBe('false')
  expect(mounts).toHaveBeenCalledTimes(3)
  expect(useTerminal.getState().tabs.map(tab => tab.ptyId)).toEqual(['pty-u', 'pty-v', 'pty'])
  fireEvent.pointerDown(first, { button: 0, clientX: 220, clientY: 15 })
  fireEvent.pointerMove(window, { clientX: 10, clientY: 15 })
  unmount()
  expect(unlock).toHaveBeenCalledTimes(2)
  const order = useTerminal.getState().tabs
  fireEvent.pointerMove(window, { clientX: 280, clientY: 15 })
  expect(useTerminal.getState().tabs).toBe(order)
})

it('clamps dragging to its pin partition and releases the gesture on blur or removal', () => {
  const base = useTerminal.getState().tabs[0]
  useTerminal.setState({ tabs: [{ ...base, id: 'left', pinned: 'left' }, base, { ...base, id: 'right', pinned: 'right' }] })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(100)
  render(<TerminalPanel height={240} />)
  const middle = screen.getAllByRole('tab')[1]
  vi.spyOn(middle, 'getBoundingClientRect').mockReturnValue({ left: 102 } as DOMRect)
  fireEvent.pointerDown(middle, { button: 0, clientX: 120 })
  fireEvent.pointerMove(window, { clientX: 600 })
  expect(middle.style.transform).toBe('translate(102px, -50%)')
  expect(useTerminal.getState().tabs.map(tab => tab.id)).toEqual(['left', 't', 'right'])
  fireEvent.blur(window)
  expect(unlock).toHaveBeenCalledOnce()
  fireEvent.pointerDown(middle, { button: 0, clientX: 120 })
  fireEvent.pointerMove(window, { clientX: 600 })
  act(() => useTerminal.getState().close('t'))
  expect(unlock).toHaveBeenCalledTimes(2)
})
