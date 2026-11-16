/**
 * Layout drag state broadcast. While a splitter is dragged the container resizes every frame, and
 * the terminal / editor re-layouting (fit / measure) on each one ends up misaligning lines and
 * overlapping text; this lets them skip it and correct once on release.
 */
type Listener = (dragging: boolean) => void

let dragging = false
const listeners = new Set<Listener>()

export function isLayoutDragging(): boolean {
  return dragging
}

export function setLayoutDragging(next: boolean): void {
  if (dragging === next) return
  dragging = next
  for (const listener of listeners) listener(next)
}

export function onLayoutDragging(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}