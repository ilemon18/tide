import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | {
      type?: 'item'
      label: string
      description?: string
      shortcut?: string
      danger?: boolean
      disabled?: boolean
      onClick: () => void
    }
  | { type: 'separator' }

type Props = {
  x: number
  y: number
  items: MenuItem[]
  onClose: () => void
  /** Long lists (agent models) scroll instead of running off the screen */
  maxHeight?: number
}

export function ContextMenu({ x, y, items, onClose, maxHeight }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({
      x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    })
  }, [x, y, items, maxHeight])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Menus are a layer above the editor and agent. Escape dismisses the menu only; letting the
      // same key reach the focused chat would also cancel a running turn.
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[190px] rounded-popup border border-line-soft bg-panel py-1 shadow-popup"
      style={{ left: pos.x, top: pos.y, maxHeight, overflowY: maxHeight ? 'auto' : undefined }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if (item.type === 'separator') {
          return <div key={`sep-${i}`} className="mx-2 my-1 h-px bg-line-soft" />
        }
        return (
          <button
            key={`${item.label}-${i}`}
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onClick()
            }}
            className={`mx-1 flex ${item.description ? 'min-h-6 max-w-[340px] py-1.5' : 'h-6'} w-[calc(100%_-_8px)] items-center justify-between gap-6 rounded-[var(--r-row)] px-2 text-left text-sm transition-colors duration-fast ${
              item.disabled
                ? 'cursor-default text-muted/50'
                : `hover:bg-hover ${item.danger ? 'text-danger' : 'text-fg'}`
            }`}
          >
            <span className="min-w-0"><span className="block truncate">{item.label}</span>{item.description ? <span className="block whitespace-normal text-xs text-muted">{item.description}</span> : null}</span>
            {item.shortcut ? <span className="shrink-0 text-xs text-muted/70">{item.shortcut}</span> : null}
          </button>
        )
      })}
    </div>
  )
}
