import { type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'

/**
 * Indent guides (the VSCode vertical bars). CodeMirror has none, so this uses a line decoration plus a
 * background gradient: indented lines get `.cm-indent-guide` with the level in `--cm-indent`. CSS draws one
 * 1px stripe per `--cm-indent-w` step (= measured monospace char width × tabSize, recomputed on font change),
 * with width limited to level × step, so 3 levels of indent give 3 lines.
 */

/** Width of one indent step in pixels */
function indentStep(view: EditorView, tabSize: number): number {
  const charWidth = view.defaultCharacterWidth || 8
  return Math.max(4, charWidth * Math.max(1, tabSize))
}

/** How many columns the leading indent spans (Tab advances to the next tab stop) */
function indentColumns(text: string, tabSize: number): number {
  let cols = 0
  for (const ch of text) {
    if (ch === ' ') {
      cols += 1
    } else if (ch === '\t') {
      cols += tabSize - (cols % tabSize)
    } else {
      break
    }
  }
  return cols
}

/** One decoration per indent level (instances are shared, but they inline the level, so cache per level) */
const guideCache = new Map<number, Decoration>()

function guideFor(levels: number): Decoration {
  let decoration = guideCache.get(levels)
  if (!decoration) {
    decoration = Decoration.line({
      class: 'cm-indent-guide',
      attributes: { style: `--cm-indent:${levels}` },
    })
    guideCache.set(levels, decoration)
  }
  return decoration
}

/** Decorate only visible lines: like syntax highlighting this is viewport based, so long files stay responsive */
function buildGuides(view: EditorView, tabSize: number): DecorationSet {
  const ranges: Range<Decoration>[] = []
  const { doc } = view.state
  for (const visible of view.visibleRanges) {
    let line = doc.lineAt(visible.from)
    for (;;) {
      const leading = line.text.length - line.text.trimStart().length
      if (leading > 0) {
        const columns = indentColumns(line.text.slice(0, leading), tabSize)
        const levels = Math.floor(columns / tabSize)
        if (levels > 0) {
          ranges.push(guideFor(levels).range(line.from))
        }
      }
      if (line.to >= doc.length || line.to > visible.to) break
      line = doc.line(line.number + 1)
    }
  }
  return Decoration.set(ranges, true)
}

export function indentGuides(tabSize: number): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      private readonly view: EditorView
      private step = -1

      constructor(view: EditorView) {
        this.view = view
        this.syncStep()
        this.decorations = buildGuides(view, tabSize)
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = buildGuides(update.view, tabSize)
        }
        if (update.geometryChanged) this.syncStep()
      }

      /** Step width is written as a CSS variable on the content element and must be recomputed on font / size change */
      private syncStep() {
        const step = indentStep(this.view, tabSize)
        if (Math.abs(step - this.step) < 0.5) return
        this.step = step
        this.view.contentDOM.style.setProperty('--cm-indent-w', `${step}px`)
      }

      destroy() {
        this.view.contentDOM.style.removeProperty('--cm-indent-w')
      }
    },
    { decorations: (value) => value.decorations },
  )
}