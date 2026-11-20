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

import { runUpdateAction, updateAction, type UpdateView } from './updateView'

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
