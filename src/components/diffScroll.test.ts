import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createDiffScroll } from './diffScroll'

let frames: Map<number, FrameRequestCallback>
beforeEach(() => {
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})
afterEach(() => vi.unstubAllGlobals())

function paint() {
  const callbacks = [...frames.values()]
  frames.clear()
  callbacks.forEach((callback) => callback(0))
}

/** Model browser scroll clamping without requiring layout from jsdom. */
function pane(maxTop = 2000, maxLeft = 1000) {
  let top = 0
  let left = 0
  const writes: string[] = []
  const element = {
    get scrollTop() { return top },
    set scrollTop(value: number) { top = Math.max(0, Math.min(maxTop, value)); writes.push('top') },
    get scrollLeft() { return left },
    set scrollLeft(value: number) { left = Math.max(0, Math.min(maxLeft, value)); writes.push('left') },
  } as HTMLElement
  return { element, writes }
}

function setup(rightMaxTop = 2000, rightMaxLeft = 1000) {
  const left = pane()
  const right = pane(rightMaxTop, rightMaxLeft)
  const panes = { left: left.element, right: right.element }
  const sync = createDiffScroll((side) => panes[side])
  sync.reset()
  const move = (side: 'left' | 'right', top: number, horizontal?: number) => {
    panes[side].scrollTop = top
    if (horizontal !== undefined) panes[side].scrollLeft = horizontal
    sync.onScroll(side, panes[side])
  }
  return { left, right, panes, sync, move }
}

it('coalesces fast scrolling and reversal, including the final position before stopping', () => {
  const { move, right, sync, panes } = setup()
  move('left', 100)
  move('left', 900)
  move('left', 400)
  expect(frames.size).toBe(1)
  paint()
  expect(right.element.scrollTop).toBe(400)
  expect(right.writes).toEqual(['top'])
  sync.onScroll('right', panes.right)
  expect(frames.size).toBe(0)
  move('left', 450)
  paint()
  expect(right.element.scrollTop).toBe(450)
})

it('reads the live source offset when the frame runs', () => {
  const { move, panes } = setup()
  move('right', 100)
  panes.right.scrollTop = 700
  paint()
  expect(panes.left.scrollTop).toBe(700)
})

it('lets the latest real input win when the user switches sides within one frame', () => {
  const { move, panes, sync } = setup()
  move('left', 800)
  move('right', 300)
  paint()
  expect(panes.left.scrollTop).toBe(300)
  // New input on the follower must survive even if its programmatic echo has not arrived.
  move('left', 250)
  sync.onScroll('right', panes.right)
  paint()
  expect(panes.right.scrollTop).toBe(250)
})

it('does not pull a wide pane back when the narrow pane echoes or scrolls vertically', () => {
  const { move, panes, sync } = setup(2000, 100)
  move('left', 200, 800)
  paint()
  expect(panes.right.scrollLeft).toBe(100)
  sync.onScroll('right', panes.right)
  expect(frames.size).toBe(0)
  move('right', 400)
  paint()
  expect(panes.left.scrollTop).toBe(400)
  expect(panes.left.scrollLeft).toBe(800)
  move('right', 400, 50)
  paint()
  expect(panes.left.scrollLeft).toBe(50)
})

it('retains separate sources for horizontal and vertical movement', () => {
  const { move, panes } = setup()
  move('left', 0, 500)
  move('right', 600)
  paint()
  expect([panes.left.scrollTop, panes.right.scrollTop]).toEqual([600, 600])
  expect([panes.left.scrollLeft, panes.right.scrollLeft]).toEqual([500, 500])
})

it('recognizes bottom clamping and avoids repeated writes at unchanged positions', () => {
  const { move, panes, sync, right } = setup(500)
  move('left', 1900)
  paint()
  expect(panes.right.scrollTop).toBe(500)
  sync.onScroll('right', panes.right)
  expect(frames.size).toBe(0)
  move('left', 1900)
  paint()
  expect(right.writes).toEqual(['top'])
  expect(panes.left.scrollTop).toBe(1900)
})

it('an explicit jump cancels queued movement and preserves horizontal positions', () => {
  const { move, panes, sync } = setup()
  move('left', 100, 300)
  paint()
  move('right', 900)
  sync.jumpTo(500)
  paint()
  expect([panes.left.scrollTop, panes.right.scrollTop]).toEqual([500, 500])
  expect([panes.left.scrollLeft, panes.right.scrollLeft]).toEqual([300, 300])
  sync.onScroll('left', panes.left)
  sync.onScroll('right', panes.right)
  expect(frames.size).toBe(0)
})

it('settles the latest input immediately before capturing progress or changing layout', () => {
  const { move, panes, sync, left } = setup()
  move('right', 700)
  sync.flush()
  expect(panes.left.scrollTop).toBe(700)
  expect(frames.size).toBe(0)
  paint()
  expect(left.writes).toEqual(['top'])
})

it('reset and cancellation prevent old work from affecting a new layout or an unmounted view', () => {
  const { move, panes, sync } = setup()
  move('left', 800)
  sync.reset()
  paint()
  expect(panes.right.scrollTop).toBe(0)
  move('left', 900)
  sync.cancel()
  paint()
  expect(panes.right.scrollTop).toBe(0)
})

it('ignores a queued source whose element has been replaced', () => {
  const { move, panes } = setup()
  move('left', 800)
  panes.left = pane().element
  paint()
  expect(panes.right.scrollTop).toBe(0)
})
