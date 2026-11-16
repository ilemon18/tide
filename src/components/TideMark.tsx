/**
 * Tide's wave mark: `brand` = dark teal gradient rounded block + white double wave (welcome page);
 * `muted` = no background, plain currentColor gray (empty editor pane).
 */
type Props = {
  size?: number
  tone?: 'brand' | 'muted'
  className?: string
}

export function TideMark({ size = 48, tone = 'brand', className }: Props) {
  const glyph = (
    <svg
      width={Math.round(size / 2)}
      height={Math.round(size / 2)}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 9.2q2.5-3 5 0t5 0t5 0t5 0"
        stroke="currentColor"
        strokeOpacity={tone === 'muted' ? 0.55 : 0.62}
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M2 14.6q2.5-3 5 0t5 0t5 0t5 0"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  )

  if (tone === 'muted') {
    return (
      <div
        className={`flex items-center justify-center text-muted/30 ${className ?? ''}`}
        style={{ width: size, height: size }}
      >
        {glyph}
      </div>
    )
  }

  return (
    <div
      className={`flex items-center justify-center rounded-xl text-white ${className ?? ''}`}
      style={{ width: size, height: size, background: 'linear-gradient(160deg,#0e3b42,#04171b)' }}
    >
      {glyph}
    </div>
  )
}