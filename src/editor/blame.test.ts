// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BlameResult } from '../lib/ipc'
const { gitCommitDetail } = vi.hoisted(() => ({ gitCommitDetail: vi.fn() }))
vi.mock('../lib/ipc', () => ({ api: { gitCommitDetail }, errorText: (error: Error) => error.message }))
vi.mock('../i18n', () => ({ t: (key: string) => key, currentLocale: () => 'en' }))
vi.mock('./locale', () => ({ hasLocaleEffect: () => false, watchLocale: () => () => {} }))
import { clearCommitDetails, useCommitHover } from '../store/commitHover'
import { blameExtension, setBlameEffect } from './blame'
import { diffMarksGutter, setDiffGutterBlameProvider, setDiffMarksEffect } from './diffGutter'

const data: BlameResult = {
  root: '/repo', rel: 'a.ts', disabled: false, reason: null, lineCount: 3, latest: null,
  ranges: [{ startLine: 1, lineCount: 3, origLine: 10, sha: 'abc1234', author: 'Author',
    authorTime: 1, summary: 'Change', uncommitted: false }],
}
const views: EditorView[] = []
function createView() {
  const view = new EditorView({
    state: EditorState.create({ doc: 'first\nsecond\nthird', extensions: blameExtension }),
    parent: document.body,
  })
  views.push(view)
  return view
}

beforeEach(() => {
  vi.useFakeTimers()
  clearCommitDetails()
  gitCommitDetail.mockReset().mockResolvedValue({ fileDiff: '+change' })
  // These are scheduling/selection tests; native layout is outside their scope.
  vi.spyOn(EditorView.prototype, 'requestMeasure').mockImplementation(() => {})
})
afterEach(async () => {
  views.splice(0).forEach((view) => view.destroy())
  document.body.replaceChildren()
  clearCommitDetails()
  await vi.advanceTimersByTimeAsync(0)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('prefetches after blame arrives and maps the latest cursor line to its original line', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(data) })
  await vi.advanceTimersByTimeAsync(100)
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
  await vi.advanceTimersByTimeAsync(100)
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
  await vi.advanceTimersByTimeAsync(149)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(gitCommitDetail).toHaveBeenCalledExactlyOnceWith('/repo', 'abc1234', 'a.ts', 3, 12)
  expect(useCommitHover.getState().target).toBeNull()
})

it('waits for the existing typing idle period before prefetching again', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(data) })
  view.dispatch({ changes: { from: 0, insert: 'x' } })
  await vi.advanceTimersByTimeAsync(719)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(gitCommitDetail).toHaveBeenCalledTimes(1)
})

it('cancels pending prefetch when switching file state, disabling blame or destroying the view', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(data) })
  view.setState(EditorState.create({ doc: 'other file', extensions: blameExtension }))
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  view.dispatch({ effects: setBlameEffect.of(data) })
  view.dispatch({ effects: setBlameEffect.of(null) })
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  view.dispatch({ effects: setBlameEffect.of(data) })
  view.destroy()
  views.splice(views.indexOf(view), 1)
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).not.toHaveBeenCalled()
})

it('skips uncommitted and disabled blame and cancels a pending hover on cursor movement', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of({ ...data, disabled: true }) })
  await vi.advanceTimersByTimeAsync(150)
  view.dispatch({ effects: setBlameEffect.of({
    ...data, ranges: [{ ...data.ranges[0], uncommitted: true }],
  }) })
  await vi.advanceTimersByTimeAsync(150)
  expect(gitCommitDetail).not.toHaveBeenCalled()
  view.dispatch({ effects: setBlameEffect.of(data) })
  let resolve!: (value: { fileDiff: string }) => void
  gitCommitDetail.mockReturnValueOnce(new Promise((done) => { resolve = done }))
  const anchor = view.dom.querySelector('.cm-blame')!
  anchor.dispatchEvent(new MouseEvent('mouseenter'))
  expect(useCommitHover.getState().target?.line).toBe(1)
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
  expect(useCommitHover.getState().target).toBeNull()
  resolve({ fileDiff: '+old line' })
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().content).toBeNull()
})

it('opens the blame card when a changed-line gutter bar is clicked', async () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'first\nsecond\nthird',
      extensions: [blameExtension, diffMarksGutter],
    }),
    parent: document.body,
  })
  views.push(view)
  view.dispatch({
    effects: [
      setBlameEffect.of(data),
      setDiffMarksEffect.of([{ from: 2, to: 2, kind: 'mod' }]),
    ],
  })

  const row = view.dom.querySelector<HTMLElement>('.cm-diff-gutter-hit')
  expect(row).toBeTruthy()
  row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

  expect(view.state.selection.main.head).toBe(view.state.doc.line(2).from)
  expect(useCommitHover.getState().target?.line).toBe(2)
  expect(gitCommitDetail).toHaveBeenCalledWith('/repo', 'abc1234', 'a.ts', 2, 11)
})

it('fetches blame on demand when inline blame is not mounted', async () => {
  const view = new EditorView({
    state: EditorState.create({ doc: 'first\nsecond\nthird', extensions: [diffMarksGutter] }),
    parent: document.body,
  })
  views.push(view)
  setDiffGutterBlameProvider(view, () => Promise.resolve(data))
  view.dispatch({ effects: setDiffMarksEffect.of([{ from: 2, to: 2, kind: 'mod' }]) })

  const row = view.dom.querySelector<HTMLElement>('.cm-diff-gutter-hit')
  expect(row).toBeTruthy()
  row!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  await vi.advanceTimersByTimeAsync(0)

  expect(useCommitHover.getState().target?.line).toBe(2)
  expect(gitCommitDetail).toHaveBeenCalledWith('/repo', 'abc1234', 'a.ts', 2, 11)
})

it.each(['disable', 'replace', 'destroy', 'new commit'])('invalidates a pending hover on editor %s', async (action) => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(data) })
  let resolve!: (value: { fileDiff: string }) => void
  gitCommitDetail.mockReturnValueOnce(new Promise((done) => { resolve = done }))
  view.dom.querySelector('.cm-blame')!.dispatchEvent(new MouseEvent('mouseenter'))
  expect(useCommitHover.getState().target).not.toBeNull()
  if (action === 'disable') view.dispatch({ effects: setBlameEffect.of(null) })
  else if (action === 'replace') view.setState(EditorState.create({ doc: 'next', extensions: blameExtension }))
  else if (action === 'new commit') view.dispatch({ effects: setBlameEffect.of({
    ...data, ranges: [{ ...data.ranges[0], sha: 'def5678' }],
  }) })
  else {
    view.destroy()
    views.splice(views.indexOf(view), 1)
  }
  resolve({ fileDiff: '+old file' })
  await vi.advanceTimersByTimeAsync(0)
  expect(useCommitHover.getState().target).toBeNull()
  expect(useCommitHover.getState().content).toBeNull()
})
