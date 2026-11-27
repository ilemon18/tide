import { useEffect, useState, type RefObject } from 'react'

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (id: number) => void
}

/** Run after the current commit so mount never waits on transcript layout. */
function scheduleIdleMeasure(measure: () => void): () => void {
  if (typeof window === 'undefined') {
    measure()
    return () => {}
  }
  const idleWindow = window as IdleWindow
  if (typeof idleWindow.requestIdleCallback === 'function') {
    const id = idleWindow.requestIdleCallback(measure, { timeout: 200 })
    return () => idleWindow.cancelIdleCallback?.(id)
  }
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(id)
  }
  const id = window.setTimeout(measure, 0)
  return () => window.clearTimeout(id)
}

/**
 * Tracks whether a clamped preview overflows. Measurement is deferred until the card nears the
 * viewport; mounting a long transcript must not synchronously read layout for every tool card.
 */
export function useOverflowMeasure(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  version: string,
): boolean {
  const [overflow, setOverflow] = useState(false)

  useEffect(() => {
    const el = ref.current
    if (!el || !enabled) return
    let disposed = false
    let resize: ResizeObserver | null = null
    let cancelScheduled: (() => void) | null = null
    let intersection: IntersectionObserver | null = null

    const measure = () => {
      if (disposed) return
      const next = el.scrollHeight > el.clientHeight + 1
      setOverflow(previous => previous === next ? previous : next)
    }
    const schedule = () => {
      cancelScheduled?.()
      cancelScheduled = scheduleIdleMeasure(() => {
        cancelScheduled = null
        measure()
      })
    }
    const begin = () => {
      if (disposed) return
      // Observe size changes only after the card has been seen once; offscreen cards stay cheap.
      if (!resize && typeof ResizeObserver !== 'undefined') {
        resize = new ResizeObserver(schedule)
        resize.observe(el)
      }
      schedule()
    }

    if (typeof IntersectionObserver === 'undefined') {
      begin()
    } else {
      intersection = new IntersectionObserver((entries) => {
        if (!entries.some(entry => entry.isIntersecting)) return
        intersection?.disconnect()
        intersection = null
        begin()
      }, { rootMargin: '240px 0px' })
      intersection.observe(el)
    }

    return () => {
      disposed = true
      cancelScheduled?.()
      intersection?.disconnect()
      resize?.disconnect()
    }
  }, [enabled, ref, version])

  return overflow
}
