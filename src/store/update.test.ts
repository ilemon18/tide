import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateInfo } from '../lib/update'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  onUpdateProgress: vi.fn(),
  toast: vi.fn(),
  saveAll: vi.fn(),
  flush: vi.fn(),
  flushEditorSession: vi.fn(),
}))

vi.mock('../lib/update', () => ({
  updateApi: {
    check: mocks.check,
    download: mocks.download,
    install: mocks.install,
    appVersion: vi.fn(),
    isDebugBuild: vi.fn(),
    startupReport: vi.fn(),
    revealLog: vi.fn(),
    openPage: vi.fn(),
  },
  onUpdateProgress: mocks.onUpdateProgress,
}))
vi.mock('../lib/ipc', () => ({
  errorText: (error: unknown) => String(error),
}))
vi.mock('../store/tabs', () => ({
  useTabs: { getState: () => ({ saveAll: mocks.saveAll }) },
}))
vi.mock('../store/settings', () => ({
  useSettings: { getState: () => ({ flush: mocks.flush }) },
}))
vi.mock('../lib/editorSession', () => ({
  flushEditorSession: mocks.flushEditorSession,
}))
vi.mock('../store/ui', () => ({
  useUi: { getState: () => ({ toast: mocks.toast }) },
}))
vi.mock('../i18n', () => ({
  t: (key: string) => key,
}))

import { useUpdate } from './update'

const availableInfo = {
  available: true,
  hasRelease: true,
  current: '1.0.0',
  latest: '1.1.0',
  name: 'Tide 1.1.0',
  notes: '',
  pageUrl: 'https://github.com/ilemon18/tide/releases/tag/v1.1.0',
  publishedAt: '',
  assetName: 'Tide.exe',
  assetSize: 42,
  downloadUrl: 'https://github.com/ilemon18/tide/releases/download/v1.1.0/Tide.exe',
  checksum: 'abc',
  checkedAt: Date.now(),
  stale: false,
} satisfies UpdateInfo

beforeEach(() => {
  useUpdate.setState({
    status: 'idle',
    debugBuild: false,
    manual: false,
    info: null,
    percent: 0,
    error: null,
    installedTo: '',
    logPath: '',
  })
  mocks.check.mockReset()
  mocks.download.mockReset()
  mocks.install.mockReset()
  mocks.onUpdateProgress.mockReset().mockResolvedValue(undefined)
  mocks.toast.mockReset()
  mocks.saveAll.mockReset().mockResolvedValue(undefined)
  mocks.flush.mockReset()
  mocks.flushEditorSession.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

it('forces a fresh check and waits for an explicit download action', async () => {
  mocks.check.mockResolvedValue(availableInfo)

  await useUpdate.getState().check(true, true)

  expect(mocks.check).toHaveBeenCalledWith(true, true)
  expect(useUpdate.getState().status).toBe('available')
  expect(mocks.download).not.toHaveBeenCalled()
})

it('moves a known update from downloading to ready', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  mocks.download.mockResolvedValue('/tmp/Tide.exe')

  await useUpdate.getState().download()

  expect(mocks.download).toHaveBeenCalledWith(
    availableInfo.downloadUrl,
    availableInfo.assetName,
    availableInfo.checksum,
  )
  expect(useUpdate.getState().status).toBe('ready')
  expect(useUpdate.getState().percent).toBe(100)
})

it('leaves a forced check as an error instead of using an old answer', async () => {
  mocks.check.mockRejectedValue(new Error('offline'))

  await useUpdate.getState().check(true, true)

  expect(useUpdate.getState().status).toBe('error')
  expect(useUpdate.getState().error).toBe('Error: offline')
})
