import { afterEach, expect, it, vi } from 'vitest'
import type { UpdateInfo } from './update'

const state = vi.hoisted(() => ({
  info: null as UpdateInfo | null,
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  openPage: vi.fn(),
}))

vi.mock('../store/update', () => ({
  useUpdate: { getState: () => state },
}))
vi.mock('../i18n', () => ({
  t: (key: string) => key,
}))

import { runUpdateAction, updateAction, updateTip, updateDetail, type UpdateView } from './updateView'

const availableInfo = { available: true, downloadUrl: 'https://github.com/tide/update.exe' } as UpdateInfo

function view(status: UpdateView['status'], info: UpdateInfo | null = null): UpdateView {
  return {
    status,
    info,
    percent: 0,
    error: null,
    installedTo: '',
    version: '1.0.0',
  }
}

afterEach(() => {
  vi.clearAllMocks()
  state.info = null
})

it('uses one explicit action for the update lifecycle', () => {
  expect(updateAction(view('idle')).kind).toBe('check')
  expect(updateAction(view('available', availableInfo)).kind).toBe('download')
  expect(updateAction(view('ready')).kind).toBe('install')
})

it('forces a fresh check for the initial action and a retry without an asset', () => {
  runUpdateAction('check')
  expect(state.check).toHaveBeenCalledWith(true, true)

  state.check.mockClear()
  runUpdateAction('retry')
  expect(state.check).toHaveBeenCalledWith(true, true)
})

it('keeps retry on the download step when an asset is already known', () => {
  state.info = availableInfo

  runUpdateAction('retry')

  expect(state.download).toHaveBeenCalledOnce()
  expect(state.check).not.toHaveBeenCalled()
})

it('routes an available update to download and keeps a missing installer on the release page', () => {
  const action = updateAction(view('available', availableInfo))
  expect(action.label).toBe('settings.about.download')
  runUpdateAction(action.kind)
  expect(state.download).toHaveBeenCalledOnce()
  const fallback = updateAction(view('available', { ...availableInfo, downloadUrl: '' }))
  expect(fallback.kind).toBe('openPage')
  runUpdateAction(fallback.kind)
  expect(state.openPage).toHaveBeenCalledOnce()
})

it.each(['checking', 'downloading', 'installing'] as const)('does nothing while %s', (status) => {
  runUpdateAction(updateAction(view(status)).kind)
  expect(state.download).not.toHaveBeenCalled()
  expect(state.install).not.toHaveBeenCalled()
  expect(state.check).not.toHaveBeenCalled()
})

it.each([[0, 0], [42, 42], [100, 100], [-1, 0], [101, 100]])(
  'maps %s percent to an accurate bounded ring value of %s', (percent, expected) => {
    expect(updateAction({ ...view('downloading'), percent }).percent).toBe(expected)
  },
)

it('shows restart timeout errors while keeping installation available', () => {
  const failedRestart = { ...view('ready'), error: 'Restart did not start' }
  expect(updateAction(failedRestart).kind).toBe('install')
  expect(updateTip(failedRestart)).toBe(failedRestart.error)
  expect(updateDetail(failedRestart)).toBe(failedRestart.error)
})
