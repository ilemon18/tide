import { expect, it } from 'vitest'
import { dragTerminalHeight, terminalAvailableHeight } from './terminalLayout'

it('maximizes at the region top without overwriting the restore height', () => {
  expect(dragTerminalHeight(240, false, -500, 700)).toEqual({ maximized: true, height: 240 })
})
it('drags down continuously from the actual region height after a resize', () => {
  expect(dragTerminalHeight(240, true, 40, 700)).toEqual({ maximized: false, height: 656 })
  expect(dragTerminalHeight(240, true, 40, 500)).toEqual({ maximized: false, height: 456 })
})
it('keeps a minimum height and clamps display geometry without changing saved preferences', () => {
  expect(dragTerminalHeight(240, false, 1000, 700)).toEqual({ maximized: false, height: 120 })
  expect(terminalAvailableHeight(600)).toBe(596)
  expect(terminalAvailableHeight(90)).toBe(120)
})
