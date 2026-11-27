import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react'
import { api, errorText, type GitCommitHistory as History } from '../lib/ipc'
import { useSettings } from '../store/settings'
import { useT } from '../i18n'
import { Icon } from './Icon'
import {
  COMMIT_MESSAGE_LIMITS as limits,
  normalizeCommitTemplates,
  sortCommitTemplates,
  recentCommitMessages,
} from '../lib/commitMessages'

const EMPTY_MESSAGES: string[] = []

/** Only mounted while open; project history is released on dismissal. Common messages share Settings. */
export function GitCommitHistory({
  root,
  x,
  y,
  onPick,
  onClose,
}: {
  root: string
  x: number
  y: number
  onPick: (message: string) => void
  onClose: (restoreFocus?: boolean) => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const storedTemplates = useSettings((s) => s.commitMessageTemplates)
  const templates = storedTemplates ?? EMPTY_MESSAGES
  const [history, setHistory] = useState<History | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [pos, setPos] = useState({ x, y })
  const [editing, setEditing] = useState<{ original: string | null; value: string } | null>(null)
  const [formError, setFormError] = useState('')
  const matches = (message: string) =>
    message.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  const recent = recentCommitMessages(
    history?.messages ?? [],
    templates,
    history?.limit ?? limits.recent,
  ).filter(matches)
  const orderedCommon = useMemo(
    () => sortCommitTemplates(templates, history?.messages ?? [], history?.usedTemplates ?? []),
    [templates, history],
  )
  const common = orderedCommon.filter(matches)
  const messages = [...recent, ...common]
  const groups = [
    { title: t('git.recentCommitMessages'), messages: recent, offset: 0, common: false },
    { title: t('git.commonCommitMessages'), messages: common, offset: recent.length, common: true },
  ]
  useEffect(() => { setIndex(current => Math.min(current, Math.max(0, messages.length - 1))) }, [messages.length])
  useEffect(() => {
    let disposed = false
    void api
      .gitCommitHistory(root)
      .then((value) => {
        if (!disposed) setHistory(value)
      })
      .catch((error) => {
        if (!disposed) setError(errorText(error))
      })
    const down = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('mousedown', down)
    return () => {
      disposed = true
      document.removeEventListener('mousedown', down)
    }
  }, [root, onClose])
  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (rect)
      setPos((previous) => {
        const next = {
          x: Math.max(8, Math.min(x - rect.width, window.innerWidth - rect.width - 8)),
          y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
        }
        return Math.abs(previous.x - next.x) < 0.5 && Math.abs(previous.y - next.y) < 0.5
          ? previous
          : next
      })
  }, [x, y, history, error, query, editing, templates])
  const edit = (original: string | null) => {
    setFormError('')
    setEditing({ original, value: original ?? '' })
  }
  const save = () => {
    if (!editing) return
    const current = useSettings.getState().commitMessageTemplates ?? []
    const message = editing.value.trim()
    if (!message) return
    if (new TextEncoder().encode(message).length > limits.messageBytes) {
      setFormError(t('error.git.historyMessageTooLarge', { limit: limits.messageBytes / 1024 }))
      return
    }
    if (editing.original === null && current.length >= limits.templates) {
      setFormError(t('git.commitTemplateLimit', { count: limits.templates }))
      return
    }
    if (editing.original && !current.includes(editing.original)) {
      setFormError(t('git.commitTemplateChanged'))
      return
    }
    const next = editing.original
      ? current.map((value) => (value === editing.original ? message : value))
      : [...current, message]
    useSettings.getState().patch({ commitMessageTemplates: normalizeCommitTemplates(next) })
    setEditing(null)
  }
  return (
    <div
      ref={ref}
      role="dialog"
      data-shortcut-dialog
      aria-label={t('git.commitHistory')}
      className="fixed z-50 w-[280px] max-w-[calc(100vw-16px)] overflow-hidden rounded-popup border border-line-soft bg-panel shadow-popup"
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (editing) setEditing(null)
          else onClose(true)
        }
        if (editing) return
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setIndex((current) => Math.max(0, Math.min(current + 1, messages.length - 1)))
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setIndex((current) => Math.max(0, current - 1))
        }
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
          event.preventDefault()
          if (messages[index]) onPick(messages[index])
        }
      }}
    >
      <div className="flex items-center gap-1 border-b border-line px-2 py-2">
        <Icon name="search" size={13} className="shrink-0 text-muted" />
        <input
          autoFocus
          aria-label={t('git.searchCommitHistory')}
          placeholder={t('git.searchCommitHistory')}
          value={query}
          disabled={Boolean(editing)}
          onChange={(event) => {
            setQuery(event.target.value)
            setIndex(0)
          }}
          className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/60"
        />
        <button
          type="button"
          aria-label={t('git.addCommitTemplate')}
          data-tip={
            templates.length >= limits.templates
              ? t('git.commitTemplateLimit', { count: limits.templates })
              : t('git.addCommitTemplate')
          }
          disabled={templates.length >= limits.templates}
          onClick={() => edit(null)}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Icon name="plus" size={12} />
        </button>
        <button
          type="button"
          aria-label={t('common.close')}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
          onClick={() => onClose(true)}
        >
          <Icon name="close" size={12} />
        </button>
      </div>
      {editing ? (
        <form
          className="space-y-2 p-2"
          onSubmit={(event) => {
            event.preventDefault()
            save()
          }}
        >
          <label className="block text-xs text-muted">
            {t(editing.original ? 'git.editCommitTemplate' : 'git.addCommitTemplate')}
            <textarea
              autoFocus
              aria-label={t('git.commitTemplateMessage')}
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              maxLength={limits.messageBytes}
              rows={3}
              className="mt-1 block w-full resize-none rounded border border-line bg-bg px-2 py-1.5 text-sm outline-none focus:border-accent"
            />
          </label>
          {formError ? <p className="text-xs text-danger">{formError}</p> : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded border border-line px-2 py-1 text-xs text-muted hover:bg-hover"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!editing.value.trim()}
              className="rounded bg-accent px-2 py-1 text-xs text-accent-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('common.save')}
            </button>
          </div>
        </form>
      ) : (
        <div className="max-h-[min(320px,50vh)] overflow-y-auto py-1">
          {groups.map((group) => (
            <section key={group.title} aria-label={group.title}>
              <h3 className="px-3 pb-1 pt-2 text-2xs font-medium text-muted">{group.title}</h3>
              {group.messages.map((message, itemIndex) => {
                const active = group.offset + itemIndex
                return (
                  <div
                    key={message}
                    className={`group mx-1 flex min-w-0 items-center rounded ${active === index ? 'bg-active' : 'hover:bg-hover'}`}
                    onMouseEnter={() => setIndex(active)}
                  >
                    <button
                      type="button"
                      onClick={() => onPick(message)}
                      title={message}
                      className="min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left text-sm text-fg"
                    >
                      {message.split('\n')[0]}
                    </button>
                    {group.common ? (
                      <div className="invisible flex shrink-0 items-center pr-1 group-hover:visible group-focus-within:visible">
                        <button
                          aria-label={t('git.editCommitTemplate')}
                          data-tip={t('git.editCommitTemplate')}
                          className="flex h-[18px] w-[18px] items-center justify-center rounded text-muted hover:bg-hover hover:text-fg"
                          onClick={() => edit(message)}
                        >
                          <Icon name="pen" size={11} />
                        </button>
                        <button
                          aria-label={t('git.deleteCommitTemplate')}
                          data-tip={t('git.deleteCommitTemplate')}
                          className="flex h-[18px] w-[18px] items-center justify-center rounded text-danger hover:bg-danger/15"
                          onClick={() =>
                            useSettings.getState().patch({
                              commitMessageTemplates: (
                                useSettings.getState().commitMessageTemplates ?? []
                              ).filter((value) => value !== message),
                            })
                          }
                        >
                          <Icon name="trash" size={11} />
                        </button>
                      </div>
                    ) : null}
                  </div>
                )
              })}
              {!group.messages.length ? (
                <p className="px-3 pb-3 pt-1 text-xs text-muted">
                  {group.common
                    ? t(query ? 'git.noCommitHistoryMatch' : 'git.commitTemplatesEmpty')
                    : error ||
                      t(
                        history
                          ? query
                            ? 'git.noCommitHistoryMatch'
                            : 'git.commitHistoryEmpty'
                          : 'branch.loading',
                      )}
                </p>
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
