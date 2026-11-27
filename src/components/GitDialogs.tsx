import { useEffect, useRef, useState } from 'react'
import { useGit } from '../store/git'
import { createBranch } from '../lib/actions'
import { api, errorText, type GitBranch, type GitStashEntry } from '../lib/ipc'
import { useUi } from '../store/ui'
import { relativeTime } from '../lib/format'
import { useT } from '../i18n'
import { Icon } from './Icon'
import { SettingsChoices } from './SettingsControls'

export type GitDialog =
  | {
      kind: 'create' | 'forcePush' | 'stash' | 'popStash' | 'clearStash'
      root: string
      current: string
    }
  | { kind: 'identity'; root: string }
  | {
      kind: 'rename' | 'delete' | 'merge' | 'rebase'
      root: string
      current: string
      branch: GitBranch
      force?: boolean
    }

const field =
  'h-8 w-full rounded-[var(--r-control)] border border-line bg-bg px-2 text-sm outline-none focus:border-accent disabled:opacity-50'

/** Git-specific forms retain the backdrop until mutations finish, keeping background edits out. */
export function GitDialogs({ dialog, onClose }: { dialog: GitDialog; onClose: () => void }) {
  const t = useT()
  const busy = useGit((s) => s.busy) !== null
  const info = useGit((s) => s.identities[dialog.root])
  const temporary = useGit((s) => s.temporaryIdentity)
  const defaultIdentity = info?.effective
  const [mode, setMode] = useState<'default' | 'temporary'>(temporary ? 'temporary' : 'default')
  const branch = 'branch' in dialog ? dialog.branch : null
  const [name, setName] = useState(
    dialog.kind === 'identity'
      ? (temporary?.name ?? defaultIdentity?.name ?? '')
      : dialog.kind === 'rename' && branch
        ? branch.kind === 'remote'
          ? branch.name.slice(branch.name.indexOf('/') + 1)
          : branch.name
        : '',
  )
  const [email, setEmail] = useState(temporary?.email ?? defaultIdentity?.email ?? '')
  const [checkout, setCheckout] = useState(true)
  const [deleteRemote, setDeleteRemote] = useState(branch?.kind === 'remote')
  const [force, setForce] = useState('force' in dialog && Boolean(dialog.force))
  const [entries, setEntries] = useState<GitStashEntry[]>([])
  const [selected, setSelected] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [running, setRunning] = useState(false)
  const ref = useRef<HTMLFormElement>(null)
  const locked = busy || running
  const close = () => {
    if (!locked) onClose()
  }
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input:not(:disabled), button:not(:disabled)')?.focus()
    if (dialog.kind === 'identity') void useGit.getState().loadIdentity(dialog.root, true)
  }, [dialog.kind, dialog.root])
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!locked) onClose()
      }
      if (event.key !== 'Tab') return
      const controls = [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled)',
        ) ?? []),
      ]
      if (!controls.length) {
        event.preventDefault()
        return
      }
      const first = controls[0],
        last = controls.at(-1)
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    window.addEventListener('keydown', keydown, true)
    return () => window.removeEventListener('keydown', keydown, true)
  }, [locked, onClose])
  const titles = {
    create: 'git.createBranch',
    identity: 'git.commitIdentity',
    rename: 'git.renameBranch',
    delete: 'git.deleteBranch',
    merge: 'git.mergeBranch',
    rebase: 'git.rebaseBranch',
    forcePush: 'git.forcePush',
    stash: 'git.stashChanges',
    popStash: 'git.popStash',
    clearStash: 'git.clearStash',
  } as const
  const current = 'current' in dialog ? dialog.current : ''
  const danger =
    ['delete', 'forcePush', 'rebase', 'clearStash'].includes(dialog.kind) ||
    (dialog.kind === 'rename' && branch?.kind === 'remote')
  const identityValid = Boolean(
    name.trim() && /^[^\s<>@]+@[^\s<>@]+$/.test(email.trim()) && !/[<>]/.test(name),
  )
  const valid =
    !locked &&
    (dialog.kind === 'identity'
      ? mode === 'default' || identityValid
      : ['create', 'rename'].includes(dialog.kind)
        ? Boolean(name.trim()) && name.trim() !== branch?.name
        : dialog.kind === 'popStash'
          ? Boolean(selected) && !loading
          : dialog.kind !== 'delete' || !branch?.current)
  useEffect(() => {
    if (dialog.kind !== 'popStash') return
    let disposed = false
    setLoading(true)
    void api
      .gitStashList(dialog.root)
      .then((page) => {
        if (disposed) return
        setEntries(page.entries)
        setHasMore(page.hasMore)
        setSelected(page.entries[0]?.sha ?? '')
      })
      .catch((error) => {
        if (!disposed) setListError(errorText(error))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [dialog.kind, dialog.root])
  const loadMore = async () => {
    if (loading || locked) return
    setLoading(true)
    try {
      const page = await api.gitStashList(dialog.root, entries.length)
      setEntries((previous) => [...previous, ...page.entries])
      setHasMore(page.hasMore)
    } catch (error) {
      useUi.getState().toast(errorText(error), 'error')
    } finally {
      setLoading(false)
    }
  }
  const submit = async () => {
    if (!valid) return
    setRunning(true)
    try {
      const git = useGit.getState()
      const target = branch ? { name: branch.name, kind: branch.kind } : null
      if (dialog.kind === 'identity') {
        git.setTemporaryIdentity(
          mode === 'temporary' ? { name: name.trim(), email: email.trim() } : null,
        )
        onClose()
        return
      }
      if (dialog.kind === 'create') {
        if (await createBranch(dialog.root, name.trim(), checkout)) onClose()
        return
      }
      if (dialog.kind === 'rename' && target) {
        if (await git.renameBranch(dialog.root, target, name.trim())) onClose()
        return
      }
      if (
        dialog.kind === 'delete' &&
        target &&
        !(await git.deleteBranch(dialog.root, target, deleteRemote, force))
      )
        return
      if (
        (dialog.kind === 'merge' || dialog.kind === 'rebase') &&
        target &&
        !(await git.integrateBranch(dialog.root, target, dialog.kind === 'rebase'))
      )
        return
      if (dialog.kind === 'forcePush' && !(await git.forcePush(dialog.root))) return
      if (dialog.kind === 'stash' && !(await git.stashChanges(dialog.root, name.trim()))) return
      if (dialog.kind === 'popStash') await git.popStash(dialog.root, selected)
      if (dialog.kind === 'clearStash' && !(await git.clearStash(dialog.root))) return
      onClose()
    } finally {
      setRunning(false)
    }
  }
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/35 p-4"
      onMouseDown={close}
    >
      <form
        ref={ref}
        role="dialog"
        aria-modal="true"
        data-shortcut-dialog
        aria-label={t(titles[dialog.kind])}
        className="w-[420px] max-w-full overflow-hidden rounded-dialog border border-line-soft bg-panel shadow-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          void submit()
        }}
      >
        <div className="space-y-3 px-4 pb-4 pt-4">
          <h2 className="text-md font-semibold text-fg">{t(titles[dialog.kind])}</h2>
          {dialog.kind === 'identity' ? (
            <>
              <div className="flex justify-center">
                <SettingsChoices
                  label={t('git.identityMode')}
                  value={mode}
                  disabled={locked}
                  onChange={setMode}
                  options={[
                    { value: 'default', label: t('git.defaultIdentity') },
                    { value: 'temporary', label: t('git.temporaryIdentity') },
                  ]}
                />
              </div>
              <div className="space-y-2 rounded border border-line-soft bg-bg/50 px-2 py-2 text-center text-xs">
                {[
                  { label: t('git.projectIdentity'), value: defaultIdentity },
                  { label: t('git.globalIdentity'), value: info?.global },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <div className="mb-1 text-2xs text-muted">{label}</div>
                    <div
                      className="flex min-w-0 items-center justify-center gap-1 text-fg/85"
                      title={
                        value?.name ? `${value.name} (${value.email})` : t('git.identityUnset')
                      }
                    >
                      <Icon name="user" size={12} className="shrink-0" />
                      <span className="min-w-0 truncate">
                        {value?.name ? `${value.name} (${value.email})` : t('git.identityUnset')}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <label className="block text-xs text-muted">
                {t('git.identityName')}
                <input
                  aria-label={t('git.identityName')}
                  value={mode === 'default' ? (defaultIdentity?.name ?? '') : name}
                  onChange={(event) => setName(event.target.value)}
                  disabled={locked || mode === 'default'}
                  maxLength={200}
                  className={`${field} mt-1`}
                />
              </label>
              <label className="block text-xs text-muted">
                {t('git.identityEmail')}
                <input
                  aria-label={t('git.identityEmail')}
                  type="email"
                  value={mode === 'default' ? (defaultIdentity?.email ?? '') : email}
                  onChange={(event) => setEmail(event.target.value)}
                  disabled={locked || mode === 'default'}
                  maxLength={320}
                  className={`${field} mt-1`}
                />
              </label>
              <p className="text-xs leading-relaxed text-muted">{t('git.temporaryIdentityHint')}</p>
            </>
          ) : (
            <>
              <div
                className="truncate rounded border border-line-soft bg-bg/50 px-2 py-2 text-xs text-muted"
                title={current}
              >
                {t('git.currentBranchLabel')} <span className="text-fg">{current}</span>
              </div>
              {dialog.kind === 'create' || dialog.kind === 'rename' ? (
                <>
                  {dialog.kind === 'rename' && branch ? (
                    <p className="truncate text-xs text-muted" title={branch.name}>
                      {branch.name}
                    </p>
                  ) : null}
                  <label className="block text-xs text-muted">
                    {t('git.newBranchName')}
                    <input
                      aria-label={t('git.newBranchName')}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      disabled={locked}
                      spellCheck={false}
                      className={`${field} mt-1`}
                    />
                  </label>
                  {dialog.kind === 'create' ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={checkout}
                        disabled={locked}
                        onChange={(event) => setCheckout(event.target.checked)}
                        className="cursor-pointer accent-accent"
                      />
                      {t('git.checkoutNewBranch')}
                    </label>
                  ) : branch?.kind === 'remote' ? (
                    <p className="text-xs leading-relaxed text-warning">
                      {t('git.remoteRenameHint')}
                    </p>
                  ) : null}
                </>
              ) : null}
              {dialog.kind === 'delete' && branch ? (
                <>
                  <p className="break-words text-sm text-muted">
                    {t('git.deleteBranchConfirm', { name: branch.name })}
                  </p>
                  <label className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={deleteRemote}
                      disabled={locked || branch.kind === 'remote' || !branch.upstream}
                      onChange={(event) => setDeleteRemote(event.target.checked)}
                      className="cursor-pointer accent-accent"
                    />
                    {t('git.deleteRemoteBranch')}
                  </label>
                  {branch.kind === 'local' ? (
                    <label className="flex cursor-pointer items-center gap-2 text-sm text-danger">
                      <input
                        type="checkbox"
                        checked={force}
                        disabled={locked}
                        onChange={(event) => setForce(event.target.checked)}
                        className="cursor-pointer accent-danger"
                      />
                      {t('git.forceDeleteBranch')}
                    </label>
                  ) : null}
                </>
              ) : null}
              {(dialog.kind === 'merge' || dialog.kind === 'rebase') && branch ? (
                <p className="break-words text-sm leading-relaxed text-muted">
                  {t(dialog.kind === 'merge' ? 'git.mergeConfirm' : 'git.rebaseConfirm', {
                    branch: branch.name,
                    current,
                  })}
                </p>
              ) : null}
              {dialog.kind === 'stash' ? (
                <label className="block text-xs text-muted">
                  {t('git.stashMessage')}
                  <input
                    aria-label={t('git.stashMessage')}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    disabled={locked}
                    maxLength={1000}
                    className={`${field} mt-1`}
                    placeholder={t('git.stashMessageHint')}
                  />
                </label>
              ) : null}
              {dialog.kind === 'clearStash' ? (
                <p className="text-sm leading-relaxed text-warning">{t('git.clearStashConfirm')}</p>
              ) : null}
              {dialog.kind === 'popStash' ? (
                <div
                  className="max-h-64 overflow-auto rounded border border-line-soft"
                  role="radiogroup"
                  aria-label={t('git.popStash')}
                >
                  {entries.map((entry) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected === entry.sha}
                      key={entry.sha}
                      disabled={locked}
                      onClick={() => setSelected(entry.sha)}
                      className={`flex w-full cursor-pointer flex-col gap-1 border-b border-line/60 px-2 py-2 text-left last:border-0 ${selected === entry.sha ? 'bg-active text-fg' : 'text-muted hover:bg-hover'}`}
                    >
                      <span className="text-xs">
                        {entry.selector} · {relativeTime(entry.time)}
                      </span>
                      <span className="w-full truncate text-sm" title={entry.message}>
                        {entry.message}
                      </span>
                    </button>
                  ))}
                  {!entries.length ? (
                    <p className="px-2 py-4 text-xs text-muted">
                      {listError || t(loading ? 'branch.loading' : 'git.noStashes')}
                    </p>
                  ) : null}
                  {hasMore ? (
                    <button
                      type="button"
                      disabled={locked || loading}
                      className="w-full px-2 py-2 text-xs text-accent hover:bg-hover"
                      onClick={() => void loadMore()}
                    >
                      {t('common.loadMore')}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {dialog.kind === 'forcePush' ? (
                <p className="text-sm leading-relaxed text-warning">{t('git.forcePushHint')}</p>
              ) : null}
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-3 py-2.5">
          <button
            type="button"
            onClick={close}
            disabled={locked}
            className="flex h-7 cursor-pointer items-center justify-center rounded border border-line px-3 text-sm text-muted hover:bg-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!valid}
            className={`flex h-7 cursor-pointer items-center justify-center rounded px-3 text-sm font-medium text-accent-fg disabled:cursor-not-allowed disabled:opacity-40 ${danger ? 'bg-danger' : 'bg-accent'}`}
          >
            {locked
              ? t('git.processing')
              : t(
                  dialog.kind === 'delete'
                    ? 'common.delete'
                    : dialog.kind === 'identity'
                      ? 'common.save'
                      : titles[dialog.kind],
                )}
          </button>
        </div>
      </form>
    </div>
  )
}
