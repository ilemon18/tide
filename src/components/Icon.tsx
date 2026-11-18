import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'files'
  | 'structure'
  | 'git'
  | 'settings'
  | 'terminal'
  | 'terminal-panel'
  | 'search'
  | 'eye'
  | 'home'
  | 'chevron-right'
  | 'chevron-down'
  | 'plus'
  | 'minus'
  | 'folder-plus'
  | 'refresh'
  | 'download'
  | 'collapse'
  | 'expand'
  | 'close'
  | 'more'
  | 'arrow-up'
  | 'arrow-down'
  | 'check'
  | 'check-circle'
  | 'alert-circle'
  | 'info'
  | 'clock'
  | 'undo'
  | 'trash'
  | 'pen'
  | 'sun'
  | 'moon'
  | 'leaf'
  | 'monitor'
  | 'dot'
  | 'command'
  | 'warning'
  | 'spinner'
  | 'folder-open'
  | 'filter'
  | 'window'
  | 'window-minimize'
  | 'window-maximize'
  | 'window-restore'
  | 'external'
  | 'copy'
  | 'palette'
  | 'format'
  | 'split-right'
  | 'pin'
  | 'sparkle'
  | 'replace'
  | 'agent'
  | 'send'
  | 'stop'

const shapes: Record<IconName, ReactNode> = {
  // Sparkle: the agent entry (large four-point star with a small companion)
  agent: (
    <>
      <path d="M11 3.5 12.7 9l5.5 1.7-5.5 1.7L11 18l-1.7-5.6L3.8 10.7 9.3 9 11 3.5Z" />
      <path d="M18.2 15.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8.8-2.1Z" />
    </>
  ),
  // Paper plane: send
  send: (
    <>
      <path d="M4.5 11.5 20 4l-5 16-3.6-6.2L4.5 11.5Z" />
      <path d="M11.4 13.8 20 4" />
    </>
  ),
  stop: (
    <>
      <rect x="6.5" y="6.5" width="11" height="11" rx="2.2" />
    </>
  ),
  // Two arrows swapping places: replace / swap
  replace: (
    <>
      <path d="M4 8h12l-3-3" />
      <path d="M20 16H8l3 3" />
    </>
  ),
  // Format: three uneven bars, matching the "tidy up the code" intuition
  format: (
    <>
      <path d="M4 6h16" />
      <path d="M4 12h10" />
      <path d="M4 18h13" />
    </>
  ),
  files: (
    <>
      <path d="M8.5 3.5h5L18 8v8.5a1.5 1.5 0 0 1-1.5 1.5H8.5A1.5 1.5 0 0 1 7 16.5v-11a1.5 1.5 0 0 1 1.5-2Z" />
      <path d="M13 3.5V8h4.5" />
      <path d="M4.5 7.5v11A2.5 2.5 0 0 0 7 21h7" />
    </>
  ),
  // Outline / structure: one trunk with two branches
  structure: (
    <>
      <path d="M5 4.5v15" />
      <path d="M5 7.5h4M5 16.5h4" />
      <path d="M9 7.5h10M9 16.5h10" />
    </>
  ),
  git: (
    <>
      <circle cx="6.5" cy="6" r="2.2" />
      <circle cx="6.5" cy="18" r="2.2" />
      <circle cx="17.5" cy="8" r="2.2" />
      <path d="M6.5 8.2v7.6" />
      <path d="M8.7 8.2A5 5 0 0 0 15.3 8.2" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="10" cy="17" r="2" />
    </>
  ),
  terminal: (
    <>
      <path d="M4 6.5 9 12l-5 5.5" />
      <path d="M12.5 18h7.5" />
    </>
  ),
  // Same stroke language as settings (rounded box + thin lines + round caps); the activity bar's terminal entry
  'terminal-panel': (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.2" />
      <path d="M7.6 9.6 10.3 12 7.6 14.4" />
      <path d="M12.4 14.6h4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5 20 20" />
    </>
  ),
  eye: (
    <>
      <path d="M2.8 12S6.4 6.4 12 6.4 21.2 12 21.2 12 17.6 17.6 12 17.6 2.8 12 2.8 12Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6.5 9.5V20h11V9.5" />
      <path d="M10 20v-5h4v5" />
    </>
  ),
  'chevron-right': <path d="M9.5 5.5 16 12l-6.5 6.5" />,
  'chevron-down': <path d="M5.5 9.5 12 16l6.5-6.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  'folder-plus': (
    <>
      <path d="M3.5 6.5a1.5 1.5 0 0 1 1.5-1.5h3.6l1.8 2h8.6a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5v-11Z" />
      <path d="M12 11v6M9 14h6" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20.5 4v5h-5" />
    </>
  ),
  collapse: (
    <>
      <path d="M9 4v5H4M15 20v-5h5" />
    </>
  ),
  expand: (
    <>
      <path d="M4 9h5V4M20 15h-5v5" />
    </>
  ),
  close: <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />,
  more: (
    <>
      <circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  'arrow-up': <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
  'arrow-down': <path d="M12 5v14M5.5 12.5 12 19l6.5-6.5" />,
  check: <path d="M4.5 12.5 9.5 17.5 19.5 6.5" />,
  // Semantic icon with a round frame (used by toasts): distinct from the bare check / warning shapes
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M8.2 12.3 10.8 14.9 15.9 9.4" />
    </>
  ),
  'alert-circle': (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.7v5" />
      <circle cx="12" cy="16.2" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 11.2v5.1" />
      <circle cx="12" cy="7.9" r="1.05" fill="currentColor" stroke="none" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2v5.1l3.1 1.9" />
    </>
  ),
  undo: (
    <>
      <path d="M8.5 6 4 10.5 8.5 15" />
      <path d="M4 10.5h9.5a6 6 0 0 1 0 12H10" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16" />
      <path d="M9.5 7V4.5h5V7" />
      <path d="M6.5 7l1 13h9l1-13" />
      <path d="M10.5 11v5M13.5 11v5" />
    </>
  ),
  pen: (
    <>
      <path d="M4 20h4L19 9l-4-4L4 16v4Z" />
      <path d="M14.5 5.5 18 9" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5 5l1.4 1.4M17.6 17.6 19 19M19 5l-1.4 1.4M6.4 17.6 5 19" />
    </>
  ),
  moon: <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" />,
  leaf: (
    <>
      <path d="M20 4c-8 0-14 4.5-14 10a5 5 0 0 0 5 5c5.5 0 9-6 9-15Z" />
      <path d="M4 20c2-6 6-9.5 11-12" />
    </>
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6M12 16.5V20" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
  command: (
    <>
      <path d="M8.5 8.5h7v7h-7z" />
      <path d="M8.5 8.5V6a2.5 2.5 0 1 0-2.5 2.5h2.5ZM15.5 8.5V6A2.5 2.5 0 1 1 18 8.5h-2.5ZM8.5 15.5V18a2.5 2.5 0 1 1-2.5-2.5h2.5ZM15.5 15.5V18a2.5 2.5 0 1 0 2.5-2.5h-2.5Z" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 10v4.5M12 17.4v.1" />
    </>
  ),
  spinner: <path d="M12 3a9 9 0 1 0 9 9" />,
  // Download: a falling arrow pressing onto a tray
  download: (
    <>
      <path d="M12 4v10" />
      <path d="M8 10.5 12 14.5l4-4" />
      <path d="M4.5 19.5h15" />
    </>
  ),
  window: (
    <>
      <rect x="3" y="5" width="12.5" height="10.5" rx="1.6" />
      <path d="M6.5 19h10A3.5 3.5 0 0 0 20 15.5V8.5" />
      <path d="M5.5 8h7.5" />
    </>
  ),
  'window-minimize': <path d="M6 12h12" />,
  'window-maximize': <rect x="6" y="6" width="12" height="12" rx="0.5" />,
  'window-restore': (
    <>
      <rect x="5.5" y="8.5" width="10" height="10" rx="0.5" />
      <path d="M8.5 8.5v-3h10v10h-3" />
    </>
  ),
  // External: an arrow leaving a box, for "this opens outside the app"
  external: (
    <>
      <path d="M13.5 4.5h6v6" />
      <path d="M19.2 4.8 11.5 12.5" />
      <path d="M18 14.5v3.4a1.6 1.6 0 0 1-1.6 1.6H5.6A1.6 1.6 0 0 1 4 17.9V7.1a1.6 1.6 0 0 1 1.6-1.6h3.4" />
    </>
  ),
  'folder-open': (
    <>
      <path d="M3.5 8V6.5A1.5 1.5 0 0 1 5 5h3.6l1.8 2h6.1a1.5 1.5 0 0 1 1.5 1.5V9" />
      <path d="M3.5 9.5h17l-2 9.5H5.5l-2-9.5Z" />
    </>
  ),
  // Funnel: the search panel's "file filter" toggle
  filter: <path d="M3.5 5.5h17l-6.4 7.4v5.7l-4.2-2.3v-3.4L3.5 5.5Z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="10" height="11" rx="1.8" />
      <path d="M6 15.5H5.5A1.5 1.5 0 0 1 4 14V5.5A1.5 1.5 0 0 1 5.5 4H14a1.5 1.5 0 0 1 1.5 1.5V6" />
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.9 2-1.9 0-1.3-1-1.7-1-2.9 0-1 .8-1.7 1.9-1.7H17a3.5 3.5 0 0 0 3.5-3.5c0-3.9-3.8-7-8.5-7Z" />
      <circle cx="8" cy="9" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="12" cy="7.4" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="7.2" cy="13.6" r="1.15" fill="currentColor" stroke="none" />
    </>
  ),
  // Split editor right: the left half is the current pane, the right half the new one
  'split-right': (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M12 4.5v15" />
      <path d="M15.2 9.2 18 12l-2.8 2.8" />
    </>
  ),
  // Pushpin for pinned tabs (cap, body, tip — readable even at 16px)
  pin: (
    <>
      <path d="M9 4h6" />
      <path d="M10 4v6l-2 4h8l-2-4V4" />
      <path d="M12 14v6" />
    </>
  ),
  // Four-point star for skill chips
  sparkle: (
    <path d="M12 3.5l1.7 5.1 5.1 1.7-5.1 1.7-1.7 5.1-1.7-5.1-5.1-1.7 5.1-1.7Z" />
  ),
}

type Props = SVGProps<SVGSVGElement> & {
  name: IconName
  size?: number
  strokeWidth?: number
}

export function Icon({ name, size = 16, strokeWidth = 1.6, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {shapes[name]}
    </svg>
  )
}
