// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { api } from './ipc'
import { DEFAULT_SETTINGS, useSettings } from '../store/settings'
import { nextBackupAt, readConfigDocument, startConfigBackups } from './configBackup'
vi.mock('./ipc', () => ({
  api: {
    loadSettings: vi.fn(),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    configExport: vi.fn(),
  },
  errorText: String,
}))
vi.mock('./update', () => ({ updateApi: { appVersion: vi.fn().mockResolvedValue('0.0.18') } }))
vi.mock('../theme/apply', async () => {
  const { palettes } = await import('../theme/palettes')
  return {
    applyTheme: () => palettes.tide,
    applyLigatures: vi.fn(),
    applyMonoFont: vi.fn(),
    applyUiFontSize: vi.fn(),
    applyUiFontStyle: vi.fn(),
    applyCodeFontStyle: vi.fn(),
    watchSystemTheme: vi.fn(),
  }
})
vi.mock('../editor/stateCache', () => ({ monoStack: () => 'monospace', setEditorLook: vi.fn() }))
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast: vi.fn() }) } }))
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-27T12:00:00Z'))
  vi.clearAllMocks()
  useSettings.setState({ ...DEFAULT_SETTINGS, loaded: true })
})
afterEach(() => {
  vi.useRealTimers()
})
it('accepts old plain settings and future envelopes while rejecting non-configuration documents', () => {
  expect(readConfigDocument({ fontSize: 18 })).toEqual({ fontSize: 18 })
  expect(
    readConfigDocument({ format: 'tide-config', version: 99, settings: { futureSetting: true } }),
  ).toEqual({ futureSetting: true })
  for (const value of [
    null,
    [],
    12,
    { format: 'other', version: 1, settings: {} },
    { format: 'tide-config', version: 1, settings: [] },
  ])
    expect(() => readConfigDocument(value)).toThrow()
})
it('clamps month-end backups and uses calendar intervals', () => {
  const january = new Date(2027, 0, 31, 10).getTime()
  expect(new Date(nextBackupAt(january, 'monthly'))).toEqual(new Date(2027, 1, 28, 10))
  expect(new Date(nextBackupAt(january, 'threeDays'))).toEqual(new Date(2027, 1, 3, 10))
})
it('does nothing by default, saves a missed backup on enable, and never stamps a failed write', async () => {
  const stop = startConfigBackups()
  await vi.advanceTimersByTimeAsync(0)
  expect(api.configExport).not.toHaveBeenCalled()
  vi.mocked(api.configExport)
    .mockRejectedValueOnce(new Error('folder unavailable'))
    .mockResolvedValue('/backup/tide-config.json')
  useSettings.getState().patch({ configBackupEnabled: true, configBackupFolder: '/backup' })
  await vi.advanceTimersByTimeAsync(0)
  expect(useSettings.getState().configBackupLastAt).toBe(0)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(useSettings.getState().configBackupLastAt).toBe(Date.now())
  expect(api.configExport).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(api.configExport).toHaveBeenCalledTimes(2)
  stop()
})
