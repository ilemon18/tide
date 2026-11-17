import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMention } from '../lib/ipc'
import { basename, modKey } from '../lib/paths'
import { fuzzyMatch } from '../lib/fuzzy'
import { useFileIndex } from '../store/fileIndex'
import { useT } from '../i18n'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'
import { AgentPicker, EffortPicker, ModelPicker } from './AgentPickers'

type Props = {
  root: string
  draft: string
  mentions: AgentMention[]
  provider: string
  model: string
  effort: string
  running: boolean
  disabled?: boolean
  /** The current agent is missing: keep the agent picker usable so the user can switch */
  blocked?: boolean
  disabledText?: string
  /** Bumped when the panel opens or the active chat changes: the textarea takes focus */
  autoFocusKey?: number | string
  /** Chats keep the agent that started them: hide the picker there */
  showAgentPicker?: boolean
  onDraft: (text: string) => void
  onMentions: (mentions: AgentMention[]) => void
  onProvider: (id: string) => void
  onModel: (id: string) => void
  onEffort: (id: string) => void
  onSend: () => void
  onStop: () => void
}

type MentionQuery = { start: number; end: number; text: string }

function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret)
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before)
  if (!match) return null
  return { start: caret - match[1].length - 1, end: caret, text: match[1] }
}

function MentionChip({
  root,
  mention,
  onRemove,
}: {
  root: string
  mention: AgentMention
  onRemove: () => void
}) {
  const t = useT()
  // The workspace root itself is mentioned as "."; show its folder name instead
  const label = mention.rel === '.' ? basename(root) : mention.rel
  return (
    <span className="flex max-w-[240px] items-center gap-1 rounded-[var(--r-row)] border border-line-soft bg-panel-alt py-0.5 pl-1 pr-0.5 text-xs">
      <FileIcon name={basename(label)} isDir={mention.isDir} size={13} />
      <span className="min-w-0 truncate font-mono text-[11px] text-fg/80">{label}</span>
      <button
        type="button"
        aria-label={t('agent.mentionRemove')}
        onClick={onRemove}
        className="flex h-4 w-4 items-center justify-center rounded-[3px] text-muted/70 hover:bg-hover hover:text-fg"
      >
        <Icon name="close" size={10} />
      </button>
    </span>
  )
}

/**
 * A chat tab input: mention chips, an `@` file picker, agent/model/complexity picks
 * and one send/stop slot.
 */
export function AgentComposer({
  root,
  draft,
  mentions,
  provider,
  model,
  effort,
  running,
  disabled,
  blocked,
  disabledText,
  autoFocusKey,
  showAgentPicker = true,
  onDraft,
  onMentions,
  onProvider,
  onModel,
  onEffort,
  onSend,
  onStop,
}: Props) {
  const t = useT()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [query, setQuery] = useState<MentionQuery | null>(null)
  const [highlight, setHighlight] = useState(0)
  const index = useFileIndex((s) => (root ? s.byRoot[root] : undefined))

  useEffect(() => {
    if (root) void useFileIndex.getState().ensure(root)
  }, [root])

  // A chat tab mounts this on switch; autoFocusKey refocuses after an explicit open
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (autoFocusKey === undefined) return
    textareaRef.current?.focus()
  }, [autoFocusKey])

  // Auto-grow up to roughly eight lines, then scroll inside the box
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 60), 168)}px`
  }, [draft])

  const hits = useMemo(() => {
    if (!query || !index) return []
    const seen = new Set<string>()
    const out: { path: string; name: string }[] = []
    for (const path of index.files) {
      if (!fuzzyMatch(query.text, { path, name: basename(path) })) continue
      if (seen.has(path)) continue
      seen.add(path)
      out.push({ path, name: basename(path) })
      if (out.length >= 8) break
    }
    return out
  }, [query, index])

  useEffect(() => {
    setHighlight(0)
  }, [query?.text])

  const pickMention = (path: string) => {
    if (!query) return
    const next = draft.slice(0, query.start) + draft.slice(query.end)
    onDraft(next)
    if (!mentions.some((mention) => mention.rel === path)) {
      onMentions([...mentions, { rel: path, isDir: false }])
    }
    setQuery(null)
    requestAnimationFrame(() => textareaRef.current?.focus())
  }

  const canSend =
    Boolean(draft.trim()) && Boolean(root) && Boolean(provider) && !disabled && !blocked

  return (
    <div className="relative flex flex-col gap-1.5">
      {mentions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {mentions.map((mention) => (
            <MentionChip
              key={mention.rel}
              root={root}
              mention={mention}
              onRemove={() => onMentions(mentions.filter((item) => item.rel !== mention.rel))}
            />
          ))}
        </div>
      ) : null}

      {query && hits.length > 0 ? (
        // In normal flow: an absolute list above the box is clipped by the transcript scroll area
        <div className="max-h-[220px] w-full overflow-auto rounded-[var(--r-popup)] border border-line-soft bg-panel py-1 shadow-popup">
          <div className="px-2.5 pb-1 pt-0.5 text-2xs text-muted">
            {t('agent.mentionPick')}
          </div>
          {hits.map((hit, i) => (
            <button
              key={hit.path}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault()
                pickMention(hit.path)
              }}
              className={`flex h-6 w-full items-center gap-1.5 px-2 text-left text-xs ${
                i === highlight ? 'bg-row-selected text-fg' : 'text-fg/80 hover:bg-hover'
              }`}
            >
              <FileIcon name={hit.name} isDir={false} size={13} />
              <span className="truncate font-mono text-[11px]">{hit.path}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          spellCheck={false}
          placeholder={
            disabled
              ? disabledText ?? t('agent.composer.disabled')
              : t('agent.composer.placeholder')
          }
          onChange={(e) => {
            const value = e.target.value
            onDraft(value)
            setQuery(mentionQueryAt(value, e.target.selectionStart ?? value.length))
          }}
          onBlur={() => setQuery(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault()
              e.stopPropagation()
              setQuery(null)
              return
            }
            if (query && hits.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault()
              setHighlight((current) => {
                const next = e.key === 'ArrowDown' ? current + 1 : current - 1
                return (next + hits.length) % hits.length
              })
              return
            }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (canSend) onSend()
              return
            }
            if (query && hits.length > 0 && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              const hit = hits[Math.min(highlight, hits.length - 1)]
              if (hit) pickMention(hit.path)
              return
            }
            if (e.key === 'Backspace' && !draft && mentions.length > 0) {
              e.preventDefault()
              onMentions(mentions.slice(0, -1))
              return
            }
          }}
          className="max-h-[168px] min-h-[60px] w-full resize-none bg-transparent py-1 text-sm leading-relaxed text-fg outline-none placeholder:text-muted/60 disabled:cursor-not-allowed"
        />
      </div>

      <div className="flex items-center gap-0.5">
        {showAgentPicker ? (
          <AgentPicker value={provider} onPick={onProvider} disabled={running || disabled} />
        ) : null}
        <ModelPicker
          provider={provider}
          value={model}
          onPick={onModel}
          disabled={running || disabled || blocked}
        />
        <EffortPicker
          provider={provider}
          model={model}
          value={effort}
          onPick={onEffort}
          disabled={running || disabled || blocked}
        />
        <div className="ml-auto flex items-center gap-1">
          <span className="hidden px-1 text-2xs text-muted/60 min-[520px]:inline">
            {t('agent.composer.sendHint', { key: modKey() })}
          </span>
          {running ? (
            <button
              type="button"
              onClick={onStop}
              data-tip={t('agent.stop')}
              aria-label={t('agent.stop')}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-control)] border border-line-soft text-muted transition-colors duration-fast hover:border-line hover:bg-hover hover:text-fg"
            >
              <Icon name="stop" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            data-tip={running ? t('agent.queue.send') : t('agent.send')}
            aria-label={running ? t('agent.queue.send') : t('agent.send')}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-control)] bg-accent text-accent-fg transition-opacity duration-fast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
