import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

/**
 * Global tooltip layer. The native title delay is system-defined (often 1-2s on macOS) and unstylable,
 * so we roll our own: one listener shows a bubble for any hovered [data-tip] element;
 * data-tip-side picks top / bottom / right (default bottom).
 *
 * Width is measured first, then the side is chosen; near the right edge the bubble is not squeezed
 * but anchored to the button's right edge and expanded leftwards (an earlier version hard-coded
 * maxWidth=260, wrapping long tooltips of right-side buttons onto several lines).
 */
const SHOW_DELAY = 40
const GAP = 6
const EDGE = 8
/** Max bubble width: wrap beyond this instead of spanning half the screen */
const MAX_WIDTH = 420

type Side = 'top' | 'bottom' | 'right'

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number }

type Tip = {
  text: string
  side: Side
  rect: Rect
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

export function TooltipLayer() {
  const [tip, setTip] = useState<Tip | null>(null)
  const [place, setPlace] = useState<CSSProperties | null>(null)
  const timer = useRef<number | null>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current)
        timer.current = null
      }
    }

    const hide = () => {
      clearTimer()
      anchor.current = null
      setTip(null)
      setPlace(null)
    }

    const show = (el: HTMLElement) => {
      const text = el.getAttribute('data-tip')
      if (!text) return
      const side = (el.getAttribute('data-tip-side') as Side | null) ?? 'bottom'
      const r = el.getBoundingClientRect()
      setPlace(null)
      setTip({
        text,
        side,
        rect: {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        },
      })
    }

    const onOver = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.('[data-tip]') as HTMLElement | null
      if (!target) return
      if (target === anchor.current) return
      clearTimer()
      anchor.current = target
      setTip(null)
      setPlace(null)
      // 40ms filters out pointer fly-by yet still feels immediate once you stop
      timer.current = window.setTimeout(() => {
        timer.current = null
        if (anchor.current === target) show(target)
      }, SHOW_DELAY)
    }

    const onOut = (event: PointerEvent) => {
      const target = (event.target as Element | null)?.closest?.('[data-tip]')
      if (!target) return
      const next = (event.relatedTarget as Element | null)?.closest?.('[data-tip]')
      if (next === target) return
      hide()
    }

    document.addEventListener('pointerover', onOver, true)
    document.addEventListener('pointerout', onOut, true)
    document.addEventListener('pointerdown', hide, true)
    document.addEventListener('scroll', hide, true)
    window.addEventListener('blur', hide)
    return () => {
      hide()
      document.removeEventListener('pointerover', onOver, true)
      document.removeEventListener('pointerout', onOut, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('scroll', hide, true)
      window.removeEventListener('blur', hide)
    }
  }, [])

  // Measure first, then place: render at maxWidth (invisible), then position in one shot from real size
  useLayoutEffect(() => {
    const el = boxRef.current
    if (!tip || !el) return
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight
    const maxWidth = Math.max(120, Math.min(MAX_WIDTH, viewportW - EDGE * 2))
    const width = Math.min(el.offsetWidth, maxWidth)
    const height = el.offsetHeight
    const { rect } = tip

    let side: Side = tip.side
    // Flip up when there is no room below (status bar / bottom-right buttons), flip down when no room above
    if (side === 'bottom' && rect.bottom + GAP + height > viewportH - EDGE) side = 'top'
    else if (side === 'top' && rect.top - GAP - height < EDGE) side = 'bottom'

    if (side === 'right') {
      // Flip left when there is no room on the right; both cases keep the whole bubble on screen
      let left = rect.right + GAP
      if (left + width > viewportW - EDGE) left = rect.left - GAP - width
      setPlace({
        left: Math.round(clamp(left, EDGE, Math.max(EDGE, viewportW - EDGE - width))),
        top: Math.round(
          clamp(rect.top + rect.height / 2 - height / 2, EDGE, Math.max(EDGE, viewportH - EDGE - height)),
        ),
        maxWidth,
      })
      return
    }

    // When centering does not fit, align to an edge: with no space on the right let the bubble
    // expand leftwards instead of narrowing it (which would wrap long text onto several lines)
    let left = rect.left + rect.width / 2 - width / 2
    if (left + width > viewportW - EDGE) left = rect.right - width
    if (left < EDGE) left = rect.left
    left = clamp(left, EDGE, Math.max(EDGE, viewportW - EDGE - width))

    const top = side === 'bottom' ? rect.bottom + GAP : rect.top - GAP - height
    setPlace({
      left: Math.round(left),
      top: Math.round(clamp(top, EDGE, Math.max(EDGE, viewportH - EDGE - height))),
      maxWidth,
    })
  }, [tip])

  if (!tip) return null

  const style: CSSProperties = {
    maxWidth: Math.max(120, Math.min(MAX_WIDTH, window.innerWidth - EDGE * 2)),
    // Hide during measurement so it does not flash in the top-left corner
    visibility: place ? 'visible' : 'hidden',
    ...(place ?? { left: 0, top: 0 }),
  }

  return (
    <div
      ref={boxRef}
      role="tooltip"
      className="pointer-events-none fixed z-[90] w-max break-words rounded-[var(--r-control)] border border-line-soft bg-panel-alt px-2 py-[3px] text-2xs leading-[1.35] text-fg shadow-popup"
      style={style}
    >
      {tip.text}
    </div>
  )
}