import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { setLayoutDragging } from '../lib/layoutBus'

type Props = {
  direction: 'v' | 'h'
  onDrag: (delta: number) => void
  onCommit?: () => void
  /** 'editor' draws a hairline along the boundary (editor split); omitted keeps the invisible handle */
  tone?: 'editor'
}

/** Minimal splitter: reports incremental deltas and lets the caller clamp; deltas merge per frame so a move doesn't re-render the whole tree. */
export function Splitter({ direction, onDrag, onCommit, tone }: Props) {
  const [dragging, setDragging] = useState(false)
  const last = useRef({ x: 0, y: 0 })
  const pending = useRef(0)
  const frame = useRef(0)
  const active = useRef(false)

  const flush = () => {
    if (!frame.current) return
    cancelAnimationFrame(frame.current)
    frame.current = 0
    const delta = pending.current
    pending.current = 0
    if (delta !== 0) onDrag(delta)
  }

  useEffect(() => {
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current)
      frame.current = 0
      // Release the state even if the component unmounts mid-drag (layout switch / panel close)
      if (active.current) {
        active.current = false
        setLayoutDragging(false)
      }
    }
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    last.current = { x: e.clientX, y: e.clientY }
    pending.current = 0
    active.current = true
    setDragging(true)
    setLayoutDragging(true)
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    pending.current += direction === 'v' ? e.clientX - last.current.x : e.clientY - last.current.y
    last.current = { x: e.clientX, y: e.clientY }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const delta = pending.current
      pending.current = 0
      if (delta !== 0) onDrag(delta)
    })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    flush()
    active.current = false
    setDragging(false)
    setLayoutDragging(false)
    onCommit?.()
  }

  return (
    <div
      data-dragging={dragging}
      data-tone={tone}
      className={direction === 'v' ? 'splitter-v shrink-0' : 'splitter-h shrink-0'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  )
}