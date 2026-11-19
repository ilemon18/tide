import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentItem, AgentMessage as Message } from '../store/agent'
import type { AgentMention } from '../lib/ipc'
import { useTabs } from '../store/tabs'
import { useAgent } from '../store/agent'
import { revealInExplorer } from '../lib/actions'
import { basename } from '../lib/paths'
import { useT } from '../i18n'
import { AgentMarkdown } from './AgentMarkdown'
import { CommandChip, SkillChip } from './AgentTags'
import { CopyButton } from './CopyButton'
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

/** Plain-text user turn, including the command, skills, mentions and prompt. */
export function serializeUserMessage(message: Message): string {
  const parts: string[] = []
  if (message.command) parts.push(`/${message.command}`)
  for (const skill of message.skills ?? []) parts.push(`$${skill.name} (${skill.path})`)
  for (const mention of message.mentions ?? []) parts.push(`@${mention.rel}`)
  if (message.text) parts.push(message.text)
  return parts.join('\n')
}

/** Plain-text assistant turn with every content block, tool/question details and diagnostic item. */
export function serializeAssistantMessage(message: Message): string {
  const parts: string[] = []
  for (const item of message.items ?? []) {
    if (item.type === 'tool') {
      if (item.title) parts.push(item.title)
      if (item.detail) parts.push(item.detail)
      if (item.output) parts.push(item.output)
    } else if (item.type === 'question') {
      const question: string[] = []
      if (item.header) question.push(item.header)
      if (item.question) question.push(item.question)
      if (item.options?.length) {
        question.push(
          item.options
            .map((option) => `${option.label}\n${option.description}`)
            .join('\n'),
        )
      }
      if (item.answer) question.push(item.answer)
      if (question.length > 0) parts.push(question.join('\n'))
    } else if (item.text) {
      parts.push(item.text)
    }
  }
  return parts.join('\n\n')
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

const itemControlClass =
  'h-5 w-5 opacity-0 transition-opacity duration-fast group-hover/item:opacity-100 group-focus-within/item:opacity-100'

function ToolCard({ item }: { item: AgentItem }) {
  const t = useT()
  const title = item.title ?? t('agent.tool')
  return (
    <details className="group group/item overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-2 px-2.5 text-xs text-fg/80 hover:bg-hover">
        <ToolStatus status={item.status} />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{title}</span>
        <CopyButton
          text={title}
          label={t('agent.copy.toolTitle')}
          tip={t('agent.copy.toolTitle')}
          iconOnly
          className={itemControlClass}
        />
        <Icon
          name="chevron-right"
          size={11}
          className="shrink-0 text-muted transition-transform group-open:rotate-90"
        />
      </summary>
      <div className="flex flex-col gap-2 border-t border-line-soft px-2.5 py-2">
        {item.detail ? (
          <div className="group/item">
            <div className="mb-0.5 flex min-h-5 items-center gap-1 text-2xs text-muted">
              <span className="flex-1">{t('agent.toolInput')}</span>
              <CopyButton
                text={item.detail}
                label={t('agent.copy.toolInput')}
                tip={t('agent.copy.toolInput')}
                iconOnly
                className={itemControlClass}
              />
            </div>
            <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-bg px-2 py-1 font-mono text-[11px] leading-relaxed text-fg/80">
              {item.detail}
            </pre>
          </div>
        ) : null}
        {item.output ? (
          <div className="group/item">
            <div className="mb-0.5 flex min-h-5 items-center gap-1 text-2xs text-muted">
              <span className="flex-1">{t('agent.toolOutput')}</span>
              <CopyButton
                text={item.output}
                label={t('agent.copy.toolOutput')}
                tip={t('agent.copy.toolOutput')}
                iconOnly
                className={itemControlClass}
              />
            </div>
            <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-bg px-2 py-1 font-mono text-[11px] leading-relaxed text-fg/80">
              {item.output}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  )
}

type AssistantEntry =
  | { kind: 'item'; item: AgentItem }
  | { kind: 'tools'; key: string; items: AgentItem[] }

/** Consecutive tool items form one component-local group; every other item cuts the run. */
function groupAssistantItems(items: AgentItem[]): AssistantEntry[] {
  const entries: AssistantEntry[] = []
  let tools: AgentItem[] = []
  const flush = () => {
    if (tools.length === 0) return
    entries.push({ kind: 'tools', key: tools[0].id, items: tools })
    tools = []
  }
  for (const item of items) {
    if (item.type === 'tool') {
      tools.push(item)
    } else {
      flush()
      entries.push({ kind: 'item', item })
    }
  }
  flush()
  return entries
}

function ToolGroup({ items }: { items: AgentItem[] }) {
  const t = useT()
  const anyRunning = items.some((item) => item.status === 'running')
  const status = items.some((item) => item.status === 'error')
    ? 'error'
    : anyRunning
      ? 'running'
      : 'ok'
  const statusLabel =
    status === 'error'
      ? t('agent.toolGroup.status.error')
      : status === 'running'
        ? t('agent.toolGroup.status.running')
        : t('agent.toolGroup.status.ok')
  const [open, setOpen] = useState(anyRunning)
  const manual = useRef(false)
  const wasRunning = useRef(anyRunning)

  useEffect(() => {
    const previous = wasRunning.current
    wasRunning.current = anyRunning
    if (manual.current) return
    if (anyRunning) setOpen(true)
    else if (previous) setOpen(false)
  }, [anyRunning])

  return (
    <div className="overflow-hidden rounded-[var(--r-popup)] border border-line-soft bg-panel-alt/40">
      <button
        type="button"
        aria-expanded={open}
        data-tip={open ? t('agent.toolGroup.collapse') : t('agent.toolGroup.expand')}
        onClick={() => {
          manual.current = true
          setOpen((value) => !value)
        }}
        className="flex h-8 w-full items-center gap-2 px-2.5 text-left text-xs text-fg/80 hover:bg-hover"
      >
        <ToolStatus status={status} />
        <span className="min-w-0 flex-1 truncate font-medium">
          {t('agent.toolGroup.count', { count: items.length })}
        </span>
        <span className="shrink-0 text-2xs text-muted">{statusLabel}</span>
        <Icon
          name={open ? 'chevron-down' : 'chevron-right'}
          size={11}
          className="shrink-0 text-muted"
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-1 border-t border-line-soft bg-bg/30 p-1">
          {items.map((item) => (
            <ToolCard key={item.id} item={item} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

function QuestionCard({
  chatId,
  item,
  running,
  pendingQuestionId,
}: {
  chatId: string
  item: AgentItem
  running: boolean
  pendingQuestionId: string | null
}) {
  const t = useT()
  const multi = item.multiSelect === true
  const answered = Boolean(item.answer?.trim())
  const [selected, setSelected] = useState<string[]>([])
  const [custom, setCustom] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitted = useRef(false)
  const active = pendingQuestionId === item.id
  const locked = running || answered || submitting || (!answered && !active)
  const answerParts = multi
    ? [...selected, custom.trim()].filter(Boolean)
    : [custom.trim() || selected[0]].filter(Boolean)
  const canSubmit = !locked && answerParts.length > 0

  const toggleOption = (label: string) => {
    if (locked) return
    if (multi) {
      setSelected((current) =>
        current.includes(label)
          ? current.filter((value) => value !== label)
          : [...current, label],
      )
      return
    }
    setCustom('')
    setSelected((current) => (current[0] === label ? [] : [label]))
  }

  const submit = () => {
    if (!canSubmit || submitted.current) return
    submitted.current = true
    setSubmitting(true)
    const accepted = useAgent.getState().answerQuestion(chatId, item.id, answerParts.join('\n'))
    if (!accepted) {
      submitted.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="group/item overflow-hidden rounded-[var(--r-popup)] border border-accent/30 bg-panel">
      <div className="flex items-start gap-2 border-b border-line-soft bg-accent/5 px-3 py-2">
        <Icon name="info" size={12} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-xs font-medium text-fg/90">{item.header}</div>
          <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/85">
            {item.question}
          </div>
        </div>
        <span className="shrink-0 rounded-[var(--r-row)] border border-line-soft bg-panel px-1.5 py-0.5 text-2xs text-muted">
          {multi ? t('agent.question.multi') : t('agent.question.single')}
        </span>
      </div>

      {answered ? (
        <div className="flex flex-col gap-1 px-3 py-2">
          <div className="text-2xs text-muted">{t('agent.question.answered')}</div>
          <div className="whitespace-pre-wrap break-words rounded-[var(--r-row)] border border-line-soft bg-panel-alt px-2 py-1.5 text-sm leading-relaxed text-fg/90">
            {item.answer}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2 px-3 py-2">
          <div
            role={multi ? 'group' : 'radiogroup'}
            aria-label={multi ? t('agent.question.multi') : t('agent.question.single')}
            className="flex flex-col gap-1"
          >
            {(item.options ?? []).map((option) => {
              const checked = selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  role={multi ? 'checkbox' : 'radio'}
                  aria-checked={checked}
                  disabled={locked}
                  onClick={() => toggleOption(option.label)}
                  className={`flex items-start gap-2 rounded-[var(--r-row)] border px-2 py-1.5 text-left transition-colors duration-fast disabled:cursor-not-allowed disabled:opacity-60 ${
                    checked
                      ? 'border-accent/50 bg-accent/10'
                      : 'border-line-soft bg-panel-alt/50 hover:bg-hover'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center border ${
                      multi ? 'rounded-[3px]' : 'rounded-full'
                    } ${checked ? 'border-accent bg-accent text-accent-fg' : 'border-line'}`}
                  >
                    {checked ? <Icon name="check" size={9} /> : null}
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="break-words text-xs font-medium text-fg/90">{option.label}</span>
                    <span className="break-words text-2xs leading-relaxed text-muted">
                      {option.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-2xs text-muted">{t('agent.question.custom')}</span>
            <input
              type="text"
              value={custom}
              disabled={locked}
              placeholder={t('agent.question.customPlaceholder')}
              onChange={(event) => {
                const value = event.target.value
                setCustom(value)
                if (!multi && value.trim()) setSelected([])
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
                event.preventDefault()
                submit()
              }}
              className="h-8 rounded-[var(--r-row)] border border-line-soft bg-bg px-2 text-xs text-fg outline-none placeholder:text-muted/60 focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="flex items-center gap-2">
            {!canSubmit ? (
              <span className="min-w-0 flex-1 text-2xs text-muted">{t('agent.question.required')}</span>
            ) : (
              <span className="flex-1" />
            )}
            <button
              type="button"
              disabled={!canSubmit}
              onClick={submit}
              className="flex h-7 shrink-0 items-center gap-1 rounded-[var(--r-control)] bg-accent px-2.5 text-xs text-accent-fg transition-opacity duration-fast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
            >
              <Icon name="send" size={12} />
              {t('agent.question.submit')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function Item({
  chatId,
  item,
  running,
  pendingQuestionId,
}: {
  chatId: string
  item: AgentItem
  running: boolean
  pendingQuestionId: string | null
}) {
  const t = useT()
  switch (item.type) {
    case 'text':
      return (
        <div className="group/item relative pr-6">
          <div className="absolute right-0 top-0 z-10">
            <CopyButton
              text={item.text}
              label={t('agent.copy.text')}
              tip={t('agent.copy.text')}
              iconOnly
              className={itemControlClass}
            />
          </div>
          <AgentMarkdown text={item.text} />
        </div>
      )
    case 'thinking':
      return (
        <details className="group/item text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-fg/80">
            <Icon name="info" size={11} />
            <span className="flex-1">{t('agent.thinking')}</span>
            <CopyButton
              text={item.text}
              label={t('agent.copy.reasoning')}
              tip={t('agent.copy.reasoning')}
              iconOnly
              className={itemControlClass}
            />
          </summary>
          <div className="mt-1 whitespace-pre-wrap break-words border-l-2 border-line pl-2 text-[12px] leading-relaxed">
            {item.text}
          </div>
        </details>
      )
    case 'tool':
      return <ToolCard item={item} />
    case 'question':
      return (
        <QuestionCard
          chatId={chatId}
          item={item}
          running={running}
          pendingQuestionId={pendingQuestionId}
        />
      )
    case 'error':
      return (
        <div className="group/item flex items-start gap-2 rounded-[var(--r-popup)] border border-danger/30 bg-danger/10 px-2.5 py-2 text-xs text-danger">
          <Icon name="alert-circle" size={13} className="mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.text}</div>
          <CopyButton
            text={item.text}
            label={t('agent.copy.error')}
            tip={t('agent.copy.error')}
            iconOnly
            className={itemControlClass}
          />
        </div>
      )
    case 'log':
      return (
        <details className="group/item text-xs text-muted">
          <summary className="flex cursor-pointer list-none items-center gap-1 hover:text-fg/80">
            <Icon name="terminal" size={11} />
            <span className="flex-1">{t('agent.logs')}</span>
            <CopyButton
              text={item.text}
              label={t('agent.copy.logs')}
              tip={t('agent.copy.logs')}
              iconOnly
              className={itemControlClass}
            />
          </summary>
          <pre className="mt-1 max-h-[220px] overflow-auto whitespace-pre-wrap break-words rounded-[3px] bg-panel px-2 py-1 font-mono text-[11px] leading-relaxed">
            {item.text}
          </pre>
        </details>
      )
    case 'notice':
      return (
        <div className="group/item flex min-h-[22px] items-center gap-1.5 text-xs text-muted">
          <Icon name="info" size={11} className="shrink-0" />
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{item.text}</span>
          <CopyButton
            text={item.text}
            label={t('agent.copy.notice')}
            tip={t('agent.copy.notice')}
            iconOnly
            className={itemControlClass}
          />
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
  const copyValue = serializeUserMessage(message)
  return (
    <div className="group/reply group/item flex max-w-[85%] flex-col gap-1.5 self-end rounded-[var(--r-popup)] border border-line-soft bg-panel px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {message.command || (message.skills && message.skills.length > 0) ? (
            <div className="flex flex-wrap gap-1">
              {message.command ? <CommandChip id={message.command} /> : null}
              {(message.skills ?? []).map((skill) => (
                <SkillChip key={skill.path} skill={skill} />
              ))}
            </div>
          ) : null}
          {message.mentions && message.mentions.length > 0 ? (
            <MentionRow root={root} mentions={message.mentions} />
          ) : null}
          {message.text ? (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/90">
              {message.text}
            </div>
          ) : null}
        </div>
        <CopyButton
          text={copyValue}
          label={t('agent.copy.userTurn')}
          tip={t('agent.copy.userTurn')}
          iconOnly
          className={itemControlClass}
        />
      </div>
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  chatId,
  message,
  running,
  pendingQuestionId,
}: {
  chatId: string
  message: Message
  running: boolean
  pendingQuestionId: string | null
}) {
  const t = useT()
  const items = message.items ?? []
  const entries = useMemo(() => groupAssistantItems(items), [items])
  const copyValue = serializeAssistantMessage(message)
  return (
    <div className="group/reply group/item flex gap-2">
      {/* 22px box = one 22px reply line: the avatar centre and the first line centre coincide */}
      <div className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-[5px] bg-accent/15 text-accent">
        <Icon name="agent" size={13} />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-2 pr-5">
        <div className="absolute right-0 top-0 z-10">
          <CopyButton
            text={copyValue}
            label={t('agent.copy.assistantReply')}
            tip={t('agent.copy.assistantReply')}
            iconOnly
            className={itemControlClass}
          />
        </div>
        {items.length === 0 && running ? (
          <div className="flex min-h-[22px] items-center gap-1.5 text-xs text-muted">
            <Icon name="spinner" size={12} className="animate-spin" />
            {t('agent.working')}
          </div>
        ) : null}
        {entries.map((entry) =>
          entry.kind === 'tools' ? (
            <ToolGroup key={entry.key} items={entry.items} />
          ) : (
            <Item
              key={entry.item.id}
              chatId={chatId}
              item={entry.item}
              running={running}
              pendingQuestionId={pendingQuestionId}
            />
          ),
        )}
      </div>
    </div>
  )
})
