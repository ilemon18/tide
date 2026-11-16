import { createPortal } from 'react-dom'
import { basename } from '../lib/paths'
import { useFileDragGhost } from '../lib/fileDragState'
import { FileIcon } from './FileIcon'

/**
 * Cursor-following ghost while dragging a file. Portaled to body (the sidebar's overflow:hidden would clip it)
 * with pointer-events:none so `elementFromPoint` always hits the real target pane.
 */
export function FileDragGhost() {
  const ghost = useFileDragGhost((s) => s.ghost)
  if (!ghost) return null
  return createPortal(
    <div className="tab-drag-ghost" style={{ left: ghost.x, top: ghost.y }}>
      <FileIcon name={basename(ghost.name)} size={14} className="shrink-0" />
      <span className="truncate">{ghost.name}</span>
    </div>,
    document.body,
  )
}