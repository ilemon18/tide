import { EditorSelection, EditorState } from '@codemirror/state'
import { expect, it, vi } from 'vitest'
import type { Tab } from '../store/tabs'
vi.mock('../store/agent', () => ({ agentUid: (() => { let seq = 0; return () => String(++seq) })() }))
import { captureEditorContext } from './agentContext'

const tab: Tab = { id: 'file', root: '/repo', rel: 'a.ts', name: 'a.ts', kind: 'file',
  pinned: false, dirty: true, readOnly: false, temporary: false, tier: 'full', mtime: 0 }

it('captures sorted reverse/multiple selections from unsaved text with one-based positions', () => {
  const state = EditorState.create({ doc: 'first\n\u4e2d\ud83d\ude42last', extensions: EditorState.allowMultipleSelections.of(true),
    selection: EditorSelection.create([EditorSelection.range(5, 0), EditorSelection.range(6, 9)]) })
  const items = captureEditorContext(state, tab, '/repo', 10)
  expect(items).toHaveLength(2)
  expect(items[0]).toMatchObject({ text: 'first', startLine: 1, startColumn: 1, endLine: 1, endColumn: 6, unsaved: true })
  expect(items[1]).toMatchObject({ text: '\u4e2d\ud83d\ude42', startLine: 2, startColumn: 1, endLine: 2, endColumn: 4 })
  expect(captureEditorContext(state.update({ changes: { from: 1, to: 2, insert: 'new' } }).state, tab, '/repo')[0].text).toBe('fnewrst')
  expect(items[0].text).toBe('first')
})

it('supports untitled buffers and ignores empty selections', () => {
  const state = EditorState.create({ doc: 'draft', selection: { anchor: 0, head: 5 } })
  expect(captureEditorContext(state, { ...tab, kind: 'untitled', name: 'Untitled' }, '/repo')[0]).toMatchObject({ rel: null, label: 'Untitled', unsaved: true })
  expect(captureEditorContext(EditorState.create({ doc: 'text' }), tab, '/repo')).toEqual([])
})
