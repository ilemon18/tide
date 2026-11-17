import type { OutlineKind } from '../editor/outline'

/** Small letter badges instead of one SVG per symbol kind: compact and readable at 12–14px. */
const GLYPHS: Record<OutlineKind, { text: string; className: string }> = {
  class: { text: 'C', className: 'text-accent' },
  interface: { text: 'I', className: 'text-accent' },
  enum: { text: 'E', className: 'text-accent' },
  struct: { text: 'S', className: 'text-accent' },
  trait: { text: 'T', className: 'text-accent' },
  type: { text: 'T', className: 'text-warning' },
  function: { text: 'F', className: 'text-success' },
  method: { text: 'M', className: 'text-success' },
  property: { text: 'P', className: 'text-warning' },
  variable: { text: 'V', className: 'text-muted' },
  module: { text: 'N', className: 'text-accent' },
  heading: { text: 'H', className: 'text-muted' },
  rule: { text: '#', className: 'text-accent' },
  key: { text: 'K', className: 'text-warning' },
}

export function SymbolGlyph({ kind, size = 14 }: { kind: OutlineKind; size?: number }) {
  const glyph = GLYPHS[kind]
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center font-semibold leading-none ${glyph.className}`}
      style={{ width: size, fontSize: Math.max(9, size - 4) }}
    >
      {glyph.text}
    </span>
  )
}
