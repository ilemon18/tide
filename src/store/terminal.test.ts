// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { api } from '../lib/ipc'
vi.mock('../lib/ipc', () => ({
  api: { ptyClose: vi.fn().mockResolvedValue(undefined) },
  errorText: String,
}))
vi.mock('./workspace', () => ({ activeRoot: () => null }))
import { useTerminal } from './terminal'
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  useTerminal.getState().closeAll()
})
afterEach(async () => {
  useTerminal.getState().closeAll()
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

it('restarts ordinal numbering only after every terminal closes and keeps identifiers unique', () => {
  const first = useTerminal.getState().open()
  const second = useTerminal.getState().open()
  useTerminal.getState().close(first)
  expect(useTerminal.getState().tabs[0].ordinal).toBe(2)
  const third = useTerminal.getState().open()
  expect(useTerminal.getState().tabs.find((tab) => tab.id === third)?.ordinal).toBe(3)
  useTerminal.getState().closeAll()
  const next = useTerminal.getState().open()
  expect(next).not.toBe(first)
  expect(useTerminal.getState().tabs[0].ordinal).toBe(1)
  expect(second).not.toBe(third)
})
it('keeps left and right pins in their partitions and preserves PTY identity while sorting', () => {
  const left = useTerminal.getState().open(),
    a = useTerminal.getState().open(),
    b = useTerminal.getState().open(),
    right = useTerminal.getState().open()
  useTerminal.getState().setPtyId(a, 'pty-a')
  useTerminal.getState().pin(left, 'left')
  useTerminal.getState().pin(right, 'right')
  useTerminal.getState().reorder(a, b, true)
  expect(useTerminal.getState().tabs.map((tab) => tab.id)).toEqual([left, b, a, right])
  useTerminal.getState().reorder(a, left, false)
  expect(useTerminal.getState().tabs.map((tab) => tab.id)).toEqual([left, b, a, right])
  expect(useTerminal.getState().tabs.find((tab) => tab.id === a)?.ptyId).toBe('pty-a')
  expect(api.ptyClose).not.toHaveBeenCalled()
})
it('closes exited terminals without touching running shells or pinned tabs and reaps all PTYs on Close all', async () => {
  const running = useTerminal.getState().open(),
    exited = useTerminal.getState().open(),
    pinned = useTerminal.getState().open()
  for (const id of [running, exited, pinned]) useTerminal.getState().setPtyId(id, `pty-${id}`)
  useTerminal.getState().markExited(`pty-${exited}`)
  useTerminal.getState().markExited(`pty-${pinned}`)
  useTerminal.getState().pin(pinned, 'right')
  useTerminal.getState().closeMatching(running, 'exited')
  expect(useTerminal.getState().tabs.map((tab) => tab.id)).toEqual([running, pinned])
  useTerminal.getState().closeAll()
  await vi.runAllTimersAsync()
  expect(api.ptyClose).toHaveBeenCalledTimes(3)
  expect(useTerminal.getState()).toMatchObject({
    tabs: [],
    activeId: null,
    visible: false,
    maximized: false,
  })
})
