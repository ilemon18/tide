type Side = 'left' | 'right'
type Axis = 'scrollTop' | 'scrollLeft'
type Position = Pick<HTMLElement, Axis>
type Pending = { side: Side; element: HTMLElement }

/** Coalesce real scrolls per axis; programmatic echoes are recognized at their clamped position. */
export function createDiffScroll(getPane: (side: Side) => HTMLElement | null) {
  let observed = new WeakMap<HTMLElement, Position>()
  let pending: Partial<Record<Axis, Pending>> = {}
  let frame: number | null = null
  const axes: Axis[] = ['scrollTop', 'scrollLeft']
  const read = (el: HTMLElement): Position => ({
    scrollTop: el.scrollTop,
    scrollLeft: el.scrollLeft,
  })

  const cancel = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    pending = {}
  }

  const write = (el: HTMLElement, position: Partial<Position>) => {
    for (const axis of axes) {
      const value = position[axis]
      if (value !== undefined && el[axis] !== value) el[axis] = value
    }
    // Read back: the narrower/shorter pane can clamp a requested offset.
    observed.set(el, read(el))
  }

  const flush = () => {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null
    const updates = new Map<HTMLElement, Partial<Position>>()
    for (const axis of axes) {
      const source = pending[axis]
      if (!source || getPane(source.side) !== source.element) continue
      const target = getPane(source.side === 'left' ? 'right' : 'left')
      if (!target) continue
      const position = read(source.element)
      const previous = observed.get(source.element) ?? position
      observed.set(source.element, { ...previous, [axis]: position[axis] })
      const update = updates.get(target) ?? {}
      update[axis] = position[axis]
      updates.set(target, update)
    }
    pending = {}
    // Gather both axes before writing: they may have different source panes.
    for (const [el, position] of updates) write(el, position)
  }

  return {
    onScroll(side: Side, el: HTMLElement) {
      if (getPane(side) !== el) return false
      const position = read(el)
      const previous = observed.get(el) ?? { scrollTop: 0, scrollLeft: 0 }
      observed.set(el, position)
      let changed = false
      for (const axis of axes) {
        if (position[axis] === previous[axis]) continue
        pending[axis] = { side, element: el }
        changed = true
      }
      if (changed && frame === null) frame = requestAnimationFrame(flush)
      return changed
    },
    jumpTo(top: number) {
      cancel()
      for (const side of ['left', 'right'] as const) {
        const el = getPane(side)
        if (el) write(el, { scrollTop: top })
      }
    },
    reset() {
      cancel()
      observed = new WeakMap()
      for (const side of ['left', 'right'] as const) {
        const el = getPane(side)
        if (el) observed.set(el, read(el))
      }
    },
    flush,
    cancel,
  }
}
