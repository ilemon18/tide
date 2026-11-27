// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { search } from '@codemirror/search'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { setEditorView, setFocusedGroup } from '../editor/viewRef'
import { SearchBar } from './SearchBar'

const views: EditorView[] = []

function createView(doc: string) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [search()] }),
    parent: document.body,
  })
  views.push(view)
  setEditorView('primary', view)
  setFocusedGroup('primary')
  return view
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', () => 1)
  vi.stubGlobal('cancelAnimationFrame', () => {})
})

afterEach(() => {
  cleanup()
  views.splice(0).forEach((view) => view.destroy())
  setEditorView('primary', null)
  setFocusedGroup(null)
  vi.unstubAllGlobals()
})

it('never seeds the find box from the editor selection', () => {
  const view = createView('hello world')
  const first = render(<SearchBar onClose={() => {}} focusSeq={0} />)
  fireEvent.change(screen.getByPlaceholderText('findbar.placeholder'), { target: { value: '' } })
  first.unmount()

  view.dispatch({ selection: { anchor: 0, head: 5 } })
  render(<SearchBar onClose={() => {}} focusSeq={1} />)

  expect((screen.getByPlaceholderText('findbar.placeholder') as HTMLInputElement).value).toBe('')
})

it('centers a confirmed match while the find box stays focused', () => {
  const view = createView('first\nsecond\nthird\nsecond\n')
  const dispatch = vi.spyOn(view, 'dispatch')
  render(<SearchBar onClose={() => {}} focusSeq={0} />)

  const input = screen.getByPlaceholderText('findbar.placeholder')
  input.focus()
  fireEvent.change(input, { target: { value: 'second' } })
  fireEvent.keyDown(input, { key: 'Enter' })

  expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe('second')
  expect(
    dispatch.mock.calls.some(([tr]) =>
      tr.effects.some((effect) => (effect.value as { y?: string } | undefined)?.y === 'center'),
    ),
  ).toBe(true)
  expect(document.activeElement).toBe(input)
})
