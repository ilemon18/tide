import { api, errorText, type Settings } from './ipc'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { updateApi } from './update'
import { t } from '../i18n'

let automaticBackupPending = false
const envelopeKeys = new Set(['format', 'version', 'appVersion', 'exportedAt', 'settings'])

export function readConfigDocument(value: unknown): Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(t('error.config.invalidData'))
  const document = value as Record<string, unknown>
  const wrapped = 'settings' in document || 'format' in document
  if (
    wrapped &&
    (document.format !== 'tide-config' ||
      typeof document.version !== 'number' ||
      document.version < 1 ||
      !Number.isInteger(document.version))
  )
    throw new Error(t('error.config.invalidData'))
  const settings = wrapped ? document.settings : document
  if (!settings || typeof settings !== 'object' || Array.isArray(settings))
    throw new Error(t('error.config.invalidData'))
  return settings as Settings
}

export async function importConfigDocument(value: unknown) {
  const settings = readConfigDocument(value)
  const raw = value as Record<string, unknown>
  const metadata =
    raw.format === 'tide-config'
      ? {
          version: raw.version,
          extras: Object.fromEntries(Object.entries(raw).filter(([key]) => !envelopeKeys.has(key))),
        }
      : undefined
  await useSettings
    .getState()
    .importSettings({ ...settings, ...(metadata ? { configTransferMetadata: metadata } : {}) })
}

export async function configDocument(now = new Date()) {
  const appVersion = await updateApi.appVersion()
  const { configTransferMetadata, ...settings } = useSettings
    .getState()
    .exportSettings() as Settings & {
    configTransferMetadata?: { version?: number; extras?: Record<string, unknown> }
  }
  const version =
    typeof configTransferMetadata?.version === 'number' &&
    Number.isInteger(configTransferMetadata.version) &&
    configTransferMetadata.version >= 1
      ? configTransferMetadata.version
      : 1
  const extras =
    configTransferMetadata?.extras &&
    typeof configTransferMetadata.extras === 'object' &&
    !Array.isArray(configTransferMetadata.extras)
      ? configTransferMetadata.extras
      : {}
  return {
    ...extras,
    format: 'tide-config',
    version,
    appVersion,
    exportedAt: now.toISOString(),
    settings,
  }
}

/** Calendar intervals retain local time; monthly backups clamp to the last day of the next month. */
export function nextBackupAt(last: number, interval: Settings['configBackupInterval']): number {
  const date = new Date(last)
  if (interval === 'monthly') {
    const day = date.getDate()
    date.setDate(1)
    date.setMonth(date.getMonth() + 1)
    const end = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
    date.setDate(Math.min(day, end))
  } else
    date.setDate(date.getDate() + (interval === 'daily' ? 1 : interval === 'threeDays' ? 3 : 7))
  return date.getTime()
}

export async function exportConfig(automatic = false, now = new Date()): Promise<string | null> {
  await useSettings.getState().flushAsync()
  const mode = useSettings.getState().configBackupMode
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  return api.configExport(
    await configDocument(now),
    automatic,
    automatic && mode === 'dated' ? `tide-config-${stamp}.json` : 'tide-config.json',
  )
}

/** One primary-window scheduler: missed backups run on launch; failed writes never advance the timestamp. */
export function startConfigBackups(): () => void {
  let stopped = false
  let failedAt = 0
  const check = async () => {
    const state = useSettings.getState()
    const now = Date.now()
    if (
      stopped ||
      automaticBackupPending ||
      !state.loaded ||
      !state.configBackupEnabled ||
      !state.configBackupFolder
    )
      return
    if (failedAt && now - failedAt < 60_000) return
    if (
      state.configBackupLastAt &&
      state.configBackupLastAt <= now &&
      now < nextBackupAt(state.configBackupLastAt, state.configBackupInterval)
    )
      return
    automaticBackupPending = true
    try {
      const path = await exportConfig(true, new Date(now))
      if (
        path &&
        useSettings.getState().configBackupFolder === state.configBackupFolder &&
        useSettings.getState().configBackupEnabled
      ) {
        useSettings.getState().patch({ configBackupLastAt: now })
        await useSettings.getState().flushAsync()
      }
    } catch (error) {
      failedAt = now
      useUi.getState().toast(t('config.backupFailed', { error: errorText(error) }), 'error')
    } finally {
      automaticBackupPending = false
    }
  }
  const unsubscribe = useSettings.subscribe((next, previous) => {
    if (
      next.loaded !== previous.loaded ||
      next.configBackupEnabled !== previous.configBackupEnabled ||
      next.configBackupFolder !== previous.configBackupFolder ||
      next.configBackupInterval !== previous.configBackupInterval
    )
      queueMicrotask(() => {
        void check()
      })
  })
  const timer = setInterval(() => {
    void check()
  }, 60_000)
  void check()
  return () => {
    stopped = true
    clearInterval(timer)
    unsubscribe()
  }
}
