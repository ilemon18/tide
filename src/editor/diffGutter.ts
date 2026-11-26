import { RangeSet, RangeSetBuilder, StateEffect, StateField, type Extension, type Text } from '@codemirror/state'
import { EditorView, GutterMarker, gutter } from '@codemirror/view'
import type { DiffMark, DiffMarkKind } from '../lib/diffMarks'
import type { BlameResult } from '../lib/ipc'
import { blameField, showBlameAtLine, showBlameRange } from './blame'

type BlameProvider = () => Promise<BlameResult | null>
const blameProviders = new WeakMap<EditorView, BlameProvider>()
let clickSequence = 0

/** EditorHost supplies the active file so a bar click can fetch blame even when inline blame is off. */
export function setDiffGutterBlameProvider(view: EditorView, provider: BlameProvider | null): void {
  if (provider) blameProviders.set(view, provider)
  else blameProviders.delete(view)
}

class DiffMarkMarker extends GutterMarker {
  elementClass = 'cm-diff-gutter-hit'

  constructor(readonly kind: DiffMarkKind) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof DiffMarkMarker && other.kind === this.kind
  }

  toDOM(): HTMLElement {
    const bar = document.createElement('span')
    bar.className = `cm-diff-mark cm-diff-mark-${this.kind}`
    bar.setAttribute('aria-hidden', 'true')
    return bar
  }
}

const MARKERS: Record<DiffMarkKind, DiffMarkMarker> = {
  add: new DiffMarkMarker('add'),
  mod: new DiffMarkMarker('mod'),
  del: new DiffMarkMarker('del'),
}

/** Keeps the gutter column reserved before the first change arrives, so text never shifts sideways. */
class DiffGutterSpacer extends GutterMarker {
  toDOM(): HTMLElement {
    const spacer = document.createElement('span')
    spacer.className = 'cm-diff-mark cm-diff-mark-spacer'
    spacer.setAttribute('aria-hidden', 'true')
    return spacer
  }
}

const SPACER = new DiffGutterSpacer()

type DiffGutterState = {
  marks: DiffMark[]
  ranges: RangeSet<GutterMarker>
}

export const setDiffMarksEffect = StateEffect.define<DiffMark[]>()

/**
 * Build one marker per changed line. Several marks may overlap after a save while the patch is
 * still settling; a line is drawn once, first mark wins (marks are already ordered by line).
 */
export function buildDiffGutterRanges(doc: Text, marks: readonly DiffMark[]): RangeSet<GutterMarker> {
  if (marks.length === 0 || doc.lines === 0) return RangeSet.empty
  const lines = new Map<number, DiffMarkKind>()
  for (const mark of marks) {
    const from = Math.min(Math.max(1, mark.from), doc.lines)
    const to = Math.min(Math.max(from, mark.to), doc.lines)
    for (let line = from; line <= to; line += 1) {
      if (!lines.has(line)) lines.set(line, mark.kind)
    }
  }
  const ordered = [...lines.entries()].sort((a, b) => a[0] - b[0])
  const builder = new RangeSetBuilder<GutterMarker>()
  for (const [lineNo, kind] of ordered) {
    const line = doc.line(lineNo)
    builder.add(line.from, line.from, MARKERS[kind])
  }
  return builder.finish()
}

const diffGutterField = StateField.define<DiffGutterState>({
  create: () => ({ marks: [], ranges: RangeSet.empty }),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setDiffMarksEffect)) continue
      return {
        marks: effect.value,
        ranges: buildDiffGutterRanges(tr.state.doc, effect.value),
      }
    }
    if (tr.docChanged) {
      // Typing before the next save keeps the old disk-based marks roughly in place; the save
      // reloads the real patch and replaces them.
      return { marks: value.marks, ranges: value.ranges.map(tr.changes) }
    }
    return value
  },
})

/** A thin change bar left of the line numbers; colours match the file tree's Git marks. */
export const diffMarksGutter: Extension = [
  diffGutterField,
  gutter({
    class: 'cm-diff-gutter',
    markers: (view) => view.state.field(diffGutterField).ranges,
    initialSpacer: () => SPACER,
    domEventHandlers: {
      click(view, line, event) {
        const target = event.target instanceof Element ? event.target : null
        const row = target?.closest<HTMLElement>('.cm-diff-gutter-hit')
        if (!row) return false
        event.preventDefault()
        const lineNumber = view.state.doc.lineAt(line.from).number
        view.dispatch({ selection: { anchor: line.from }, scrollIntoView: false })
        const rect = row.getBoundingClientRect()
        const anchor = {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
        }
        const sequence = ++clickSequence
        const blame = view.state.field(blameField, false)
        if (!showBlameAtLine(view, lineNumber, anchor) && (!blame || blame.disabled)) {
          const provider = blameProviders.get(view)
          if (provider) {
            void provider()
              .then((data) => {
                if (sequence === clickSequence && data) showBlameRange(data, lineNumber, anchor)
              })
              .catch(() => {})
          }
        }
        view.focus()
        return true
      },
    },
  }),
]

/** Apply marks to a live view; a no-op when the same array is already shown. */
export function applyDiffMarks(view: EditorView, marks: DiffMark[]): void {
  const field = view.state.field(diffGutterField, false)
  if (!field) return
  if (field.marks === marks) return
  view.dispatch({ effects: setDiffMarksEffect.of(marks) })
}
