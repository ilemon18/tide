// @vitest-environment jsdom
import React, { useRef } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useOverflowMeasure } from './useOverflowMeasure'

const observers: IntersectionObserverCallback[] = []
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0
let scrollReads = 0
let restoreSize: (() => void) | null = null

function Harness({ enabled = true, version = 'one' }: { enabled?: boolean; version?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const overflow = useOverflowMeasure(ref, enabled, version)
  return <div ref={ref} data-testid="preview" data-overflow={String(overflow)} />
}

function intersect(isIntersecting: boolean) {
  act(() => {
    const callbacks = [...observers]
    if (isIntersecting) observers.length = 0
    for (const callback of callbacks) {
      callback([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver)
    }
  })
}

function flushFrames() {
  act(() => {
    const callbacks = [...frames.values()]
    frames.clear()
    for (const callback of callbacks) callback(0)
  })
}

beforeEach(() => {
  observers.length = 0
  frames.clear()
  nextFrame = 0
  scrollReads = 0
  vi.stubGlobal('IntersectionObserver', class {
    constructor(callback: IntersectionObserverCallback) { observers.push(callback) }
    observe() {}
    disconnect() {}
    unobserve() {}
    takeRecords() { return [] }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
  vi.stubGlobal('requestIdleCallback', undefined)
  vi.stubGlobal('cancelIdleCallback', undefined)
  const html = HTMLElement.prototype as unknown as Record<string, unknown>
  const previousScroll = Object.getOwnPropertyDescriptor(html, 'scrollHeight')
  const previousClient = Object.getOwnPropertyDescriptor(html, 'clientHeight')
  Object.defineProperty(html, 'scrollHeight', { configurable: true, get: () => { scrollReads++; return 100 } })
  Object.defineProperty(html, 'clientHeight', { configurable: true, get: () => 50 })
  restoreSize = () => {
    if (previousScroll) Object.defineProperty(html, 'scrollHeight', previousScroll)
    else delete html.scrollHeight
    if (previousClient) Object.defineProperty(html, 'clientHeight', previousClient)
    else delete html.clientHeight
  }
})

afterEach(() => {
  cleanup()
  restoreSize?.()
  restoreSize = null
  vi.unstubAllGlobals()
})

it('does not read layout until the card approaches the viewport', () => {
  render(<Harness />)
  expect(scrollReads).toBe(0)
  expect(screen.getByTestId('preview').getAttribute('data-overflow')).toBe('false')

  intersect(false)
  expect(scrollReads).toBe(0)

  intersect(true)
  expect(scrollReads).toBe(0)
  flushFrames()
  expect(scrollReads).toBeGreaterThan(0)
  expect(screen.getByTestId('preview').getAttribute('data-overflow')).toBe('true')
})

it('does not observe when the preview is expanded', () => {
  render(<Harness enabled={false} />)
  expect(observers).toHaveLength(0)
  expect(scrollReads).toBe(0)
})
