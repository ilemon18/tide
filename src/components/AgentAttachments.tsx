import type { AgentContextAttachment } from '../lib/ipc'
import { useT } from '../i18n'
import { CopyButton } from './CopyButton'
import { Icon } from './Icon'

export function AgentAttachments({ attachments = [], onRemove }: {
  attachments?: AgentContextAttachment[]
  onRemove?: (id: string) => void
}) {
  const t = useT()
  if (!attachments.length) return null
  return (
    <div className="flex max-h-[220px] min-w-0 flex-col gap-1 overflow-y-auto" aria-label={t('agent.context.attachments')}>
      {attachments.map(item => (
        <div key={item.id} className="min-w-0 rounded-[var(--r-row)] border border-line-soft bg-panel-alt px-2 py-1 text-xs">
          <details>
            <summary className="cursor-pointer break-all text-fg/80">
              {item.kind === 'editor-selection'
                ? (item.rel ?? item.label) + ' · ' + item.startLine + ':' + item.startColumn + '–' + item.endLine + ':' + item.endColumn
                : item.label}
              {item.kind === 'editor-selection' && item.unsaved
                ? <span className="ml-1 text-muted">({t('agent.context.unsaved')})</span> : null}
            </summary>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-muted">
              <time dateTime={new Date(item.capturedAt).toISOString()}>{new Date(item.capturedAt).toLocaleString()}</time>
              {item.kind === 'terminal-selection'
                ? <span>{t('agent.context.startup', { path: item.startupRel === null ? t('agent.context.locationUnavailable') : item.startupRel || '.' })}</span> : null}
              <CopyButton text={item.text} label={t('agent.context.copy')} tip={t('agent.context.copy')} iconOnly />
            </div>
            <pre className="mt-1 max-h-[140px] overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-fg/80">{item.text}</pre>
          </details>
          {onRemove ? (
            <button type="button" onClick={() => onRemove(item.id)} aria-label={t('agent.context.remove')}
              className="mt-1 flex items-center gap-1 text-muted hover:text-fg">
              <Icon name="close" size={11} />{t('agent.context.remove')}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  )
}
