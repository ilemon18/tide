// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../i18n', () => ({
  currentLocale: () => 'en',
  t: (key: string) => key,
  onLocaleChange: () => () => {},
}))

import { conflictExtension, conflictField } from './conflicts'

const DOC = [
  'before',
  '<<<<<<< HEAD',
  'ours',
  '=======',
  'theirs',
  '>>>>>>> branch',
  'after',
].join('\n')

const views: EditorView[] = []

afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

it('mounts block conflict actions through a state field without throwing', () => {
  const view = new EditorView({
    state: EditorState.create({ doc: DOC, extensions: [conflictExtension] }),
    parent: document.body,
  })
  views.push(view)

  expect(view.state.field(conflictField)).toHaveLength(1)
  expect(view.dom.querySelector('.cm-conflict-lens')).not.toBeNull()
  expect(view.dom.querySelectorAll('.cm-conflict-line-btn')).toHaveLength(2)
})
