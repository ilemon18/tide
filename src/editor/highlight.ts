import { StateEffect, StateField, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'

export const flashEffect = StateEffect.define<{ from: number; to: number } | null>()

/** Short highlight when jumping to a search result */
const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(flashEffect)) {
        if (!effect.value) return Decoration.none
        const { from, to } = effect.value
        if (from >= to) return Decoration.none
        return Decoration.set([Decoration.mark({ class: 'cm-flash' }).range(from, to)])
      }
    }
    if (tr.docChanged) return Decoration.none
    return value
  },
  provide: (field) => EditorView.decorations.from(field),
})

let clearTimer: ReturnType<typeof setTimeout> | null = null

export function flashRange(view: EditorView, from: number, to: number) {
  view.dispatch({ effects: flashEffect.of({ from, to }) })
  if (clearTimer) clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    clearTimer = null
    try {
      view.dispatch({ effects: flashEffect.of(null) })
    } catch {
      /* The view may already be destroyed */
    }
  }, 1400)
}

/* ------------------------------------------------------------------ */
/* Jump target highlight: no auto-hide, until the user clicks elsewhere / the editor blurs / typing */
/* ------------------------------------------------------------------ */

const stickyEffect = StateEffect.define<{ from: number; to: number } | null>()

const stickyPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet = Decoration.none
    private last: { from: number; to: number } | null = null

    constructor(_view: EditorView) {}

    update(update: ViewUpdate) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (!effect.is(stickyEffect)) continue
          this.last = effect.value
          if (!effect.value) {
            this.decorations = Decoration.none
            return
          }
          // A blank line / zero-length match has no characters to mark, so fall back to a full-line tint
          this.decorations =
            effect.value.from < effect.value.to
              ? Decoration.set([
                  Decoration.mark({ class: 'cm-flash-sticky' }).range(
                    effect.value.from,
                    effect.value.to,
                  ),
                ])
              : Decoration.set([
                  Decoration.line({ class: 'cm-flash-line' }).range(effect.value.from),
                ])
          return
        }
      }
      // Editing or moving the cursor drops it: the highlight only serves the line just jumped to
      const touched = update.transactions.some(
        (tr) => tr.docChanged || tr.isUserEvent('select'),
      )
      if (touched && this.last) {
        this.last = null
        this.decorations = Decoration.none
      }
    }
  },
  { decorations: (v) => v.decorations },
)

/** Clear the jump target highlight on blur (clicking another panel or switching to the terminal counts) */
function clearSticky(view: EditorView) {
  try {
    view.dispatch({ effects: stickyEffect.of(null) })
  } catch {
    /* The view may already be destroyed */
  }
}

const stickyExtension: Extension = [
  stickyPlugin,
  EditorView.domEventHandlers({
    blur: (_event, view) => {
      clearSticky(view)
      return false
    },
  }),
]

/** Mark the jump target; stays until the user clicks elsewhere / blurs / types */
export function stickyRange(view: EditorView, from: number, to: number) {
  const doc = view.state.doc
  if (from < 0 || from > doc.length) return
  const end = Math.min(Math.max(to, from), doc.length)
  // A line decoration must start at the line start, so align zero-length matches to it first
  const anchor = end > from ? from : doc.lineAt(from).from
  view.dispatch({ effects: stickyEffect.of({ from: anchor, to: end }) })
}

export const flashExtension: Extension = [flashField, stickyExtension]