// @vitest-environment jsdom
import { EditorState, EditorSelection } from '@codemirror/state'
import { expect, it, vi } from 'vitest'
import { cursorAtPoint, lineCursors } from './altSelection'
import { altSelectionStyle } from './altSelection'
import { EditorView } from '@codemirror/view'

it('places upward-dragged cursors at each logical line end and edits all rows', () => {
  let state = EditorState.create({
    doc: 'one\nlong second\nx',
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const selection = lineCursors(state, state.doc.length, 0, 'end')
  expect(selection.ranges.map((range) => range.head)).toEqual([3, 15, 17])
  expect(selection.main.head).toBe(3)
  state = state.update({ selection }).state
  state = state.update(state.replaceSelection('!')).state
  expect(state.doc.toString()).toBe('one!\nlong second!\nx!')
})
it('handles line starts and clamps column cursors for short lines', () => {
  const state = EditorState.create({
    doc: 'long\nx\nwide',
    extensions: [EditorState.allowMultipleSelections.of(true)],
    selection: EditorSelection.cursor(2),
  })
  expect(
    lineCursors(state, 0, state.doc.length, 'start').ranges.map((range) => range.head),
  ).toEqual([0, 5, 7])
  expect(lineCursors(state, 0, state.doc.length, 3).ranges.map((range) => range.head)).toEqual([
    3, 6, 10,
  ])
})

it('aligns visual columns across tabs and keeps every range empty', () => {
  const state = EditorState.create({
    doc: '\tfoo\nabcdef',
    extensions: [EditorState.allowMultipleSelections.of(true), EditorState.tabSize.of(4)],
  })
  const selection = lineCursors(state, 1, state.doc.length, 4)
  expect(selection.ranges.map((range) => range.head)).toEqual([1, 9])
  expect(selection.ranges.every((range) => range.empty)).toBe(true)
})

it('adds independent point cursors without retaining a text selection, and drags only empty carets', () => {
  const state = EditorState.create({
    doc: 'abcde\nxy\nlonger',
    selection: EditorSelection.range(0, 2),
    extensions: [EditorState.allowMultipleSelections.of(true)],
  })
  const content = document.createElement('div')
  const view = {
    state,
    contentDOM: content,
    documentTop: 0,
    lineBlockAtHeight: () => ({ from: 0 }),
    coordsAtPos: () => null,
    posAtCoords: ({ x }: { x: number }) => x,
  } as unknown as EditorView
  const down = new MouseEvent('mousedown', { button: 0, altKey: true, clientX: 3, clientY: 10 })
  Object.defineProperty(down, 'target', { value: content })
  const style = altSelectionStyle(view, down)!
  const clicked = style.get(down, false, true)
  expect(clicked.ranges.map((range) => range.head)).toEqual([2, 3])
  expect(clicked.ranges.every((range) => range.empty)).toBe(true)
  const dragged = style.get(
    new MouseEvent('mousemove', { altKey: true, clientX: 12, clientY: 50 }),
    false,
    true,
  )
  expect(dragged.ranges.map((range) => range.head)).toEqual([3, 8, 12])
  expect(dragged.ranges.every((range) => range.empty)).toBe(true)
  const plain = new MouseEvent('mousedown', { button: 0, clientX: 1 })
  Object.defineProperty(plain, 'target', { value: content })
  expect(altSelectionStyle(view, plain)).toBeNull()
})

it('snaps empty lines and blank space after text to real positions, while preserving wrapped-row hits', () => {
  const state = EditorState.create({ doc: 'abc\n\nlonger' })
  const hit = vi.fn().mockReturnValue(2)
  const view = {
    state,
    documentTop: 100,
    lineBlockAtHeight: (y: number) => ({ from: y < 20 ? 0 : y < 40 ? 4 : 5 }),
    coordsAtPos: (pos: number) => {
      const line = state.doc.lineAt(pos)
      return { left: 10 + line.length * 8, right: 10 + line.length * 8,
        top: 100 + (line.number - 1) * 20, bottom: 120 + (line.number - 1) * 20 }
    },
    posAtCoords: hit,
  } as unknown as EditorView
  expect(cursorAtPoint(view, { x: 600, y: 130 })).toBe(4)
  expect(cursorAtPoint(view, { x: 600, y: 110 })).toBe(3)
  expect(cursorAtPoint(view, { x: 600, y: 150 })).toBe(11)
  expect(hit).not.toHaveBeenCalled()
  expect(cursorAtPoint(view, { x: 18, y: 110 })).toBe(2)
  // A logical line may wrap: far-right clicks on an earlier row must not jump to its final row.
  vi.spyOn(view, 'coordsAtPos').mockReturnValue({ left: 34, right: 34, top: 120, bottom: 140 })
  expect(cursorAtPoint(view, { x: 600, y: 110 })).toBe(2)
  expect(hit).toHaveBeenLastCalledWith({ x: 600, y: 110 }, false)
})
