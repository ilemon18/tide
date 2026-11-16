import { EditorState } from '@codemirror/state'
import { ensureSyntaxTree } from '@codemirror/language'
import { highlightTree, tagHighlighter } from '@lezer/highlight'
import { loadLanguage } from '../editor/languages'
import { SYNTAX_RULES } from '../theme/syntax'

/**
 * Syntax highlighting for one diff side. The diff view is plain DOM with no EditorView, so this
 * parses headlessly: build a temporary EditorState from the side's full text, take the syntax tree,
 * then split it into inline segments with highlightTree. Colors are not decided here, only cls.
 */

/** Inline segment: offset is relative to the start of its line */
export type Token = { from: number; to: number; cls: string }

/** Line number (1-based) → segments of that line */
export type LineTokens = Map<number, Token[]>

/** Skip highlighting above these limits: diff is read-only, colors must not block the main thread */
export const HIGHLIGHT_MAX_LINES = 4000
const HIGHLIGHT_MAX_CHARS = 300_000
const PARSE_TIMEOUT_MS = 3000

const highlighter = tagHighlighter(
  SYNTAX_RULES.map((rule) => ({ tag: rule.tags, class: rule.cls })),
)

/** Binary search: which line `pos` falls in (starts holds each line's start offset) */
function lineAt(starts: number[], pos: number): number {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * @param rel  file path used to pick the language pack
 * @param lines text indexed by real line number (`lines[0]` is line 1); unknown lines get ""
 */
export async function highlightSide(rel: string, lines: string[]): Promise<LineTokens | null> {
  if (lines.length === 0 || lines.length > HIGHLIGHT_MAX_LINES) return null

  let chars = 0
  for (const line of lines) {
    chars += line.length + 1
    if (chars > HIGHLIGHT_MAX_CHARS) return null
  }

  const lang = await loadLanguage(rel)
  if (!lang) return null

  const doc = lines.join('\n')
  const tree = (() => {
    try {
      const state = EditorState.create({ doc, extensions: [lang] })
      // The syntax tree is parsed lazily: force it to the end of the doc, give up on timeout
      return ensureSyntaxTree(state, doc.length, PARSE_TIMEOUT_MS)
    } catch {
      return null
    }
  })()
  if (!tree) return null

  const starts: number[] = new Array(lines.length)
  let offset = 0
  for (let i = 0; i < lines.length; i += 1) {
    starts[i] = offset
    offset += lines[i].length + 1
  }

  const out: LineTokens = new Map()
  highlightTree(tree, highlighter, (from, to, cls) => {
    let index = lineAt(starts, from)
    let pos = from
    // Block comments / multi-line strings span lines: split per line, keep each line's slice
    while (pos < to && index < lines.length) {
      const lineStart = starts[index]
      const lineEnd = lineStart + lines[index].length
      if (lineEnd > pos) {
        const end = Math.min(to, lineEnd)
        let list = out.get(index + 1)
        if (!list) {
          list = []
          out.set(index + 1, list)
        }
        list.push({ from: pos - lineStart, to: end - lineStart, cls })
      }
      pos = lineEnd + 1
      index += 1
    }
  })

  return out
}