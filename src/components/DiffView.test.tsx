// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Tab } from '../store/tabs'

const { gitDiffFull, tabState, switchDiffToFile } = vi.hoisted(() => ({
  gitDiffFull: vi.fn(),
  tabState: { diffEpoch: {} as Record<string, number> },
  switchDiffToFile: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({ api: { gitDiffFull }, errorText: String }))
vi.mock('../store/tabs', () => ({
  useTabs: Object.assign((select: (state: typeof tabState) => unknown) => select(tabState), {
    getState: () => ({ switchDiffToFile }),
  }),
}))
vi.mock('../store/git', () => ({ useGit: (select: (state: unknown) => unknown) => select({ statuses: {} }) }))
vi.mock('../store/settings', () => ({
  useSettings: (select: (state: unknown) => unknown) => select({ palette: { syntax: {} } }),
}))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
vi.mock('./FileIcon', () => ({ FileIcon: () => null }))
vi.mock('./diffHighlight', () => ({ HIGHLIGHT_MAX_LINES: 4000, highlightSide: async () => null }))
import { DiffView } from './DiffView'

const tab: Tab = {
  id: 'diff:one', root: '/repo', rel: 'one.ts', name: 'one.ts', kind: 'diff', staged: true,
  dirty: false, readOnly: true, tier: 'full', pinned: false, temporary: false, mtime: 0,
}
const result = (text = 'new') => ({
  patch: ['@@ -1,23 +1,23 @@', ...Array.from({ length: 20 }, (_, i) => ` context ${i}`),
    '-old', `+${text}`, ' tail', ' end', ''].join('\n'),
  binary: false,
  truncated: false,
})

let frames: Map<number, FrameRequestCallback>
let contentHeight: number
beforeEach(() => {
  vi.useFakeTimers()
  gitDiffFull.mockReset().mockResolvedValue(result())
  switchDiffToFile.mockReset()
  tabState.diffEpoch = {}
  contentHeight = 2000
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('PointerEvent', MouseEvent)
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('diff-selectable') ? contentHeight : 0
  })
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pane = this.closest<HTMLElement>('.diff-selectable')
    const changed = this.dataset.diffChange === '1'
    return {
      x: 0, y: 0, left: 0, right: 500, width: 500, bottom: 200,
      top: changed ? 420 - (pane?.scrollTop ?? 0) : 0,
      height: changed ? 20 : 200,
      toJSON: () => ({}),
    }
  })
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function paint() {
  act(() => {
    for (const id of [...frames.keys()]) {
      const callback = frames.get(id)
      frames.delete(id)
      callback?.(0)
    }
  })
}

async function open() {
  const view = render(<DiffView tab={tab} />)
  await act(async () => {})
  paint()
  const panes = () => [...view.container.querySelectorAll<HTMLDivElement>('.diff-selectable')]
  return { ...view, panes }
}

function move(pane: HTMLElement, top: number) {
  pane.scrollTop = top
  fireEvent.scroll(pane)
}

it('opens at the first change with three context rows and follows the final fast-scroll position', async () => {
  const { panes } = await open()
  expect(gitDiffFull).toHaveBeenCalledWith('/repo', 'one.ts', true)
  expect(panes().map((pane) => pane.scrollTop)).toEqual([360, 360])
  move(panes()[0], 900)
  move(panes()[0], 1200)
  move(panes()[0], 700)
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([700, 700])
})

it('overview click and drag override pending synchronization', async () => {
  const { panes } = await open()
  const ruler = screen.getAllByTitle('diff.overviewTitle')[1]
  ruler.setPointerCapture = vi.fn()
  move(panes()[0], 900)
  fireEvent.pointerDown(ruler, { clientY: 100, buttons: 1 })
  fireEvent.pointerMove(ruler, { clientY: 150, buttons: 1 })
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([1400, 1400])
})

it('captures the newest reading position when refresh is applied and discards movement queued for the old layout', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('diff-selectable') ? (document.body.textContent?.includes('updated') ? 4000 : 2000) : 0
  })
  const { panes, rerender } = await open()
  move(panes()[0], 600)
  paint()
  let finish!: (value: ReturnType<typeof result>) => void
  gitDiffFull.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  move(panes()[1], 900)
  await act(async () => { finish(result('updated')) })
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([1800, 1800])
})

it('restores an unchanged refresh without relying on a new display list', async () => {
  const { panes, rerender } = await open()
  move(panes()[0], 600)
  paint()
  let finish!: (value: ReturnType<typeof result>) => void
  gitDiffFull.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  move(panes()[1], 900)
  await act(async () => { finish(result()) })
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([900, 900])
})

it('captures the latest right-pane position even when refresh starts before the sync frame', async () => {
  const { panes, rerender } = await open()
  move(panes()[1], 800)
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  await act(async () => {})
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([800, 800])
})

it('settles the latest scroll before folding and keeps both sides aligned on expansion', async () => {
  const { panes } = await open()
  move(panes()[0], 500)
  paint()
  move(panes()[1], 900)
  fireEvent.click(screen.getAllByText('diff.foldLines')[0])
  paint()
  // jsdom does not lay out/clamp after folding; compare row structure as well as subsequent scrolling.
  expect(panes()[0].children.length).toBe(panes()[1].children.length)
  expect(panes().map((pane) => pane.scrollTop)).toEqual([900, 900])
  fireEvent.click(screen.getAllByText('diff.expandLines')[0])
  move(panes()[0], 650)
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([650, 650])
})

it('cancels pending scroll and restoration callbacks on tab switch and unmount', async () => {
  const { panes, rerender, unmount } = await open()
  move(panes()[0], 1000)
  // Leave the unchanged-refresh restoration frame pending as well.
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  await act(async () => {})
  rerender(<DiffView tab={{ ...tab, id: 'diff:two', rel: 'two.ts' }} />)
  await act(async () => {})
  paint()
  expect(panes().map((pane) => pane.scrollTop)).toEqual([360, 360])
  move(panes()[1], 800)
  unmount()
  expect(frames.size).toBe(0)
})

it('updates the overview viewport after scrolling without replacing static marks', async () => {
  const { panes } = await open()
  const ruler = screen.getAllByTitle('diff.overviewTitle')[0]
  const mark = ruler.querySelector('span')
  move(panes()[0], 1000)
  move(panes()[0], 1200)
  paint()
  expect((ruler.firstElementChild as HTMLElement).style.top).toBe('60%')
  expect(ruler.querySelector('span')).toBe(mark)
})

it('keeps an overview jump made during a background refresh', async () => {
  const { panes, rerender } = await open()
  let finish!: (value: ReturnType<typeof result>) => void
  gitDiffFull.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  const ruler = screen.getAllByTitle('diff.overviewTitle')[1]
  ruler.setPointerCapture = vi.fn()
  fireEvent.pointerDown(ruler, { clientY: 100, buttons: 1 })
  await act(async () => { finish(result('updated')) })
  paint()
  expect(panes().map(pane => pane.scrollTop)).toEqual([900, 900])
})

it('hands the latest reading ratio to a normal file when an in-flight diff becomes empty', async () => {
  const { panes, rerender } = await open()
  let finish!: (value: ReturnType<typeof result>) => void
  gitDiffFull.mockReturnValueOnce(new Promise(resolve => { finish = resolve }))
  tabState.diffEpoch[tab.id] = 1
  rerender(<DiffView tab={tab} />)
  move(panes()[1], 900)
  await act(async () => { finish({ patch: '', binary: false, truncated: false }) })
  expect(switchDiffToFile).toHaveBeenCalledWith(tab.id, 0.5)
})
