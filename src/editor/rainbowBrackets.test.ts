// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { history, undoDepth } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { expect, it, vi } from 'vitest'
import { configureRainbowBrackets, rainbowBracketMarks, rainbowBracketsForTier } from './rainbowBrackets'
import { buildEditorTheme } from '../theme/cmTheme'
import { palettes } from '../theme/palettes'
import { budget } from '../lib/memoryBudget'

function parse(doc: string) { return EditorState.create({ doc, extensions: javascript() }) }
function marks(doc: string) { return rainbowBracketMarks(parse(doc), [{ from: 0, to: doc.length }]) }

it('colors pairs consistently by nesting, excluding quoted and commented punctuation', () => {
  const doc = 'const data = ({ values: [f(1)], text: "[{}]" }); // ({[]})'
  const result = marks(doc)
  expect(result.map(mark => [doc.slice(mark.from, mark.to), mark.depth])).toEqual([
    ['(', 0], ['{', 1], ['[', 2], ['(', 3], [')', 3], [']', 2], ['}', 1], [')', 0],
  ])
})

it('keeps nesting stable when the opening brackets are outside the visible range', () => {
  const doc = 'const data = ({ values: [f(1)] });'
  const all = marks(doc)
  const from = doc.indexOf('1')
  expect(rainbowBracketMarks(parse(doc), [{ from, to: doc.length }])).toEqual(all.filter(mark => mark.from >= from))
})

it('recolors after document edits without including template text', () => {
  const initial = parse('const t = `text [ ] ${f(1)}`')
  const next = initial.update({ changes: { from: initial.doc.toString().indexOf('f(1)'), insert: '[' } }).state
  const first = rainbowBracketMarks(initial, [{ from: 0, to: initial.doc.length }])
  const updated = rainbowBracketMarks(next, [{ from: 0, to: next.doc.length }])
  expect(first.every(mark => mark.from > initial.doc.toString().indexOf('${'))).toBe(true)
  expect(updated.map(mark => next.sliceDoc(mark.from, mark.to))).toContain('[')
})

it('does no punctuation guessing for files without a syntax grammar', () => {
  const doc = 'plain "({[]})"'
  expect(rainbowBracketMarks(EditorState.create({ doc }), [{ from: 0, to: doc.length }])).toEqual([])
})

it('bounds viewport scans and decorations, including a dense long line', () => {
  const doc = 'const x = [' + 'f(1),'.repeat(1000) + '0]'
  const nodeLimit = vi.spyOn(budget, 'rainbowNodes').mockReturnValue(20)
  const markLimit = vi.spyOn(budget, 'rainbowMarks').mockReturnValue(4)
  try { expect(marks(doc).length).toBeLessThanOrEqual(4) }
  finally { nodeLimit.mockRestore(); markLimit.mockRestore() }
})

it.each(['full', 'large', 'preview'] as const)('toggles decorations without losing undo and keeps %s tier policy', tier => {
  const measure = vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(() => {})
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc: '([1])',
    extensions: [javascript(), history(), rainbowBracketsForTier(tier)] }) })
  const count = () => view.dom.querySelectorAll('[class*="cm-rainbow-bracket-"]').length
  try {
    expect(count() > 0).toBe(tier === 'full')
    view.dispatch({ changes: { from: 2, insert: '0' } })
    configureRainbowBrackets(view, false)
    expect(count()).toBe(0)
    configureRainbowBrackets(view, true)
    expect(count() > 0).toBe(tier === 'full')
    expect(undoDepth(view.state)).toBe(1)
  } finally { view.destroy(); measure.mockRestore() }
})

it('renders visible rainbow colors on TSX import and JSX bracket glyphs with syntax highlighting', () => {
  const measure = vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(() => {})
  const doc = '/* leading comment */\nimport { Table, Button } from "antd";\nexport function Page() { return <div>{items.map(item => [item])}</div> }'
  const view = new EditorView({ parent: document.body, state: EditorState.create({ doc,
    extensions: [javascript({ typescript: true, jsx: true }), rainbowBracketsForTier('full'), buildEditorTheme(palettes.dracula, { fontFamily: 'monospace', fontSize: 13, fontWeight: 400, fontItalic: false, lineHeight: 1.5 })] }) })
  try {
    const bracket = view.dom.querySelector<HTMLElement>('.cm-rainbow-bracket-0')!
    expect(bracket).not.toBeNull()
    const glyph = bracket.querySelector<HTMLElement>('span:last-child') ?? bracket
    const expected = document.createElement('span'); expected.style.color = palettes.dracula.syntax.type
    document.body.appendChild(expected)
    try { expect(getComputedStyle(glyph).color).toBe(getComputedStyle(expected).color) }
    finally { expected.remove() }
  } finally { view.destroy(); measure.mockRestore() }
})
