import { memo } from 'react'
import type { AgentItem, AgentMessage as Message } from '../store/agent'
import type { AgentMention } from '../lib/ipc'
import { useTabs } from '../store/tabs'
import { revealInExplorer } from '../lib/actions'
import { basename } from '../lib/paths'
import { useT } from '../i18n'
import { AgentMarkdown } from './AgentMarkdown'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'

function openMention(root: string, mention: AgentMention) {
  // '.' is how the explorer's project row is mentioned; the reveal target is the root itself
  if (mention.isDir) revealInExplorer(root, mention.rel === '.' ? '' : mention.rel, true)
  else void useTabs.getState().openFile(root, mention.rel)
}

function MentionRow({ root, mentions }: { root: string; mentions: AgentMention[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {mentions.map((mention) => (
        <button
          key={mention.rel}
          type="button"
          onClick={() => openMention(root, mention)}
          className="flex max-w-[280px] items-center gap-1 rounded-[var(--r-row)] border border-line-soft bg-panel-alt px-1 py-0.5 text-2xs text-fg/80 transition-colors duration-fast hover:bg-hover hover:text-fg"
        >
          <FileIcon name={basename(mention.rel)} isDir={mention.isDir} size={12} />
          <span className="truncate font-mono text-[11px]">{mention.rel}</span>
        </button>
      ))}
    </div>
  )
}

function ToolStatus({ status }: { status?: AgentItem['status'] }) {
  if (status === 'running') {
    return <Icon name="spinner" size={12} className="shrink-0 animate-spin text-muted" />
  }
  if (status === 'error') {
    return <Icon name="alert-circle" size={12} className="shrink-0 text-danger" />
  }
  return <Icon name="check" size={12} className="shrink-0 text-success" />
}

function ToolCard({ item }: { item: AgentItem }) {
  const t = useT()
  return (
    <details className="group overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-2 px-2.5 text-xs text-fg/80 hover:bg-hover">
        <ToolStatus status={item.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">
          {item.title ?? t('agent.tool')}
        </span>
        <Icon
          name="chevron-right"
          size={11}
          className="shrink-0 text-muted transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="flex flex-col gap-2 border-t border-line-soft px-2.5 py-2">
        {item.detail ? (
          <div>
            <div className="mb-0.5 text-2xs text-muted">{t('agent.toolInput')}</div>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-bg px-2 py-1 font-mono text-[11px] leading-relaxed text-fg/80">
              {item.detail}
            </pre>
          </div>
        ) : null}
        {item.output ? (
          <div>
            <div className="mb-0.5 text-2xs text-muted">{t('agent.toolOutput')}</div>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-bg px-2 py-1 font-mono text-[11px] leading-relaxed text-fg/80">
              {item.output}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

function Item({ item }: { item: AgentItem }) {
  const t = useT()
  switch (item.type) {
    case 'text':
      return <AgentMarkdown text={item.text} />
    case 'thinking':
      return (
        <details className="text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-fg/80">
            <Icon name="info" size={11} />
            {t('agent.thinking')}
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-[12px] leading-relaxed">
            {item.text}
          </div>
        </details>
      )
    case 'tool':
      return <ToolCard item={item} />
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-[var(--r-popup)] border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          <Icon name="alert-circle" size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 whitespace-pre-wrap break-words">{item.text}</div>
        </div>
      )
    case 'log':
      return (
        <details className="text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-fg/80">
            <Icon name="terminal" size={11} />
            {t('agent.logs')}
          </summary>
          <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-panel px-2 py-1 font-mono text-[11px] leading-relaxed">
            {item.text}
          </pre>
        </details>
      )
    case 'notice':
      return (
        <div className="flex min-h-[22px] items-center gap-1.5 text-xs text-muted">
          <Icon name="info" size={11} className="shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap break-words">{item.text}</span>
        </div>
      )
    default:
      return null
  }
}

export const UserMessage = memo(function UserMessage({
  root,
  message,
}: {
  root: string
  message: Message
}) {
  const t = useT()
  return (
    <div className="flex max-w-[85%] flex-col gap-1.5 self-end rounded-[var(--r-popup)] border border-line-soft bg-panel px-3 py-2">
      <div className="text-2xs font-medium text-muted">{t('agent.you')}</div>
      {message.mentions && message.mentions.length > 0 ? (
        <MentionRow root={root} mentions={message.mentions} />
      ) : null}
      {message.text ? (
        <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">
          {message.text}
        </div>
      ) : null}
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  message,
  running,
}: {
  message: Message
  running: boolean
}) {
  const t = useT()
  const items = message.items ?? []
  return (
    <div className="flex gap-2">
      {/* 22px box = one 22px reply line: the avatar centre and the first line centre coincide */}
      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-accent/15 text-accent">
        <Icon name="agent" size={13} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        {items.length === 0 && running ? (
          <div className="flex min-h-[22px] items-center gap-1.5 text-xs text-muted">
            <Icon name="spinner" size={12} className="animate-spin" />
            {t('agent.working')}
          </div>
        ) : null}
        {items.map((item) => (
          <Item key={item.id} item={item} />
        ))}
      </div>
    </div>
  )
})
