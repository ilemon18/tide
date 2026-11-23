import { memo } from 'react'
import { Icon } from './Icon'

/** Animate an HTML box so WebKit can composite rotation independently of SVG painting. */
export const AgentSpinner = memo(function AgentSpinner({ size = 12 }: { size?: number }) {
  return (
    <span aria-hidden="true" className="agent-spinner shrink-0 text-accent" style={{ width: size, height: size }}>
      <Icon name="spinner" size={size} />
    </span>
  )
})
