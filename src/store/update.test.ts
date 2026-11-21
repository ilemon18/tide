import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { UpdateInfo, UpdateProgress } from '../lib/update'
import type { Tab } from './tabs'

const mocks = vi.hoisted(() => ({
  check: vi.fn(),
  download: vi.fn(),
  install: vi.fn(),
  onUpdateProgress: vi.fn(),
  toast: vi.fn(),
  confirm: vi.fn(),
  autoUpdate: false,
  saveAll: vi.fn(),
  flush: vi.fn(),
  flushEditorSession: vi.fn(),
  unlisten: vi.fn(),
  tabs: [] as Tab[],
}))

vi.mock('../lib/update', () => ({
  updateApi: {
    check: mocks.check,
    download: mocks.download,
    install: mocks.install,
    appVersion: vi.fn(),
    isDebugBuild: vi.fn(),
    startupReport: vi.fn(),
    openPage: vi.fn(),
  },
  onUpdateProgress: mocks.onUpdateProgress,
}))
vi.mock('../lib/ipc', () => ({
  errorText: (error: unknown) => String(error),
}))
vi.mock('../store/tabs', () => ({
  useTabs: { getState: () => ({ saveAll: mocks.saveAll, tabs: mocks.tabs }) },
}))
vi.mock('../store/settings', () => ({
  useSettings: { getState: () => ({ flush: mocks.flush, autoUpdate: mocks.autoUpdate }) },
}))
vi.mock('../lib/editorSession', () => ({
  flushEditorSession: mocks.flushEditorSession,
}))
vi.mock('../store/ui', () => ({
  useUi: { getState: () => ({ toast: mocks.toast, confirm: mocks.confirm }) },
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
  vi.useFakeTimers()
  mocks.tabs = []
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
  mocks.install.mockReset().mockResolvedValue({
    mode: 'restart', path: '/tmp/Tide.exe', installedTo: '', previous: '', logPath: 'update.log',
  })
  mocks.unlisten.mockReset()
  mocks.onUpdateProgress.mockReset().mockResolvedValue(mocks.unlisten)
  mocks.toast.mockReset()
  mocks.confirm.mockReset().mockResolvedValue(false)
  mocks.autoUpdate = false
  mocks.saveAll.mockReset().mockResolvedValue(undefined)
  mocks.flush.mockReset()
  mocks.flushEditorSession.mockReset()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

it('forces a fresh check and waits for an explicit download action', async () => {
  mocks.check.mockResolvedValue(availableInfo)

  await useUpdate.getState().check(true, true)

  expect(mocks.check).toHaveBeenCalledWith(true, true)
  expect(useUpdate.getState().status).toBe('available')
  expect(mocks.download).not.toHaveBeenCalled()
  expect(mocks.install).not.toHaveBeenCalled()
})

it('downloads a known update without installing until the user chooses install', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  mocks.download.mockResolvedValue('/tmp/Tide.exe')

  await useUpdate.getState().download()

  expect(mocks.download).toHaveBeenCalledWith(
    availableInfo.downloadUrl,
    availableInfo.assetName,
    availableInfo.checksum,
  )
  expect(mocks.unlisten).toHaveBeenCalledOnce()
  expect(mocks.flush).not.toHaveBeenCalled()
  expect(mocks.flushEditorSession).not.toHaveBeenCalled()
  expect(mocks.saveAll).not.toHaveBeenCalled()
  expect(mocks.install).not.toHaveBeenCalled()
  expect(useUpdate.getState().status).toBe('ready')
  expect(useUpdate.getState().percent).toBe(100)

  await useUpdate.getState().install()
  expect(mocks.flush).toHaveBeenCalledOnce()
  expect(mocks.flushEditorSession).toHaveBeenCalledOnce()
  expect(mocks.saveAll).toHaveBeenCalledOnce()
  expect(mocks.install).toHaveBeenCalledWith(availableInfo.latest)
})

it('asks before installing a background download and keeps it ready when declined', async () => {
  mocks.autoUpdate = true
  mocks.confirm.mockResolvedValue(false)
  useUpdate.setState({ status: 'available', info: availableInfo })
  mocks.download.mockResolvedValue('/tmp/Tide.exe')

  await useUpdate.getState().download(true)

  expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({
    title: 'settings.about.installUpdate',
    confirmText: 'settings.about.install',
  }))
  expect(mocks.install).not.toHaveBeenCalled()
  expect(useUpdate.getState().status).toBe('ready')

  mocks.confirm.mockResolvedValue(true)
  useUpdate.setState({ status: 'available', info: availableInfo })
  await useUpdate.getState().download(true)
  expect(mocks.install).toHaveBeenCalledWith(availableInfo.latest)
})

it('leaves a forced check as an error instead of using an old answer', async () => {
  mocks.check.mockRejectedValue(new Error('offline'))

  await useUpdate.getState().check(true, true)

  expect(useUpdate.getState().status).toBe('error')
  expect(useUpdate.getState().error).toBe('Error: offline')
})

it.each(['subscription', 'download', 'save', 'install'] as const)(
  'exits the busy state after a %s failure', async (stage) => {
    useUpdate.setState({ status: 'available', info: availableInfo })
    const failing = {
      subscription: mocks.onUpdateProgress,
      download: mocks.download,
      save: mocks.saveAll,
      install: mocks.install,
    }[stage]
    failing.mockRejectedValueOnce(new Error(stage))

    await useUpdate.getState().download()
    if (stage === 'save' || stage === 'install') await useUpdate.getState().install()

    expect(useUpdate.getState().status).toBe('error')
    expect(useUpdate.getState().error).toBe('Error: ' + stage)
    expect(mocks.toast).toHaveBeenCalledWith('Error: ' + stage, 'error')
    if (stage !== 'install') expect(mocks.install).not.toHaveBeenCalled()
    if (stage === 'subscription') expect(mocks.download).not.toHaveBeenCalled()
    else expect(mocks.unlisten).toHaveBeenCalledOnce()

    // The same known asset can be retried after the failure.
    await useUpdate.getState().download()
    if (stage === 'save' || stage === 'install') await useUpdate.getState().install()
    expect(useUpdate.getState().status).toBe(
      stage === 'save' || stage === 'install' ? 'installing' : 'ready',
    )
  },
)

it('does not restart when Save As was cancelled or edits remain unsaved', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  mocks.tabs = [{ dirty: true } as Tab]

  await useUpdate.getState().download()
  await useUpdate.getState().install()

  expect(mocks.install).not.toHaveBeenCalled()
  expect(useUpdate.getState().status).toBe('error')
  expect(useUpdate.getState().error).toContain('update.unsavedEdits')
})

it('ignores repeated actions while downloading and installing, and receives progress', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  let finishDownload!: (path: string) => void
  mocks.download.mockImplementation(() => new Promise<string>((resolve) => { finishDownload = resolve }))
  const pending = useUpdate.getState().download()
  await vi.waitFor(() => expect(mocks.download).toHaveBeenCalledOnce())
  const progress = mocks.onUpdateProgress.mock.calls[0][0] as (event: UpdateProgress) => void
  progress({ received: 42, total: 100, percent: 42, done: false })
  expect(useUpdate.getState().percent).toBe(42)
  await useUpdate.getState().download()
  await useUpdate.getState().install()
  expect(mocks.download).toHaveBeenCalledOnce()
  expect(mocks.install).not.toHaveBeenCalled()

  finishDownload('/tmp/Tide.exe')
  await pending
  await useUpdate.getState().install()
  expect(mocks.download).toHaveBeenCalledOnce()
  expect(mocks.install).toHaveBeenCalledOnce()
})

it('keeps manual installation as an explicit file-manager handoff', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  mocks.install.mockResolvedValue({ mode: 'manual', path: '/tmp/Tide.exe', installedTo: '', logPath: '' })
  await useUpdate.getState().download()
  await useUpdate.getState().install()
  expect(useUpdate.getState().status).toBe('available')
  expect(mocks.toast).toHaveBeenCalledWith('update.shownInFileManager')
  expect(mocks.install).toHaveBeenCalledOnce()
})

it('offers installation again when the native helper does not restart', async () => {
  useUpdate.setState({ status: 'available', info: availableInfo })
  await useUpdate.getState().download()
  await useUpdate.getState().install()
  await vi.advanceTimersByTimeAsync(15_000)
  expect(useUpdate.getState().status).toBe('ready')
  expect(useUpdate.getState().error).toBe('update.didNotRestart')
  await useUpdate.getState().install()
  expect(mocks.install).toHaveBeenCalledTimes(2)
  expect(mocks.download).toHaveBeenCalledOnce()
})
