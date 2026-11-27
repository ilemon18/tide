// @vitest-environment jsdom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BlameResult } from '../lib/ipc'
const { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff } = vi.hoisted(() => ({
  gitCommitDetail: vi.fn(),
  gitCommitFileDiff: vi.fn(),
  gitWorkingTreeDiff: vi.fn(),
}))
vi.mock('../lib/ipc', () => ({
  api: { gitCommitDetail, gitCommitFileDiff, gitWorkingTreeDiff },
  errorText: (error: Error) => error.message,
}))
vi.mock('../i18n', () => ({
  t: (key: string) =>
    key === 'time.justNow'
      ? 'just now'
      : key === 'blame.you'
        ? 'You'
        : key === 'blame.uncommitted'
          ? 'Uncommitted changes'
          : key,
  currentLocale: () => 'en',
}))
vi.mock('./locale', () => ({ hasLocaleEffect: () => false, watchLocale: () => () => {} }))
import { clearCommitDetails, useCommitHover } from '../store/commitHover'
import {
  blameExtension,
  BLAME_IDLE_DELAY,
  blameField,
  formatBlameText,
  setBlameContentProvider,
  setBlameEffect,
} from './blame'

const NOW = Date.parse('2026-01-01T00:00:00Z')
const threeDaysAgo = Math.floor(NOW / 1000) - 3 * 86400 - 10

function blame(overrides: Partial<BlameResult> = {}): BlameResult {
  return {
    root: '/repo',
    rel: 'a.ts',
    disabled: false,
    reason: null,
    lineCount: 3,
    currentUserName: 'Tester',
    currentUserEmail: 'me@example.com',
    version: 0,
    ranges: [
      {
        startLine: 1,
        lineCount: 3,
        origLine: 10,
        origPath: 'old/a.ts',
        sha: 'a'.repeat(40),
        author: 'Author',
        authorEmail: 'author@example.com',
        authorTime: threeDaysAgo,
        summary: 'Change',
        uncommitted: false,
        previousSha: null,
        previousPath: null,
      },
    ],
    ...overrides,
  }
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

async function showBlame(view: EditorView, data: BlameResult) {
  view.dispatch({ effects: setBlameEffect.of(data) })
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  clearCommitDetails()
  gitCommitDetail.mockReset().mockResolvedValue({
    sha: 'a'.repeat(40),
    shortSha: 'aaaaaaa',
    author: 'Author',
    email: 'author@example.com',
    authorTime: threeDaysAgo,
    commitTime: threeDaysAgo,
    subject: 'Change',
    body: '',
    files: [],
    additions: 1,
    deletions: 0,
    merge: false,
  })
  gitCommitFileDiff.mockReset().mockResolvedValue({
    path: 'old/a.ts',
    renamedFrom: null,
    additions: 1,
    deletions: 0,
    hunks: [],
    truncated: false,
  })
  gitWorkingTreeDiff.mockReset().mockResolvedValue(null)
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

it('renders GitLens current-line blame without a SHA', async () => {
  const view = createView()
  await showBlame(view, blame())
  const text = view.dom.querySelector('.cm-blame')?.textContent
  expect(text).toBe('Author, 3 days ago • Change')
  expect(text).not.toContain('aaaaaaa')
})

it('waits 1 second before showing each new cursor line and cancels rapid switches', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(blame()) })
  expect(BLAME_IDLE_DELAY).toBe(1000)
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY - 1)
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(view.dom.querySelector('.cm-blame')).not.toBeNull()
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  await vi.advanceTimersByTimeAsync(1000)
  view.dispatch({ selection: { anchor: view.state.doc.line(3).from } })
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY - 1)
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  expect(gitCommitDetail).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  view.dom.querySelector('.cm-blame')!.dispatchEvent(new MouseEvent('mouseenter'))
  expect(useCommitHover.getState().target?.line).toBe(3)
})

it('cancels the delayed display and prefetch when the view is destroyed', async () => {
  const view = createView()
  view.dispatch({ effects: setBlameEffect.of(blame()) })
  view.destroy()
  views.splice(views.indexOf(view), 1)
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY * 2)
  expect(document.querySelector('.cm-blame')).toBeNull()
  expect(gitCommitDetail).not.toHaveBeenCalled()
})

it('renders the current user as You', async () => {
  const view = createView()
  const data = blame()
  data.ranges[0].authorEmail = 'me@example.com'
  await showBlame(view, data)
  expect(view.dom.querySelector('.cm-blame')?.textContent).toBe('You, 3 days ago • Change')
})

it('renders uncommitted rows as You, Uncommitted changes', async () => {
  const view = createView()
  const data = blame()
  data.ranges[0].uncommitted = true
  data.ranges[0].sha = '0'.repeat(40)
  await showBlame(view, data)
  expect(view.dom.querySelector('.cm-blame')?.textContent).toBe('You, Uncommitted changes')
})

it('truncates long summaries by grapheme', async () => {
  const range = blame().ranges[0]
  range.summary = '😀'.repeat(60)
  const text = formatBlameText(range, blame())
  const summary = text.split(' • ')[1]
  const graphemes = [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(summary)]
  expect(graphemes).toHaveLength(51)
  expect(graphemes.at(-1)?.segment).toBe('…')
})

it('hides the old rows immediately and only asks for new blame after the idle delay', async () => {
  const view = createView()
  await showBlame(view, blame())
  const provider = vi.fn()
  setBlameContentProvider(view, provider)

  view.dispatch({ changes: { from: 0, insert: 'x' } })
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  // A selection change while waiting must not resurrect the previous document's rows.
  view.dispatch({ selection: { anchor: view.state.doc.line(2).from } })
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY - 1)
  expect(provider).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(provider).toHaveBeenCalledWith(view.state.doc.toString(), 1)
})

it('ignores a buffer result from an older document version', async () => {
  const view = createView()
  await showBlame(view, blame())
  view.dispatch({ changes: { from: 0, insert: 'x' } })
  // Version 0 (or an older buffer version) must not clear the waiting state.
  view.dispatch({ effects: setBlameEffect.of({ ...blame(), version: 0 }) })
  expect(view.dom.querySelector('.cm-blame')).toBeNull()
  const current = view.state.field(blameField).version
  view.dispatch({ effects: setBlameEffect.of({ ...blame(), version: current }) })
  await vi.advanceTimersByTimeAsync(BLAME_IDLE_DELAY)
  expect(view.dom.querySelector('.cm-blame')?.textContent).toContain('Change')
})

it('refreshes the relative time after a minute of inactivity', async () => {
  const view = createView()
  const data = blame()
  data.ranges[0].authorTime = Math.floor(NOW / 1000) - 30
  await showBlame(view, data)
  expect(view.dom.querySelector('.cm-blame')?.textContent).toBe('Author, just now • Change')
  await vi.advanceTimersByTimeAsync(60_000)
  expect(view.dom.querySelector('.cm-blame')?.textContent).toBe('Author, 1 minute ago • Change')
})

it('uses the blame origPath for the hover diff target', async () => {
  const view = createView()
  await showBlame(view, blame())
  const anchor = view.dom.querySelector('.cm-blame')!
  anchor.dispatchEvent(new MouseEvent('mouseenter'))
  const target = useCommitHover.getState().target
  expect(target?.rel).toBe('a.ts')
  expect(target?.path).toBe('old/a.ts')
  expect(target?.origLine).toBe(10)
})

it('opens the card on click as well as hover', async () => {
  const view = createView()
  await showBlame(view, blame())
  const anchor = view.dom.querySelector('.cm-blame')!
  anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  expect(useCommitHover.getState().target).not.toBeNull()
})

it('anchors empty-line blame outside the text and lets Alt caret gestures pass through', async () => {
  const view = new EditorView({ state: EditorState.create({ doc: '\ncode', extensions: blameExtension }), parent: document.body })
  views.push(view)
  await showBlame(view, blame())
  const text = view.dom.querySelector('.cm-blame')!
  expect(text.parentElement?.className).toBe('cm-blame-anchor')
  expect(view.state.doc.line(1).length).toBe(0)
  text.dispatchEvent(new MouseEvent('mouseenter', { altKey: true }))
  const click = new MouseEvent('click', { altKey: true, bubbles: true, cancelable: true })
  text.dispatchEvent(click)
  expect(click.defaultPrevented).toBe(false)
  expect(useCommitHover.getState().target).toBeNull()
})

it('opens an uncommitted card without a commit sha', async () => {
  const view = new EditorView({
    state: EditorState.create({
      doc: 'first\nsecond',
      extensions: [blameExtension],
    }),
    parent: document.body,
  })
  views.push(view)
  const data = blame()
  data.ranges[0].uncommitted = true
  data.ranges[0].sha = '0'.repeat(40)
  await showBlame(view, data)
  view.dom.querySelector('.cm-blame')!.dispatchEvent(new MouseEvent('mouseenter'))
  const target = useCommitHover.getState().target
  expect(target?.uncommitted).toBe(true)
  expect(target?.rel).toBe('a.ts')
})
