import { countColumn, findColumn, EditorSelection, type EditorState } from '@codemirror/state'
import { EditorView, type MouseSelectionStyle } from '@codemirror/view'

export type AltCursorColumn = 'start' | 'end' | number

/** Map blank space to real text positions, never to virtual columns or annotation geometry. */
export function cursorAtPoint(view: EditorView, point: { x: number; y: number }): number | null {
  const block = view.lineBlockAtHeight(point.y - view.documentTop)
  const line = view.state.doc.lineAt(block.from)
  if (!line.length) return line.from
  const end = view.coordsAtPos(line.to, -1)
  // A wrapped line's earlier visual rows must still use CodeMirror hit testing.
  if (end && point.y >= end.top && point.y <= end.bottom && point.x >= end.right) {
    return line.to
  }
  return view.posAtCoords(point, false)
}

/** Empty selections per logical line; end mode follows each line's own length. */
export function lineCursors(state: EditorState, from: number, to: number, column: AltCursorColumn) {
  const first = state.doc.lineAt(from).number
  const last = state.doc.lineAt(to).number
  const ranges = []
  for (let number = Math.min(first, last); number <= Math.max(first, last); number++) {
    const line = state.doc.line(number)
    const position =
      column === 'end'
        ? line.to
        : line.from + (column === 'start' ? 0 : findColumn(line.text, column, state.tabSize))
    ranges.push(EditorSelection.cursor(position))
  }
  return EditorSelection.create(ranges, last < first ? 0 : ranges.length - 1)
}

export function altSelectionStyle(view: EditorView, event: MouseEvent): MouseSelectionStyle | null {
  if (!event.altKey || event.button !== 0 || !view.contentDOM.contains(event.target as Node))
    return null
  let start = cursorAtPoint(view, { x: event.clientX, y: event.clientY })
  if (start === null) return null
  const line = view.state.doc.lineAt(start)
  const column: AltCursorColumn =
    start === line.from
      ? 'start'
      : start === line.to
        ? 'end'
        : countColumn(line.text, view.state.tabSize, start - line.from)
  let original = view.state.selection
  return {
    get(current) {
      const position = cursorAtPoint(view, { x: current.clientX, y: current.clientY }) ?? start!
      if (
        Math.abs(current.clientX - event.clientX) >= 4 ||
        Math.abs(current.clientY - event.clientY) >= 4
      ) {
        return lineCursors(view.state, start!, position, column)
      }
      return EditorSelection.create(
        [
          ...original.ranges.map((range) => EditorSelection.cursor(range.head)),
          EditorSelection.cursor(position),
        ],
        original.ranges.length,
      )
    },
    update(update) {
      if (update.docChanged) {
        start = update.changes.mapPos(start!)
        original = original.map(update.changes)
      }
    },
  }
}

export const altSelection = [
  EditorView.clickAddsSelectionRange.of((event) => event.altKey),
  EditorView.mouseSelectionStyle.of(altSelectionStyle),
]
