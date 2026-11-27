import { Compartment, Facet, type EditorState, type Extension } from '@codemirror/state'
import { syntaxTree } from '@codemirror/language'
import { NodeProp, type SyntaxNode } from '@lezer/common'
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { budget } from '../lib/memoryBudget'
import type { DocTier } from './largeFile'

type BracketMark = { from: number; to: number; depth: number }
const OPEN = new Set(['(', '[', '{'])
const CLOSE = new Set([')', ']', '}'])
const supported = Facet.define<boolean, boolean>({ combine: values => values.some(Boolean) })
const compartment = new Compartment()
const marks = Array.from({ length: 6 }, (_, depth) => Decoration.mark({ class: `cm-rainbow-bracket-${depth}` }))

/** Grammar metadata excludes string/comment punctuation and comparison operators. */
function bracket(node: SyntaxNode, state: EditorState): { from: number; opening: boolean } | null {
  if (node.to - node.from > 2 || node.to === node.from) return null
  const text = state.sliceDoc(node.from, node.to)
  const char = text.at(-1)!
  const opening = OPEN.has(char) && Boolean(node.type.prop(NodeProp.closedBy))
  const closing = CLOSE.has(char) && Boolean(node.type.prop(NodeProp.openedBy))
  return opening || closing ? { from: node.to - 1, opening } : null
}

/** Visible ranges only; ancestor groups keep off-screen nesting colors stable without a document scan. */
export function rainbowBracketMarks(state: EditorState, ranges: readonly { from: number; to: number }[]): BracketMark[] {
  const result: BracketMark[] = []
  const tree = syntaxTree(state)
  let visited = 0
  for (const range of ranges) {
    const cursor = tree.cursor()
    cursor.moveTo(range.from, 1)
    do {
      if (cursor.from >= range.to || ++visited > budget.rainbowNodes() || result.length >= budget.rainbowMarks()) break
      const node = cursor.node
      const token = bracket(node, state)
      if (!token || token.from < range.from || node.to > range.to) continue
      let depth = 0
      let steps = 0
      for (let parent = node.parent; parent && steps++ < budget.rainbowDepth(); parent = parent.parent) {
        const first = parent.firstChild
        if (first && bracket(first, state)?.opening) depth++
      }
      result.push({ from: token.from, to: node.to, depth: Math.max(0, depth - 1) % marks.length })
    } while (cursor.next())
    if (visited > budget.rainbowNodes() || result.length >= budget.rainbowMarks()) break
  }
  return result
}

function decorations(view: EditorView): DecorationSet {
  return Decoration.set(rainbowBracketMarks(view.state, view.visibleRanges)
    .map(mark => marks[mark.depth].range(mark.from, mark.to)), true)
}

const plugin = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  constructor(view: EditorView) { this.decorations = decorations(view) }
  update(update: ViewUpdate) {
    if (update.docChanged || update.viewportChanged || syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = decorations(update.view)
    }
  }
}, { decorations: value => value.decorations })

export function rainbowBracketsForTier(tier: DocTier): Extension {
  return [supported.of(tier === 'full'), compartment.of(tier === 'full' ? plugin : [])]
}

export function configureRainbowBrackets(view: EditorView, enabled: boolean) {
  view.dispatch({ effects: compartment.reconfigure(enabled && view.state.facet(supported) ? plugin : []) })
}
