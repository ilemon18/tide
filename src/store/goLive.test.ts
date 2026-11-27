// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { api, type LiveInfo } from '../lib/ipc'
import type { Tab } from './tabs'
const { tabs, save } = vi.hoisted(() => ({ tabs: [] as Tab[], save: vi.fn() }))
vi.mock('../lib/ipc', () => ({
  api: {
    liveStart: vi.fn(),
    liveList: vi.fn(),
    liveStop: vi.fn(),
    liveStopAll: vi.fn(),
    liveOpen: vi.fn(),
  },
  errorText: String,
}))
vi.mock('./tabs', () => ({ useTabs: { getState: () => ({ tabs, save }) } }))
vi.mock('./ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
import { useGoLive, canGoLive } from './goLive'
const file = {
  id: 'html',
  root: '/repo',
  rel: 'index.html',
  name: 'index.html',
  kind: 'file',
  dirty: true,
} as Tab
const server: LiveInfo = {
  id: 'service',
  root: '/repo',
  rel: 'index.html',
  port: 5500,
  url: 'http://127.0.0.1:5500/service/index.html',
}
beforeEach(() => {
  vi.resetAllMocks()
  tabs.splice(0, tabs.length, file)
  useGoLive.setState({ servers: [], busy: false })
  vi.mocked(api.liveList).mockResolvedValue([server])
})
it('does no native work until invoked and saves dirty HTML before starting', async () => {
  expect(api.liveList).not.toHaveBeenCalled()
  save.mockResolvedValue(true)
  vi.mocked(api.liveStart).mockResolvedValue(server)
  expect(await useGoLive.getState().start(file)).toEqual(server)
  expect(save).toHaveBeenCalledWith('html')
  expect(save.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(api.liveStart).mock.invocationCallOrder[0],
  )
  expect(useGoLive.getState().servers).toEqual([server])
})
it('does not start when saving fails or the target is untitled', async () => {
  save.mockResolvedValue(false)
  expect(await useGoLive.getState().start(file)).toBeNull()
  expect(api.liveStart).not.toHaveBeenCalled()
  expect(canGoLive({ ...file, kind: 'untitled' })).toBe(false)
})
it('does not restore a stopped server from an obsolete list request', async () => {
  let resolve!: (value: LiveInfo[]) => void
  vi.mocked(api.liveList).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  useGoLive.setState({ servers: [server] })
  vi.mocked(api.liveStop).mockResolvedValue(undefined)
  const refresh = useGoLive.getState().refresh()
  await useGoLive.getState().stop(server.id)
  resolve([server])
  await refresh
  expect(useGoLive.getState().servers).toEqual([])
})
