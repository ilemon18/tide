import type { EditorState, Extension } from '@codemirror/state'
import { foldService, syntaxTree } from '@codemirror/language'

/**
 * Fold ranges. CodeMirror's built-in folding relies on `foldNodeProp` from the grammar: function and class
 * bodies have it, but the arrow lands on the `{` line (with a split signature you must scroll to `) {`),
 * and Shell / TOML / Dockerfile / Markdown have none at all.
 *
 * Two extra layers: 1) declaration folding — when the node of the line's first token extends past the line,
 * the whole block folds and the arrow lands on the `function` line;
 * 2) indent fallback — languages without syntax folding infer it from indentation. If neither applies,
 * return null and leave it to syntaxFolding.
 */

type FoldRange = { from: number; to: number }

/** These are roots of the whole syntax tree, never use them as the upper bound of a fold */
const ROOT_NODES = new Set(['Program', 'Module', 'Script', 'SourceFile', 'Document'])

/** Max lines the fallback scans: a huge block gets no arrow rather than a scan of thousands of lines */
const MAX_INDENT_SCAN = 4000

/** Leading whitespace of a line */
const LEADING_SPACE = /^\s*/

/** Line ends with a block opener (`{` `(` `[` `:`), or the whole line is a continuation keyword like `else` / `try` */
const OPENS_BLOCK = /[{(:\[]\s*$/
const CONTINUATION_HEAD = /^(else|elif|except|finally|try|do|match|case)\b/

/** Indent width: a Tab counts as 4 columns, enough to compare levels without matching the real tabSize */
function indentWidth(text: string): number {
  let width = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === ' ') width += 1
    else if (ch === '\t') width += 4
    else break
  }
  return width
}

/**
 * "Declaration folding": walk up to the outermost node starting at this token. The range starts at the end
 * of this line, so `function foo(…) {…}` stays on one line with the closing `}` outside (like VSCode).
 */
function declarationRange(state: EditorState, lineStart: number): FoldRange | null {
  const tree = syntaxTree(state)
  const line = state.doc.lineAt(lineStart)
  if (tree.length < line.to) return null

  const indent = LEADING_SPACE.exec(line.text)
  const pos = line.from + (indent ? indent[0].length : 0)
  if (pos >= line.to) return null

  const node = tree.resolve(pos, 1)
  if (node.from !== pos) return null

  let outer = node
  while (outer.parent && outer.parent.from === pos && !ROOT_NODES.has(outer.parent.name)) {
    outer = outer.parent
  }
  if (outer.to <= line.to) return null
  // A whole-file node is not a fold range (StreamLanguage's root node matches easily)
  if (outer.from <= 0 && outer.to >= state.doc.length) return null

  let tail = outer
  while (tail.lastChild && tail.lastChild.to === tail.to) tail = tail.lastChild
  let to = outer.to
  // Only compare text for very short tokens (a single closing symbol) to avoid copying long token strings
  if (!tail.firstChild && tail.to - tail.from <= 1) {
    const text = state.doc.sliceString(tail.from, tail.to)
    if (text === '}' || text === ')' || text === ']') to = tail.from
  }
  return to > line.to ? { from: line.to, to } : null
}

/** Indent fallback: when this line opens a block, swallow the deeper non-empty lines below. Only for languages without syntax folding, and strict. */
function indentRangeFold(state: EditorState, lineStart: number): FoldRange | null {
  const line = state.doc.lineAt(lineStart)
  const text = line.text
  if (!/\S/.test(text)) return null
  if (!OPENS_BLOCK.test(text) && !CONTINUATION_HEAD.test(text.trimStart())) return null

  const base = indentWidth(text)
  const limit = Math.min(state.doc.lines, line.number + MAX_INDENT_SCAN)
  let last = 0
  for (let n = line.number + 1; n <= limit; n += 1) {
    const next = state.doc.line(n)
    if (!next.text.trim()) continue
    if (indentWidth(next.text) <= base) break
    last = n
  }
  if (!last) return null
  const end = state.doc.line(last)
  return end.to > line.to ? { from: line.to, to: end.to } : null
}

export function declarationFolding(
  state: EditorState,
  lineStart: number,
): FoldRange | null {
  return declarationRange(state, lineStart) ?? indentRangeFold(state, lineStart)
}

export const foldingExtension: Extension = foldService.of((state, lineStart) =>
  declarationFolding(state, lineStart),
)