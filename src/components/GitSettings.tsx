import { useEffect, useRef, useState } from 'react'
import { api, errorText, type GitPreferences, type GitRemote } from '../lib/ipc'
import { useGit, waitForIndexQueue } from '../store/git'
import { useUi } from '../store/ui'
import { useTabs } from '../store/tabs'
import { useWorkspace } from '../store/workspace'
import { useT, englishText, type MessageKey } from '../i18n'
import { Card, Row, Toggle, SettingsChoices, settingsButton } from './SettingsControls'
import { openRemoteRepository } from '../lib/actions'
import { Icon } from './Icon'

const fields: [keyof GitPreferences, MessageKey][] = [
  ['mergeAutoCommit', 'git.settings.mergeAutoCommit'],
  ['mergeLog', 'git.settings.mergeLog'],
  ['mergeNoFf', 'git.settings.mergeNoFf'],
  ['pullRebase', 'git.settings.pullRebase'],
  ['autoRefresh', 'git.settings.autoRefresh'],
  ['backgroundFetch', 'git.settings.backgroundFetch'],
  ['disableSubmoduleRecursion', 'git.settings.disableSubmoduleRecursion'],
]
const inputStyle =
  'h-8 w-full rounded-[var(--r-control)] border border-line bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-40'

function GitSettingLabel({ messageKey }: { messageKey: MessageKey }) {
  const t = useT()
  const translated = t(messageKey),
    english = englishText(messageKey)
  return (
    <>
      <span>{translated}</span>
      {translated !== english ? (
        <span lang="en" className="ml-1.5 text-2xs font-normal text-muted">
          ({english})
        </span>
      ) : null}
    </>
  )
}

export function GitSettings({ root, onClose }: { root: string | null; onClose: () => void }) {
  const t = useT()
  const globalPreferences = useGit((s) => s.preferences)
  const projectPreferences = useGit((s) => (root ? s.projectPreferences[root] : undefined))
  const preferences = projectPreferences ?? globalPreferences
  const gitBusy = useGit((s) => s.busy) !== null
  const info = useGit((s) => (root ? s.identities[root] : undefined))
  const [section, setSection] = useState<'general' | 'identity' | 'remotes'>('general')
  const [scope, setScope] = useState<'global' | 'local'>(root ? 'local' : 'global')
  const [useGlobal, setUseGlobal] = useState(true)
  const [name, setName] = useState(''),
    [email, setEmail] = useState('')
  const [remotes, setRemotes] = useState<GitRemote[]>([])
  const [oldRemote, setOldRemote] = useState<string | null>(null)
  const [remoteName, setRemoteName] = useState(''),
    [url, setUrl] = useState('')
  const [running, setRunning] = useState(false),
    [loaded, setLoaded] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const identityTouched = useRef(false)
  useEffect(() => {
    let disposed = false
    const git = useGit.getState()
    void Promise.all([
      git.loadPreferences(true),
      root ? git.loadProjectPreferences(root, true) : Promise.resolve(),
      root ? git.loadIdentity(root, true) : Promise.resolve(),
      root
        ? api.gitRemotes(root).then((value) => {
            if (!disposed) setRemotes(value)
          })
        : Promise.resolve(),
    ])
      .catch((error) => useUi.getState().toast(errorText(error), 'error'))
      .finally(() => {
        if (!disposed) setLoaded(true)
      })
    ref.current?.querySelector<HTMLElement>('button')?.focus()
    return () => {
      disposed = true
    }
  }, [root])
  useEffect(() => {
    if (identityTouched.current) return
    const identity = scope === 'global' ? info?.global : info?.effective
    setName(identity?.name ?? '')
    setEmail(identity?.email ?? '')
    setUseGlobal(info?.useGlobal ?? true)
  }, [info, scope])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (useUi.getState().confirmReq) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!running && !useUi.getState().confirmReq) onClose()
      }
      if (event.key !== 'Tab') return
      const controls = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled)',
        ) ?? []),
      ]
      if (!controls.length) {
        event.preventDefault()
        return
      }
      if (event.shiftKey && document.activeElement === controls[0]) {
        event.preventDefault()
        controls.at(-1)?.focus()
      } else if (!event.shiftKey && document.activeElement === controls.at(-1)) {
        event.preventDefault()
        controls[0]?.focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [onClose, running])
  const run = async (operation: () => Promise<unknown>) => {
    const git = useGit.getState()
    if (running || git.busy) return
    git.setBusy('settings')
    setRunning(true)
    try {
      if (root) await waitForIndexQueue(root)
      await operation()
    } catch (error) {
      useUi.getState().toast(errorText(error), 'error')
    } finally {
      git.setBusy(null)
      setRunning(false)
    }
  }
  const editConfig = (target: 'global' | 'local' | 'ignore') =>
    void run(async () => {
      const path = await api.gitPrepareConfig(root, target)
      await useTabs.getState().openExternalFile(path)
      onClose()
    })
  const saveRemote = () =>
    void run(async () => {
      if (!root) return
      await api.gitSetRemote(root, oldRemote, remoteName.trim(), url.trim())
      setRemotes(await api.gitRemotes(root))
      setOldRemote(null)
      setRemoteName('')
      setUrl('')
      useGit.getState().invalidateBranches(root)
      await useGit.getState().loadBranches(root, true)
    })
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4"
      onMouseDown={() => {
        if (!running && !useUi.getState().confirmReq) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        data-shortcut-dialog
        aria-label={t('git.settings.title')}
        onMouseDown={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-[600px] max-w-full flex-col overflow-hidden rounded-dialog border border-line-soft bg-bg shadow-dialog"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-md font-semibold">{t('git.settings.title')}</h2>
          <button
            aria-label={t('common.close')}
            disabled={running}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-hover"
            onClick={onClose}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="flex shrink-0 justify-start border-b border-line px-4 py-2">
          <SettingsChoices
            value={section}
            onChange={setSection}
            disabled={running}
            label={t('git.settings.title')}
            options={[
              { value: 'general', label: t('git.settings.general') },
              { value: 'identity', label: t('git.commitIdentity') },
              { value: 'remotes', label: t('git.settings.remotes') },
            ]}
          />
        </div>
        <div className="min-h-0 overflow-y-auto p-4">
          {section === 'general' ? (
            <>
              <Card title={t('git.settings.projectPreferences')}>
                {fields.map(([key, label]) => (
                  <Row key={key} label={<GitSettingLabel messageKey={label} />}>
                    <Toggle
                      role="switch"
                      ariaLabel={t(label)}
                      value={preferences[key]}
                      disabled={running || gitBusy || !loaded || !root || !projectPreferences}
                      onChange={(value) =>
                        void run(() =>
                          root
                            ? useGit.getState().setProjectPreferences(root, { [key]: value })
                            : Promise.resolve(),
                        )
                      }
                    />
                  </Row>
                ))}
              </Card>
              <Card title={t('git.settings.globalConfig')}>
                <Row label={<GitSettingLabel messageKey="git.settings.editGlobal" />}>
                  <button
                    className={settingsButton}
                    disabled={running || gitBusy}
                    onClick={() => editConfig('global')}
                  >
                    {t('common.edit')}
                  </button>
                </Row>
              </Card>
              <Card title={t('git.settings.projectConfig')}>
                <Row label={<GitSettingLabel messageKey="git.settings.editLocal" />}>
                  <button
                    className={settingsButton}
                    disabled={running || gitBusy || !loaded || !root}
                    onClick={() => editConfig('local')}
                  >
                    {t('common.edit')}
                  </button>
                </Row>
                <Row label={<GitSettingLabel messageKey="git.settings.editIgnore" />}>
                  <button
                    className={settingsButton}
                    disabled={running || gitBusy || !loaded || !root}
                    onClick={() => editConfig('ignore')}
                  >
                    {t('common.edit')}
                  </button>
                </Row>
              </Card>
            </>
          ) : null}
          {section === 'identity' ? (
            <Card>
              <Row label={<GitSettingLabel messageKey="git.identityMode" />}>
                <SettingsChoices
                  label={t('git.identityMode')}
                  value={scope}
                  onChange={(value) => {
                    identityTouched.current = false
                    setScope(value)
                  }}
                  disabled={running || gitBusy || !loaded || !root}
                  options={[
                    { value: 'global', label: t('git.settings.global') },
                    { value: 'local', label: t('git.settings.project') },
                  ]}
                />
              </Row>
              {scope === 'local' ? (
                <Row label={<GitSettingLabel messageKey="git.settings.useGlobal" />}>
                  <Toggle
                    role="switch"
                    ariaLabel={t('git.settings.useGlobal')}
                    value={useGlobal}
                    disabled={running || gitBusy || !loaded}
                    onChange={(value) => {
                      identityTouched.current = true
                      setUseGlobal(value)
                    }}
                  />
                </Row>
              ) : null}
              <div className="space-y-3 px-4 py-3">
                <label className="block text-xs text-muted">
                  <GitSettingLabel messageKey="git.identityName" />
                  <input
                    aria-label={t('git.identityName')}
                    className={`${inputStyle} mt-1`}
                    value={name}
                    maxLength={200}
                    disabled={running || gitBusy || !loaded || (scope === 'local' && useGlobal)}
                    onChange={(event) => {
                      identityTouched.current = true
                      setName(event.target.value)
                    }}
                  />
                </label>
                <label className="block text-xs text-muted">
                  <GitSettingLabel messageKey="git.identityEmail" />
                  <input
                    aria-label={t('git.identityEmail')}
                    className={`${inputStyle} mt-1`}
                    value={email}
                    type="email"
                    maxLength={320}
                    disabled={running || gitBusy || !loaded || (scope === 'local' && useGlobal)}
                    onChange={(event) => {
                      identityTouched.current = true
                      setEmail(event.target.value)
                    }}
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    className={settingsButton}
                    disabled={
                      running ||
                      (!(scope === 'local' && useGlobal) &&
                        !(name.trim() && /^[^\s<>@]+@[^\s<>@]+$/.test(email.trim())))
                    }
                    onClick={() =>
                      void run(async () => {
                        await api.gitSetIdentity(
                          scope === 'local' ? root : null,
                          scope === 'local' && useGlobal,
                          scope === 'local' && useGlobal
                            ? null
                            : { name: name.trim(), email: email.trim() },
                        )
                        if (root) await useGit.getState().loadIdentity(root, true)
                      })
                    }
                  >
                    {t('common.save')}
                  </button>
                </div>
              </div>
            </Card>
          ) : null}
          {section === 'remotes' ? (
            <Card title={t('git.settings.projectHint')}>
              {remotes.map((remote) => (
                <Row key={remote.name} label={remote.name} hint={remote.url}>
                  <div className="flex gap-1">
                    <button
                      className={settingsButton}
                      disabled={running}
                      onClick={() => {
                        setOldRemote(remote.name)
                        setRemoteName(remote.name)
                        setUrl(remote.url)
                      }}
                    >
                      {t('common.edit')}
                    </button>
                    <button
                      className={`${settingsButton} text-danger`}
                      disabled={running}
                      onClick={() =>
                        void run(async () => {
                          if (
                            !root ||
                            !(await useUi.getState().confirm({
                              title: t('git.settings.removeRemote'),
                              message: t('git.settings.removeRemoteConfirm', {
                                name: remote.name,
                              }),
                              danger: true,
                            }))
                          )
                            return
                          await api.gitRemoveRemote(root, remote.name)
                          setRemotes(await api.gitRemotes(root))
                          useGit.getState().invalidateBranches(root)
                        })
                      }
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                </Row>
              ))}
              <div className="space-y-3 px-4 py-3">
                <label className="block text-xs text-muted">
                  <GitSettingLabel messageKey="git.settings.remoteName" />
                  <input
                    aria-label={t('git.settings.remoteName')}
                    className={`${inputStyle} mt-1`}
                    value={remoteName}
                    disabled={running || gitBusy || !loaded || !root}
                    onChange={(event) => setRemoteName(event.target.value)}
                  />
                </label>
                <label className="block text-xs text-muted">
                  <GitSettingLabel messageKey="git.settings.remoteUrl" />
                  <input
                    aria-label={t('git.settings.remoteUrl')}
                    className={`${inputStyle} mt-1`}
                    value={url}
                    disabled={running || gitBusy || !loaded || !root}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                </label>
                <div className="flex justify-end gap-2">
                  {oldRemote ? (
                    <button
                      className={settingsButton}
                      disabled={running}
                      onClick={() => {
                        setOldRemote(null)
                        setRemoteName('')
                        setUrl('')
                      }}
                    >
                      {t('common.cancel')}
                    </button>
                  ) : null}
                  <button
                    className={settingsButton}
                    disabled={
                      running || gitBusy || !loaded || !root || !remoteName.trim() || !url.trim()
                    }
                    onClick={saveRemote}
                  >
                    {t(oldRemote ? 'common.save' : 'git.settings.addRemote')}
                  </button>
                </div>
              </div>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function useCurrentGitRoot() {
  const roots = useWorkspace(s => s.roots), active = useWorkspace(s => s.activeRootId)
  return roots.find(node => node.id === active && node.isGitRepo) ?? roots.find(node => node.isGitRepo)
}
export function GitHeaderRemote() {
  const t = useT(), root = useCurrentGitRoot()
  return <button type="button" aria-label={t('git.viewRemote')} data-tip={t('git.viewRemote')} disabled={!root} onClick={() => { if (root) void openRemoteRepository(root.id) }} className="mr-[1px] flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"><Icon name="eye" size={13} /></button>
}

export function GitHeaderSettings() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const root = useCurrentGitRoot()
  return (
    <>
      <button
        aria-label={t('git.settings.title')}
        data-tip={t('git.settings.title')}
        onClick={() => setOpen(true)}
        className="ml-auto flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
      >
        <Icon name="settings" size={14} />
      </button>
      {open ? <GitSettings root={root?.id ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  )
}
