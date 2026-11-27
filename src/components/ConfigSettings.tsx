import { Row, Card, Toggle, SettingsChoices, settingsButton } from './SettingsControls'
import { useState } from 'react'
import { api, errorText } from '../lib/ipc'
import { exportConfig, importConfigDocument } from '../lib/configBackup'
import { useSettings } from '../store/settings'
import { useUi } from '../store/ui'
import { useT } from '../i18n'

export function ConfigSettings() {
  const t = useT()
  const settings = useSettings()
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (action: () => Promise<void>) => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (error) {
      useUi.getState().toast(errorText(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  const importDocument = async (value: unknown) => {
    if (value === null) return
    await importConfigDocument(value)
    useUi.getState().toast(t('config.imported'), 'success')
  }
  const chooseFolder = async (enable: boolean) => {
    const folder = await api.configChooseFolder()
    if (!folder) return
    settings.patch({
      configBackupFolder: folder,
      configBackupEnabled: enable,
      configBackupLastAt: 0,
    })
    await settings.flushAsync()
  }
  return <>
    <Card title={t('config.transfer')}>
      <Row label={t('config.export')} hint={t('config.transferHint')}>
        <button type="button" className={settingsButton} disabled={busy} onClick={() => void run(async () => {
          const path = await exportConfig()
          if (path) useUi.getState().toast(t('config.exported', { path }), 'success')
        })}>{t('config.export')}</button>
      </Row>
      <Row label={t('config.importFile')}>
        <button type="button" className={settingsButton} disabled={busy} onClick={() => void run(async () => importDocument(await api.configImportFile()))}>{t('config.importFile')}</button>
      </Row>
      <div className="px-4 py-3">
        <label className="block text-sm text-fg" htmlFor="config-url">{t('config.url')}</label>
        <form className="mt-2 flex items-center gap-2" onSubmit={event => { event.preventDefault(); if (url.trim()) void run(async () => importDocument(await api.configImportUrl(url.trim()))) }}>
          <input id="config-url" type="url" required value={url} onChange={event => setUrl(event.target.value)} placeholder="https://example.com/tide-config.json"
            className="h-7 min-w-0 flex-1 rounded-[var(--r-control)] border border-line bg-bg px-3 text-sm" />
          <button className={settingsButton} disabled={busy || !url.trim()}>{t('config.importUrl')}</button>
        </form>
      </div>
    </Card>
    <Card title={t('config.automatic')}>
      <Row label={t('config.automatic')} hint={t('config.automaticHint')}>
        <Toggle role="switch" ariaLabel={t('config.automatic')} value={settings.configBackupEnabled} disabled={busy}
          onChange={enabled => { if (enabled) void run(() => chooseFolder(true)); else settings.patch({ configBackupEnabled: false }) }} />
      </Row>
      <Row label={t('config.folder')}>
        <div className="flex max-w-[330px] items-center gap-2">
          <span className="min-w-0 max-w-[190px] truncate text-xs text-muted" title={settings.configBackupFolder}>{settings.configBackupFolder || t('config.noFolder')}</span>
          <button type="button" className={settingsButton} disabled={busy} onClick={() => void run(() => chooseFolder(settings.configBackupEnabled))}>{t('config.folder')}</button>
        </div>
      </Row>
      <Row label={t('config.interval')}>
        <SettingsChoices label={t('config.interval')} value={settings.configBackupInterval} disabled={busy}
          options={[{ value: 'daily', label: t('config.daily') }, { value: 'threeDays', label: t('config.threeDays') }, { value: 'weekly', label: t('config.weekly') }, { value: 'monthly', label: t('config.monthly') }]}
          onChange={configBackupInterval => settings.patch({ configBackupInterval })} />
      </Row>
      <Row label={t('config.mode')}>
        <SettingsChoices label={t('config.mode')} value={settings.configBackupMode} disabled={busy}
          options={[{ value: 'dated', label: t('config.dated') }, { value: 'overwrite', label: t('config.overwrite') }]}
          onChange={configBackupMode => settings.patch({ configBackupMode })} />
      </Row>
      {settings.configBackupLastAt ? <p className="px-4 py-3 text-xs text-muted">{t('config.lastBackup', { date: new Date(settings.configBackupLastAt).toLocaleString(settings.locale) })}</p> : null}
    </Card>
  </>
}
