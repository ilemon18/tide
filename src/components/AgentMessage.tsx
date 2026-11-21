import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { AgentItem, AgentMessage as Message } from '../store/agent'
import type { AgentMention, AgentPlanAction } from '../lib/ipc'
import { useTabs } from '../store/tabs'
import { useAgent } from '../store/agent'
import { revealInExplorer } from '../lib/actions'
import { basename } from '../lib/paths'
import { useT } from '../i18n'
import { AgentStreamText } from './AgentStreamText'
import { AgentTurnStatus } from './AgentTurnStatus'
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
          <span className="min-w-0 whitespace-pre-wrap break-all font-mono text-[11px]">{mention.rel}</span>
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
      if (item.output && !message.items?.some(part => part.type === 'tool-output' && part.toolId === item.id)) parts.push(item.output)
    } else if (item.type === 'permission') {
      parts.push([item.title, item.detail, item.text, item.permissionState].filter(Boolean).join('\n'))
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
    return <Icon name="spinner" size={12} className="agent-spinner shrink-0 text-accent" />
  }
  if (status === 'error') {
    return <Icon name="alert-circle" size={12} className="shrink-0 text-danger" />
  }
  return <Icon name="check" size={12} className="shrink-0 text-success" />
}

const itemControlClass =
  'h-[22px] w-[22px] pointer-events-none group-hover/item:pointer-events-auto group-focus-within/item:pointer-events-auto opacity-0 transition-opacity duration-fast group-hover/item:opacity-100 group-focus-within/item:opacity-100'

const replyControlClass =
  'h-[22px] w-[22px] pointer-events-none group-hover/reply:pointer-events-auto group-focus-within/reply:pointer-events-auto opacity-0 transition-opacity duration-fast group-hover/reply:opacity-100 group-focus-within/reply:opacity-100'

const userControlClass =
  'h-[22px] w-[22px] pointer-events-none group-hover/user:pointer-events-auto group-focus-within/user:pointer-events-auto opacity-0 transition-opacity duration-fast group-hover/user:opacity-100 group-focus-within/user:opacity-100'

/** Prefer the executable command/path over the provider's generic tool name or JSON input. */
export function toolCommand(item: AgentItem): string {
  if (item.detail) {
    try {
      const input = JSON.parse(item.detail) as Record<string, unknown>
      for (const key of ['command', 'file_path', 'path', 'filePath', 'query']) {
        if (typeof input[key] === 'string') return input[key]
      }
    } catch { if (!item.detail.trimStart().startsWith('{')) return item.detail }
  }
  return item.title ?? ''
}

export function toolPreview(text: string, lines: number): { text: string; clipped: boolean } {
  const all = text.split('\n')
  const chars = Array.from(all.slice(0, lines).join('\n'))
  const clipped = all.length > lines || chars.length > lines * 180
  return { text: chars.slice(0, lines * 180).join('') + (clipped ? '\n…' : ''), clipped }
}

function ToolCard({ item, separateOutput = false }: { item: AgentItem; separateOutput?: boolean }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const commandRef = useRef<HTMLPreElement>(null)
  const outputRef = useRef<HTMLPreElement>(null)
  const [wrapped, setWrapped] = useState({ input: false, output: false })
  useLayoutEffect(() => {
    if (expanded) return
    const measure = () => setWrapped({
      input: Boolean(commandRef.current && commandRef.current.scrollHeight > commandRef.current.clientHeight + 1),
      output: Boolean(outputRef.current && outputRef.current.scrollHeight > outputRef.current.clientHeight + 1),
    })
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (commandRef.current) observer.observe(commandRef.current)
    if (outputRef.current) observer.observe(outputRef.current)
    return () => observer.disconnect()
  }, [item.detail, item.title, item.output, expanded])
  const command = toolCommand(item) || t('agent.tool')
  const input = toolPreview(command, 2)
  const output = toolPreview(separateOutput ? '' : item.output ?? '', 3)
  const canExpand = input.clipped || output.clipped || wrapped.input || wrapped.output || Boolean(item.detail && item.detail !== command)
  return <div className="group/item min-w-0 border-l border-line pl-2.5 text-xs">
    <div className="flex items-start gap-2">
      <ToolStatus status={item.status} />
      <pre ref={commandRef} className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px] text-fg/85"
        style={expanded ? undefined : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{expanded ? command : input.text.replace(/\n…$/, '')}</pre>
      <CopyButton text={[command, item.detail, item.output].filter(Boolean).join('\n\n')}
        label={t('agent.copy.toolInput')} tip={t('agent.copy.toolInput')} iconOnly className={itemControlClass} />
    </div>
    {!expanded && (input.clipped || wrapped.input) ? <div className="text-muted">…</div> : null}
    {expanded && item.detail && item.detail !== command ? <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{item.detail}</pre> : null}
    {!separateOutput && item.output ? <pre ref={outputRef} className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-muted"
      style={expanded ? undefined : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{expanded ? item.output : output.text.replace(/\n…$/, '')}</pre> : null}
    {!expanded && (output.clipped || wrapped.output) ? <div className="text-muted">…</div> : null}
    {canExpand ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="mt-1 cursor-pointer rounded-[var(--r-row)] px-1 text-2xs text-accent transition-colors duration-fast hover:bg-hover hover:text-fg">{t(expanded ? 'agent.output.collapse' : 'agent.output.expand')}</button> : null}
  </div>
}

function ToolOutputCard({ item, fullOutput }: { item: AgentItem; fullOutput?: string }) {
  const t = useT()
  const [expanded, setExpanded] = useState(false)
  const ref = useRef<HTMLPreElement>(null)
  const [wrapped, setWrapped] = useState(false)
  const preview = toolPreview(item.text, 3)
  useLayoutEffect(() => {
    if (expanded) return
    const measure = () => setWrapped(Boolean(ref.current && ref.current.scrollHeight > ref.current.clientHeight + 1))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [item.text, expanded])
  if (!item.text) return null
  return <div className="group/item min-w-0 border-l border-line pl-2.5 text-xs text-muted">
    <div className="flex items-start gap-2">
      <pre ref={ref} className="min-w-0 flex-1 whitespace-pre-wrap break-words font-mono text-[11px]"
        style={expanded ? undefined : { display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{expanded ? item.text : preview.text.replace(/\n…$/, '')}</pre>
      <CopyButton text={fullOutput ?? item.text} label={t('agent.copy.toolOutput')} tip={t('agent.copy.toolOutput')} iconOnly className={itemControlClass} />
    </div>
    {!expanded && (preview.clipped || wrapped) ? <div>…</div> : null}
    {preview.clipped || wrapped ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}
      className="mt-1 cursor-pointer rounded-[var(--r-row)] px-1 text-2xs text-accent transition-colors duration-fast hover:bg-hover hover:text-fg">{t(expanded ? 'agent.output.collapse' : 'agent.output.expand')}</button> : null}
  </div>
}

function PermissionCard({ chatId, item, running }: { chatId: string; item: AgentItem; running: boolean }) {
  const t = useT()
  const pending = running && item.permissionState === 'pending'
  return <div className="rounded border border-line bg-panel p-2 text-xs">
    <div className="font-medium">{item.title === 'command' ? t('agent.permission.command') : item.title === 'fileChange' ? t('agent.permission.fileChange') : item.title === 'permissions' ? t('agent.local.permissions.label') : item.title}</div>
    <pre className="my-1 whitespace-pre-wrap break-words font-mono">{item.detail}</pre>
    <div className="whitespace-pre-wrap text-muted">{item.text}</div>
    {item.title === 'permissions' ? <div className="mt-1 text-muted">{t('agent.permission.turnScope')}</div> : null}
    {pending ? <div className="mt-2 flex gap-3">
      <button onClick={() => void useAgent.getState().respondPermission(chatId, item.requestId!, true)} className="text-accent">{t('agent.permission.allow')}</button>
      <button onClick={() => void useAgent.getState().respondPermission(chatId, item.requestId!, false)}>{t('agent.permission.deny')}</button>
    </div> : <div className="mt-1 text-muted">{t(`agent.permission.${item.permissionState === 'submitting' ? 'waiting' : item.permissionState === 'allowed' ? 'allowed' : item.permissionState === 'denied' ? 'denied' : 'expired'}`)}</div>}
  </div>
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
  const locked = answered || submitting || !active
  const answerParts = multi
    ? [...selected, custom.trim()].filter(Boolean)
    : [custom.trim() || selected[0]].filter(Boolean)
  const canSubmit = !running && !locked && answerParts.length > 0

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

  const submit = async () => {
    if (!canSubmit || submitted.current) return
    submitted.current = true
    setSubmitting(true)
    try {
      await useAgent.getState().answerQuestion(chatId, item.id, answerParts.join('\n'))
    } catch {
      // The store reports launch errors; keep the card retryable on any rejected submission.
    } finally {
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
        {multi ? (
          <span className="shrink-0 text-2xs text-muted">{t('agent.question.multi')}</span>
        ) : null}
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
            <span className="sr-only">{t('agent.question.custom')}</span>
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
                void submit()
              }}
              className="h-8 rounded-[var(--r-row)] border border-line-soft bg-bg px-2 text-xs text-fg outline-none placeholder:text-muted/60 focus:border-accent/60 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </label>

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void submit()}
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

function PlanCard({
  chatId,
  root,
  item,
  running,
}: {
  chatId: string
  root: string
  item: AgentItem
  running: boolean
}) {
  const t = useT()
  const resolved = item.resolved === true
  const [instructions, setInstructions] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submitted = useRef(false)
  const locked = running || resolved || submitting

  const handleAction = async (action: AgentPlanAction) => {
    if (locked || submitted.current) return
    submitted.current = true
    setSubmitting(true)
    try {
      await useAgent.getState().resolvePlanAction(chatId, item.id, action, instructions)
    } finally {
      submitted.current = false
      setSubmitting(false)
    }
  }

  return (
    <div className="group/item overflow-hidden rounded-[var(--r-popup)] border border-accent/30 bg-panel">
      <div className="flex items-start gap-2 border-b border-line-soft bg-accent/5 px-3 py-2">
        <Icon name="structure" size={12} className="mt-0.5 shrink-0 text-accent" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="text-xs font-medium text-fg/90">{t('agent.plan.header')}</div>
          {item.text ? (
            <div className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg/85">
              <AgentStreamText root={root} text={item.text} live={running && !item.complete} />
            </div>
          ) : null}
        </div>
      </div>

      {!resolved ? (
        <div className="flex flex-col gap-2 p-3">
          {/* Codex plan_implementation.rs: keep official option copy/order; action IDs stay persisted. */}
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={locked}
              onClick={() => handleAction('implement-current')}
              className="flex items-start gap-2 rounded-[var(--r-row)] border border-line-soft bg-bg px-3 py-2 text-left transition-colors duration-fast hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 text-xs font-medium text-fg">{t('agent.plan.implementCurrent')}</span>
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => handleAction('implement-fresh')}
              className="flex items-start gap-2 rounded-[var(--r-row)] border border-line-soft bg-bg px-3 py-2 text-left transition-colors duration-fast hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 text-xs font-medium text-fg">{t('agent.plan.implementFresh')}</span>
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => handleAction('continue-planning')}
              className="flex items-start gap-2 rounded-[var(--r-row)] border border-line-soft bg-bg px-3 py-2 text-left transition-colors duration-fast hover:border-accent/40 hover:bg-accent/5 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <span className="min-w-0 flex-1 text-xs font-medium text-fg">{t('agent.plan.continuePlanning')}</span>
            </button>
          </div>
          <textarea
            value={instructions}
            onChange={event => setInstructions(event.target.value)}
            disabled={locked}
            aria-label={t('agent.plan.instructions')}
            placeholder={t('agent.plan.instructions')}
            rows={2}
            className="w-full resize-y rounded-[var(--r-row)] border border-line-soft bg-bg px-2 py-1.5 text-xs text-fg outline-none placeholder:text-muted/60 focus:border-accent/60 disabled:opacity-60"
          />
        </div>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-success">
          <Icon name="check" size={12} className="shrink-0" />
          {t('agent.plan.resolved')}
        </div>
      )}
    </div>
  )
}

function Item({
  chatId,
  root,
  item,
  running,
  pendingQuestionId,
  items,
}: {
  chatId: string
  root: string
  item: AgentItem
  running: boolean
  pendingQuestionId: string | null
  items: AgentItem[]
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
          <AgentStreamText root={root} text={item.text} live={running && !item.complete} />
        </div>
      )
    case 'thinking':
      return <div className="group/item border-l-2 border-line pl-2 text-xs text-muted">
        <AgentStreamText root={root} text={item.text} live={running && !item.complete} />
      </div>
    case 'permission':
      return <PermissionCard chatId={chatId} item={item} running={running} />
    case 'tool':
      return <ToolCard item={item} separateOutput={items.some(part => part.type === 'tool-output' && part.toolId === item.id)} />
    case 'tool-output':
      return <ToolOutputCard item={item} fullOutput={items.find(part => part.id === item.toolId)?.output} />
    case 'question':
      return (
        <QuestionCard
          chatId={chatId}
          item={item}
          running={running}
          pendingQuestionId={pendingQuestionId}
        />
      )
    case 'plan':
      return (
        <PlanCard
          root={root}
          chatId={chatId}
          item={item}
          running={running}
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
    <div className="group/user relative ml-auto flex w-fit min-w-0 max-w-[85%] flex-col gap-1.5 text-left rounded-[var(--r-popup)] border border-line-soft bg-panel px-3 py-2">
      <div className="min-w-0">
        <div className="flex min-w-0 flex-col gap-1.5">
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
          className={`${userControlClass} absolute right-1 top-1 bg-panel shadow-sm`}
        />
      </div>
    </div>
  )
})

export const AssistantMessage = memo(function AssistantMessage({
  chatId,
  root = '',
  message,
  running,
  pendingQuestionId,
}: {
  chatId: string
  root?: string
  message: Message
  running: boolean
  pendingQuestionId: string | null
}) {
  const t = useT()
  const items = message.items ?? []
  const startedAt = useAgent(state => state.running[chatId])
  const copyValue = serializeAssistantMessage(message)
  const waiting = items.some(item => item.type === 'permission' &&
    (item.permissionState === 'pending' || item.permissionState === 'submitting'))
  return (
    <div className="group/reply flex gap-2">
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
            className={replyControlClass}
          />
        </div>
        {items.map(item => <Item root={root} key={item.id} chatId={chatId} item={item}
          running={running} pendingQuestionId={pendingQuestionId} items={items} />)}
        <AgentTurnStatus
          completion={message.completion}
          durationMs={message.durationMs}
          completedAt={message.completedAt}
          waiting={waiting}
          running={running}
          startedAt={startedAt}
        />
      </div>
    </div>
  )
})
