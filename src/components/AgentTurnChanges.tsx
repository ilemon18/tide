import { memo, useState } from 'react'
import type { AgentTurnChangeFile, AgentTurnChanges as TurnChanges } from '../lib/ipc'
import { useAgent } from '../store/agent'
import { useGit } from '../store/git'
import { useTabs } from '../store/tabs'
import { useUi } from '../store/ui'
import { useT } from '../i18n'
import { basename } from '../lib/paths'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'

/** Rows shown before the "show more" toggle; the rest stay one click away */
const VISIBLE_FILES = 6

function statusTone(status: string): string {
  if (status === 'A') return 'text-success'
  if (status === 'D') return 'text-danger'
  if (status === 'R') return 'text-accent'
  return 'text-fg/55'
}

/** Renames show both paths; every other status shows the single path it touched */
function fileLabel(file: AgentTurnChangeFile): string {
  return file.oldPath ? `${file.oldPath} → ${file.path}` : file.path
}

type Props = {
  chatId: string
  root: string
  messageId: string
  changes: TurnChanges
  /** Only the chat's latest reply may undo: an older turn would overwrite later work */
  latest: boolean
}

/** What one finished agent turn changed, with per-file line counts and its undo. */
export const AgentTurnChanges = memo(function AgentTurnChanges({
  chatId,
  root,
  messageId,
  changes,
  latest,
}: Props) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const [pending, setPending] = useState(false)
  const busy = useGit((s) => s.busy !== null)
  if (changes.files.length === 0) return null

  const files = expanded ? changes.files : changes.files.slice(0, VISIBLE_FILES)
  const hidden = changes.files.length - files.length
  // A truncated list cannot be undone: the card does not carry every path the turn touched
  const canUndo = latest && !changes.revertedAt && !changes.stale && !changes.truncated && !pending && !busy
  const unavailable = Boolean(changes.stale || changes.truncated)

  const revert = async () => {
    const confirmed = await useUi.getState().confirm({
      title: t('dialog.agentRevert.title'),
      message: [
        t('dialog.agentRevert.message', { count: changes.files.length }),
        changes.headChanged ? t('dialog.agentRevert.messageWithCommit') : '',
      ].filter(Boolean).join('\n\n'),
      confirmText: t('dialog.agentRevert.confirm'),
      danger: true,
      // Destructive and irreversible: require an explicit click, never Enter
      confirmOnEnter: false,
    })
    if (!confirmed) return
    // A queued turn may have started while the dialog was open; never overwrite its writes
    const chat = useAgent.getState().chats?.[chatId]
    if (!chat || chat.status === 'running' || chat.messages.at(-1)?.id !== messageId) return
    setPending(true)
    try {
      const result = await useGit.getState().revertTurnChanges(root, changes)
      if (result === 'ok') {
        useAgent.getState().markTurnChangesReverted(chatId, messageId)
        useUi.getState().toast(t('toast.agentChangesReverted'), 'success')
      } else if (result === 'stale') {
        // The baseline was pruned by `git gc`: keep the summary, drop the dead action
        useAgent.getState().markTurnChangesStale(chatId, messageId)
        useUi.getState().toast(t('agent.changes.unavailable'), 'error')
      }
    } catch {
      // The Git store reports its own failures; never leave the button spinning
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      role="group"
      aria-label={t('agent.changes.title', { count: changes.files.length })}
      data-agent-changes={messageId}
      className="flex flex-col gap-1 rounded-[var(--r-row)] border border-line-soft bg-panel/70 px-2.5 py-1.5 text-2xs"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <Icon name="git" size={11} className="shrink-0 text-muted" />
        <span className="shrink-0 text-fg/80">
          {t('agent.changes.title', { count: changes.files.length })}
        </span>
        {changes.additions > 0 ? (
          <span
            className="shrink-0 font-mono text-success"
            data-tip={t('agent.changes.additions')}
            data-changes-additions={changes.additions}
          >
            +{changes.additions}
          </span>
        ) : null}
        {changes.deletions > 0 ? (
          <span
            className="shrink-0 font-mono text-danger"
            data-tip={t('agent.changes.deletions')}
            data-changes-deletions={changes.deletions}
          >
            −{changes.deletions}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-1">
          {changes.revertedAt ? (
            <span className="flex items-center gap-1 text-muted">
              <Icon name="check" size={10} />
              {t('agent.changes.reverted')}
            </span>
          ) : latest && unavailable ? (
            <span className="text-muted">{t('agent.changes.unavailable')}</span>
          ) : latest ? (
            <button
              type="button"
              disabled={!canUndo}
              onClick={() => void revert()}
              className="flex items-center gap-1 rounded-[3px] border border-line-soft px-1.5 py-0.5 text-fg/80 transition-colors duration-fast hover:bg-hover hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="undo" size={10} />
              {t('agent.changes.revert')}
            </button>
          ) : null}
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        {files.map((file) => (
          <button
            key={`${file.oldPath ?? ''}:${file.path}`}
            type="button"
            title={fileLabel(file)}
            onClick={() => void useTabs.getState().openDiff(root, file.path, false)}
            className="group flex min-w-0 items-center gap-1.5 rounded-[3px] px-1 py-1 text-left transition-colors duration-fast hover:bg-hover"
          >
            <FileIcon name={basename(file.path)} size={12} className="shrink-0" />
            <span className={`w-[10px] shrink-0 font-mono ${statusTone(file.status)}`}>
              {file.status}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg/75 group-hover:text-fg">
              {fileLabel(file)}
            </span>
            {file.binary ? (
              <span className="shrink-0 text-muted">{t('agent.changes.binary')}</span>
            ) : file.additions === 0 && file.deletions === 0 ? null : (
              <span className="shrink-0 whitespace-nowrap font-mono">
                {file.additions > 0 ? <span className="text-success">+{file.additions}</span> : null}
                {file.deletions > 0 ? (
                  <span className={`text-danger ${file.additions > 0 ? 'ml-1' : ''}`}>
                    −{file.deletions}
                  </span>
                ) : null}
              </span>
            )}
          </button>
        ))}
      </div>

      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-fit items-center gap-1 rounded-[3px] px-1 text-accent hover:underline"
        >
          <Icon name="chevron-down" size={10} />
          {t('agent.changes.showMore', { count: hidden })}
        </button>
      ) : null}
      {expanded && changes.files.length > VISIBLE_FILES ? (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="flex w-fit items-center gap-1 rounded-[3px] px-1 text-accent hover:underline"
        >
          <Icon name="chevron-right" size={10} />
          {t('agent.changes.showLess')}
        </button>
      ) : null}
      {changes.truncated ? (
        <span className="px-1 text-muted">{t('agent.changes.truncated', { count: changes.files.length })}</span>
      ) : null}
    </div>
  )
})
