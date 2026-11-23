// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, type AgentPermissionMode, type Settings } from '../lib/ipc'
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA_VERSION, useSettings } from './settings'

vi.mock('../lib/ipc', () => ({
  api: { loadSettings: vi.fn(), saveSettings: vi.fn() },
  errorText: (error: unknown) => String(error),
}))
vi.mock('../theme/apply', async () => {
  const { palettes } = await import('../theme/palettes')
  return { applyTheme: vi.fn(() => palettes.tide), applyLigatures: vi.fn(), applyMonoFont: vi.fn(),
    applyUiFontSize: vi.fn(), watchSystemTheme: vi.fn() }
})
vi.mock('../editor/stateCache', () => ({ monoStack: () => 'monospace', setEditorLook: vi.fn() }))

let testTime = Date.now()
beforeEach(async () => {
  vi.useFakeTimers()
  // Each case starts beyond the settings broadcast echo window.
  vi.setSystemTime(testTime += 10_000)
  vi.clearAllMocks()
  useSettings.setState({ ...DEFAULT_SETTINGS, loaded: false })
  vi.mocked(api.loadSettings).mockResolvedValue({ ...DEFAULT_SETTINGS })
  vi.mocked(api.saveSettings).mockResolvedValue(undefined)
  await useSettings.getState().load()
})
afterEach(async () => {
  await vi.runAllTimersAsync()
  vi.useRealTimers()
})

describe('Agent preference persistence', () => {
  it.each([
    { agentDefaultProvider: 'codex' },
    { agentDefaultModel: '' },
    { agentDefaultEffort: '' },
    { agentDefaultPermissionMode: 'full-access' as const },
  ])('writes each Agent default immediately: %j', async (patch) => {
    useSettings.getState().patch(patch)
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining(patch))
  })

  it.each(['read-only', 'workspace-write', 'full-access'] as const)(
    'restores the model, effort and %s permissions after reloading settings', async (mode) => {
    let disk: Settings = { ...DEFAULT_SETTINGS }
    vi.mocked(api.saveSettings).mockImplementation(async (next) => { disk = structuredClone(next) })
    vi.mocked(api.loadSettings).mockImplementation(async () => structuredClone(disk))
    useSettings.getState().patch({ agentDefaultProvider: 'codex', agentDefaultModel: 'custom-model',
      agentDefaultEffort: 'high', agentDefaultPermissionMode: mode })
    await vi.advanceTimersByTimeAsync(0)
    useSettings.setState({ ...DEFAULT_SETTINGS, loaded: false })
    await useSettings.getState().load()
    expect(useSettings.getState()).toMatchObject({ loaded: true, agentDefaultProvider: 'codex',
      agentDefaultModel: 'custom-model', agentDefaultEffort: 'high', agentDefaultPermissionMode: mode })
  })

  it('persists Default as empty strings across a reload', async () => {
    useSettings.getState().patch({ agentDefaultProvider: 'codex', agentDefaultModel: 'custom-model', agentDefaultEffort: 'high' })
    useSettings.getState().patch({ agentDefaultModel: '', agentDefaultEffort: '' })
    await vi.advanceTimersByTimeAsync(0)
    const saved = vi.mocked(api.saveSettings).mock.calls.at(-1)![0]
    expect(saved).toMatchObject({ agentDefaultProvider: 'codex', agentDefaultModel: '', agentDefaultEffort: '' })
    vi.mocked(api.loadSettings).mockResolvedValue(structuredClone(saved))
    useSettings.setState({ agentDefaultModel: 'stale-model', agentDefaultEffort: 'low' })
    await useSettings.getState().load()
    expect(useSettings.getState()).toMatchObject({ agentDefaultModel: '', agentDefaultEffort: '' })
  })

  it('serializes rapid choices and keeps the most recent value on disk', async () => {
    let finishFirst!: () => void
    vi.mocked(api.saveSettings).mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve }))
    useSettings.getState().patch({ agentDefaultPermissionMode: 'read-only' })
    await vi.advanceTimersByTimeAsync(0)
    useSettings.getState().patch({ agentDefaultPermissionMode: 'full-access' })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
    finishFirst()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).toHaveBeenCalledTimes(2)
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ agentDefaultPermissionMode: 'full-access' }))
  })

  it('syncs Agent preferences across windows while keeping local layout', async () => {
    useSettings.setState({ sidebarWidth: 333 })
    useSettings.getState().patch({ panelHeight: 444 })
    const next: Settings = { ...DEFAULT_SETTINGS, agentDefaultProvider: 'claude',
      agentDefaultModel: 'claude-model', agentDefaultEffort: 'high', agentDefaultPermissionMode: 'read-only' }
    useSettings.getState().applyExternal(next)
    await vi.advanceTimersByTimeAsync(0)
    expect(useSettings.getState()).toMatchObject({ agentDefaultProvider: 'claude', agentDefaultModel: 'claude-model',
      agentDefaultEffort: 'high', agentDefaultPermissionMode: 'read-only', sidebarWidth: 333, panelHeight: 444 })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ ...next, sidebarWidth: 333, panelHeight: 444 }))
  })

  it('flushes the latest sidebar width immediately after a drag commit', async () => {
    useSettings.getState().patch({ sidebarWidth: 368 })
    useSettings.getState().flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ sidebarWidth: 368 }))
  })

  it('ignores an older self echo after a newer permission selection', async () => {
    useSettings.getState().patch({ agentDefaultPermissionMode: 'read-only' })
    await vi.advanceTimersByTimeAsync(0)
    const older = vi.mocked(api.saveSettings).mock.calls.at(-1)![0]
    useSettings.getState().patch({ agentDefaultPermissionMode: 'full-access' })
    await vi.advanceTimersByTimeAsync(0)
    useSettings.getState().applyExternal(older)
    expect(useSettings.getState().agentDefaultPermissionMode).toBe('full-access')
    expect(api.saveSettings).toHaveBeenCalledTimes(2)
  })
})

describe('Automatic update preference', () => {
  it('defaults to disabled and persists changes', async () => {
    expect(useSettings.getState().autoUpdate).toBe(false)
    useSettings.getState().patch({ autoUpdate: true })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ autoUpdate: true }))
  })

  it('adds the disabled default when loading an older settings schema', async () => {
    const { autoUpdate: _omitted, ...legacy } = DEFAULT_SETTINGS
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, schemaVersion: 11 } as Settings)
    await useSettings.getState().load()
    expect(useSettings.getState().autoUpdate).toBe(false)
    expect(useSettings.getState().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })
})

describe('Automatic save preference', () => {
  it('defaults to disabled', () => {
    expect(useSettings.getState().autoSave).toBe(false)
  })

  it('adds the disabled default when loading an older settings schema', async () => {
    const { autoSave: _omitted, ...legacy } = DEFAULT_SETTINGS
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, schemaVersion: 12 } as Settings)
    await useSettings.getState().load()
    expect(useSettings.getState().autoSave).toBe(false)
  })

  it('preserves an explicit enabled value across reloads', async () => {
    let disk: Settings = { ...DEFAULT_SETTINGS, autoSave: true }
    vi.mocked(api.saveSettings).mockImplementation(async (next) => { disk = structuredClone(next) })
    vi.mocked(api.loadSettings).mockImplementation(async () => structuredClone(disk))
    useSettings.getState().patch({ autoSave: true })
    await vi.advanceTimersByTimeAsync(400)
    useSettings.setState({ ...DEFAULT_SETTINGS, loaded: false })
    await useSettings.getState().load()
    expect(useSettings.getState().autoSave).toBe(true)
  })
})

describe('Agent history preference', () => {
  it('defaults to enabled and adds the enabled default for older settings', async () => {
    expect(useSettings.getState().agentHistoryEnabled).toBe(true)
    const { agentHistoryEnabled: _omitted, ...legacy } = DEFAULT_SETTINGS
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, schemaVersion: 12 } as Settings)
    await useSettings.getState().load()
    expect(useSettings.getState().agentHistoryEnabled).toBe(true)
    expect(useSettings.getState().schemaVersion).toBe(SETTINGS_SCHEMA_VERSION)
  })

  it('persists disabled state and synchronizes it across windows', async () => {
    useSettings.getState().patch({ agentHistoryEnabled: false })
    await vi.advanceTimersByTimeAsync(400)
    expect(api.saveSettings).toHaveBeenCalledWith(expect.objectContaining({ agentHistoryEnabled: false }))
    useSettings.getState().applyExternal({ ...DEFAULT_SETTINGS, agentHistoryEnabled: false })
    expect(useSettings.getState().agentHistoryEnabled).toBe(false)
  })
})

describe('Agent settings migration', () => {
  it.each([
    { saved: undefined, expected: 90 },
    { saved: 60, expected: 90 },
    { saved: 80, expected: 90 },
    { saved: 90, expected: 90 },
    { saved: 150, expected: 150 },
    { saved: 600, expected: 600 },
  ])('normalizes composer height $saved to $expected without resetting other preferences', async ({ saved, expected }) => {
    const { agentComposerHeight: _omitted, ...legacy } = DEFAULT_SETTINGS
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, fontSize: 17,
      ...(saved === undefined ? {} : { agentComposerHeight: saved }) } as Settings)
    await useSettings.getState().load()
    expect(useSettings.getState()).toMatchObject({ agentComposerHeight: expected, fontSize: 17 })
  })

  it('adds workspace-write to v10 settings and preserves known and unknown values', async () => {
    const { agentDefaultPermissionMode: _omitted, ...legacy } = DEFAULT_SETTINGS
    // Legacy IPC data intentionally omits the field required by the current Settings DTO.
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, schemaVersion: 10, fontSize: 17,
      agentDefaultProvider: 'codex', agentDefaultModel: 'custom-model', agentDefaultEffort: 'high',
      futurePreference: { enabled: true } } as unknown as Settings)
    await useSettings.getState().load()
    await vi.advanceTimersByTimeAsync(400)
    expect(api.saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ schemaVersion: SETTINGS_SCHEMA_VERSION,
      agentDefaultPermissionMode: 'workspace-write', fontSize: 17, agentDefaultProvider: 'codex',
      agentDefaultModel: 'custom-model', agentDefaultEffort: 'high', futurePreference: { enabled: true } }))
  })

  it.each(['unsupported', '', null, 7])(
    'falls back from invalid permissions %j without resetting other settings', async (invalid) => {
    vi.mocked(api.loadSettings).mockResolvedValue({ ...DEFAULT_SETTINGS, fontSize: 17,
      agentDefaultModel: 'custom-model', agentDefaultPermissionMode: invalid as AgentPermissionMode })
    await useSettings.getState().load()
    expect(useSettings.getState()).toMatchObject({ agentDefaultPermissionMode: 'workspace-write',
      fontSize: 17, agentDefaultModel: 'custom-model' })
  })
})


describe('Shortcut settings', () => {
  it('migrates legacy settings to empty overrides without resetting other preferences', async () => {
    const { shortcutOverrides: _missing, ...legacy } = DEFAULT_SETTINGS
    vi.mocked(api.loadSettings).mockResolvedValue({ ...legacy, schemaVersion: 13, fontSize: 19 } as Settings)
    await useSettings.getState().load()
    expect(useSettings.getState()).toMatchObject({ schemaVersion: 14, shortcutOverrides: {}, fontSize: 19 })
  })

  it('writes transferred ownership immediately and restores explicit unbinding after reload', async () => {
    const shortcutOverrides = { 'agent.ask': ['Mod+Shift+p'], 'view.commands': [], futureCommand: ['Mod+Shift+i'] }
    useSettings.getState().patch({ shortcutOverrides })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ shortcutOverrides }))
    const saved = structuredClone(vi.mocked(api.saveSettings).mock.calls[0][0])
    vi.mocked(api.loadSettings).mockResolvedValue(saved)
    useSettings.setState({ shortcutOverrides: {} })
    await useSettings.getState().load()
    expect(useSettings.getState().shortcutOverrides).toEqual(shortcutOverrides)
  })

  it('syncs key content without rewriting equivalent objects or resetting local geometry', async () => {
    const shortcutOverrides = { 'view.commands': [], 'agent.ask': ['Mod+Shift+p'] }
    useSettings.setState({ shortcutOverrides, sidebarWidth: 333 })
    useSettings.getState().applyExternal({ ...DEFAULT_SETTINGS, shortcutOverrides: {
      'agent.ask': ['Mod+Shift+p'], 'view.commands': [],
    } })
    await vi.advanceTimersByTimeAsync(0)
    expect(api.saveSettings).not.toHaveBeenCalled()
    useSettings.getState().applyExternal({ ...DEFAULT_SETTINGS, shortcutOverrides: { 'agent.ask': [] } })
    await vi.advanceTimersByTimeAsync(0)
    expect(useSettings.getState()).toMatchObject({ shortcutOverrides: { 'agent.ask': [] }, sidebarWidth: 333 })
    expect(api.saveSettings).toHaveBeenCalledTimes(1)
  })

  it('ignores a cloned echo of a recent write without rolling back a newer binding', async () => {
    useSettings.getState().patch({ shortcutOverrides: { 'agent.ask': ['Mod+Shift+i'] } })
    await vi.advanceTimersByTimeAsync(0)
    const old = structuredClone(vi.mocked(api.saveSettings).mock.calls[0][0])
    useSettings.getState().patch({ shortcutOverrides: { 'agent.ask': ['Mod+Shift+l'] } })
    await vi.advanceTimersByTimeAsync(0)
    useSettings.getState().applyExternal(old)
    expect(useSettings.getState().shortcutOverrides).toEqual({ 'agent.ask': ['Mod+Shift+l'] })
    expect(api.saveSettings).toHaveBeenCalledTimes(2)
  })
})
