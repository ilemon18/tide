import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentMention } from '../lib/ipc'
import type { AgentCommandId, AgentPromptCommandId, AgentSkillRef, ComposerTrigger } from '../lib/agentCommand'
import {
  isAgentPromptCommandId,
  matchCommands,
  normalizeAgentDraft,
  rankSkills,
  triggerAt,
} from '../lib/agentCommand'
import { basename, modKey } from '../lib/paths'
import { fuzzyMatch } from '../lib/fuzzy'
import { useFileIndex } from '../store/fileIndex'
import { useAgent } from '../store/agent'
import {
  AGENT_COMPOSER_MAX_HEIGHT,
  AGENT_COMPOSER_MIN_HEIGHT,
  useSettings,
} from '../store/settings'
import { useT } from '../i18n'
import { FileIcon } from './FileIcon'
import { Icon } from './Icon'
import { Splitter } from './Splitter'
import { AgentPicker, EffortPicker, ModelPicker } from './AgentPickers'
import { COMMAND_DESCRIPTIONS, CommandChip, SkillChip, commandLabel } from './AgentTags'

type Props = {
  root: string
  contextUsage?: ReactNode
  draft: string
  mentions: AgentMention[]
  command?: AgentPromptCommandId
  skills: AgentSkillRef[]
  provider: string
  model: string
  effort: string
  running: boolean
  disabled?: boolean
  /** An unanswered structured question owns the next turn */
  pendingQuestion?: boolean
  /** The current agent is missing: keep the agent picker usable so the user can switch */
  blocked?: boolean
  /** Bumped when the panel opens or the active chat changes: the textarea takes focus */
  autoFocusKey?: number | string
  /** Chats keep the agent that started them: hide the picker there */
  showAgentPicker?: boolean
  onDraft: (text: string) => void
  onMentions: (mentions: AgentMention[]) => void
  onCommand: (command: AgentPromptCommandId | undefined) => void
  onSkills: (skills: AgentSkillRef[]) => void
  onProvider: (id: string) => void
  onModel: (id: string) => void
  onEffort: (id: string) => void
  onSend: () => void
  onStop: () => void
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

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

function composerMaxHeight() {
  return Math.max(
    AGENT_COMPOSER_MIN_HEIGHT,
    Math.round(Math.min(AGENT_COMPOSER_MAX_HEIGHT, window.innerHeight * 0.5)),
  )
}

/**
 * A chat tab input: command / skill / mention chips, `@` / `/` / `$` pickers,
 * agent/model/complexity picks and one send/stop slot.
 */
export function AgentComposer({
  root,
  contextUsage,
  draft,
  mentions,
  command,
  skills,
  provider,
  model,
  effort,
  running,
  disabled,
  pendingQuestion,
  blocked,
  autoFocusKey,
  showAgentPicker = true,
  onDraft,
  onMentions,
  onCommand,
  onSkills,
  onProvider,
  onModel,
  onEffort,
  onSend,
  onStop,
}: Props) {
  const t = useT()
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerDragHeight = useRef<number | null>(null)
  const [trigger, setTrigger] = useState<ComposerTrigger | null>(null)
  const [highlight, setHighlight] = useState(0)
  const agentComposerHeight = useSettings((s) => s.agentComposerHeight)
  const [maxComposerHeight, setMaxComposerHeight] = useState(composerMaxHeight)
  const index = useFileIndex((s) => (root ? s.byRoot[root] : undefined))
  const skillCatalog = useAgent((s) => (root ? s.skillsByRoot[root] : undefined))
  const skillsLoading = useAgent((s) => (root ? s.skillsLoading[root] : false))

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

  // Display-only clamp: a height saved in a larger window is restored when the window grows again.
  useEffect(() => {
    const updateMaxHeight = () => setMaxComposerHeight(composerMaxHeight())
    updateMaxHeight()
    window.addEventListener('resize', updateMaxHeight)
    return () => window.removeEventListener('resize', updateMaxHeight)
  }, [])

  const effectiveComposerHeight = Math.min(agentComposerHeight, maxComposerHeight)

  // The persisted height is the minimum; content grows the textarea until it scrolls at the window cap.
  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${clamp(el.scrollHeight, effectiveComposerHeight, maxComposerHeight)}px`
  }, [draft, effectiveComposerHeight, maxComposerHeight])

  // Skills are scanned lazily: most chats never open the `$` picker
  useEffect(() => {
    if (trigger?.kind === 'skill' && root) void useAgent.getState().loadSkills(root)
  }, [trigger?.kind, root])

  const mentionHits = useMemo(() => {
    if (!trigger || trigger.kind !== 'mention' || !index) return []
    const seen = new Set<string>()
    const out: { path: string; name: string }[] = []
    for (const path of index.files) {
      if (!fuzzyMatch(trigger.text, { path, name: basename(path) })) continue
      if (seen.has(path)) continue
      seen.add(path)
      out.push({ path, name: basename(path) })
      if (out.length >= 8) break
    }
    return out
  }, [trigger, index])

  const commandHits = useMemo(
    () => (trigger?.kind === 'command' ? matchCommands(trigger.text) : []),
    [trigger],
  )

  const skillHits = useMemo(
    () =>
      trigger?.kind === 'skill' ? rankSkills(trigger.text, skillCatalog ?? []) : [],
    [trigger, skillCatalog],
  )

  useEffect(() => {
    setHighlight(0)
  }, [trigger?.kind, trigger?.text])

  const focusAt = (position: number) => {
    requestAnimationFrame(() => {
      const el = textareaRef.current
      if (!el) return
      el.focus()
      el.setSelectionRange(position, position)
    })
  }

  const removeToken = (token: ComposerTrigger) =>
    draft.slice(0, token.start) + draft.slice(token.end)

  const pickMention = (path: string) => {
    if (!trigger || trigger.kind !== 'mention') return
    onDraft(removeToken(trigger))
    if (!mentions.some((mention) => mention.rel === path)) {
      onMentions([...mentions, { rel: path, isDir: false }])
    }
    focusAt(trigger.start)
    setTrigger(null)
  }

  const pickCommand = (id: AgentCommandId) => {
    if (!trigger || trigger.kind !== 'command') return
    if (isAgentPromptCommandId(id)) {
      onCommand(id)
      onDraft(removeToken(trigger))
    } else {
      onCommand(undefined)
      onDraft('/' + id + ' ' + removeToken(trigger).trim())
    }
    focusAt(trigger.start)
    setTrigger(null)
  }

  const pickSkill = (skill: AgentSkillRef) => {
    if (!trigger || trigger.kind !== 'skill') return
    if (!skills.some((item) => item.path === skill.path)) {
      onSkills([...skills, { name: skill.name, path: skill.path, source: skill.source }])
    }
    onDraft(removeToken(trigger))
    focusAt(trigger.start)
    setTrigger(null)
  }

  const showPopup =
    trigger?.kind === 'mention'
      ? mentionHits.length > 0
      : trigger?.kind === 'command'
        ? commandHits.length > 0
        : trigger?.kind === 'skill'

  const popupCount =
    trigger?.kind === 'mention'
      ? mentionHits.length
      : trigger?.kind === 'command'
        ? commandHits.length
        : skillHits.length

  // `/plan` typed without committing the chip still counts as a command, not as text
  const pending = normalizeAgentDraft({ text: draft, mentions, command, skills })
  const canSend =
    (Boolean(pending.text) || (pending.skills?.length ?? 0) > 0) &&
    Boolean(root) &&
    Boolean(provider) &&
    !disabled &&
    !blocked &&
    !pendingQuestion

  const sendTip = pendingQuestion
    ? t('agent.question.pendingHint')
    : running
      ? t('agent.queue.send')
      : t('agent.send')

  const resizeComposer = (deltaY: number) => {
    // Deltas arrive per animation frame. Keep the intended drag height so an auto-grown textarea does not
    // swallow the first drag before React commits the new manual minimum.
    const current =
      composerDragHeight.current ??
      Math.round(
        textareaRef.current?.getBoundingClientRect().height ?? effectiveComposerHeight,
      )
    const next = clamp(
      Math.round(current - deltaY),
      AGENT_COMPOSER_MIN_HEIGHT,
      maxComposerHeight,
    )
    composerDragHeight.current = next
    if (next === useSettings.getState().agentComposerHeight) return
    useSettings.getState().patch({
      agentComposerHeight: next,
    })
  }

  const finishComposerResize = () => {
    composerDragHeight.current = null
    useSettings.getState().flush()
  }

  return (
    <div className="relative flex flex-col gap-1.5">
      {command || skills.length > 0 || mentions.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {command ? <CommandChip id={command} onRemove={() => onCommand(undefined)} /> : null}
          {skills.map((skill) => (
            <SkillChip
              key={skill.path}
              skill={skill}
              onRemove={() => onSkills(skills.filter((item) => item.path !== skill.path))}
            />
          ))}
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

      {showPopup && trigger ? (
        // In normal flow: an absolute list above the box is clipped by the transcript scroll area
        <div className="max-h-[260px] w-full overflow-auto rounded-[var(--r-popup)] border border-line-soft bg-panel py-1 shadow-popup">
          <div className="px-2.5 pb-1 pt-0.5 text-2xs text-muted">
            {trigger.kind === 'mention'
              ? t('agent.mentionPick')
              : trigger.kind === 'command'
                ? t('agent.command.pick')
                : t('agent.skill.pick')}
          </div>

          {trigger.kind === 'mention'
            ? mentionHits.map((hit, i) => (
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
              ))
            : null}

          {trigger.kind === 'command'
            ? commandHits.map((id, i) => (
                <button
                  key={id}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickCommand(id)
                  }}
                  className={`flex h-7 w-full items-center gap-2 px-2 text-left text-xs ${
                    i === highlight ? 'bg-row-selected text-fg' : 'text-fg/80 hover:bg-hover'
                  }`}
                >
                  <Icon name="command" size={12} className="shrink-0 text-accent" />
                  <span className="shrink-0 font-mono text-[11px]">/{id}</span>
                  <span className="min-w-0 flex-1 truncate text-2xs text-muted">
                    {commandLabel(id)}
                    {' · '}
                    {t(COMMAND_DESCRIPTIONS[id])}
                  </span>
                </button>
              ))
            : null}

          {trigger.kind === 'skill' ? (
            skillsLoading ? (
              <div className="flex items-center gap-1.5 px-2.5 py-2 text-2xs text-muted">
                <Icon name="spinner" size={11} className="animate-spin" />
                {t('agent.skill.loading')}
              </div>
            ) : skillHits.length === 0 ? (
              <div className="px-2.5 py-2 text-2xs text-muted">{t('agent.skill.empty')}</div>
            ) : (
              skillHits.map((skill, i) => (
                <button
                  key={skill.path}
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault()
                    pickSkill(skill)
                  }}
                  className={`flex w-full items-center gap-2 px-2 py-1 text-left ${
                    i === highlight ? 'bg-row-selected text-fg' : 'text-fg/80 hover:bg-hover'
                  }`}
                >
                  <Icon name="sparkle" size={12} className="shrink-0 text-accent" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-mono text-[11px] text-fg/90">{skill.name}</span>
                    <span className="truncate text-2xs text-muted">{skill.description}</span>
                  </span>
                  <span className="shrink-0 rounded-[var(--r-row)] border border-line-soft px-1 text-2xs text-muted">
                    {skill.source === 'project'
                      ? t('agent.skill.project')
                      : t('agent.skill.user')}
                  </span>
                </button>
              ))
            )
          ) : null}
        </div>
      ) : null}

      <div className="relative flex flex-col">
        <Splitter
          direction="h"
          tone="editor"
          onDrag={resizeComposer}
          onCommit={finishComposerResize}
        />
        <textarea
          ref={textareaRef}
          value={draft}
          disabled={disabled}
          spellCheck={false}
          placeholder={
            disabled
              ? ''
              : `${t('agent.composer.placeholder')} · ${t('agent.composer.sendHint', { key: modKey() })}`
          }
          onChange={(e) => {
            const value = e.target.value
            onDraft(value)
            setTrigger(triggerAt(value, e.target.selectionStart ?? value.length))
          }}
          onBlur={() => setTrigger(null)}
          onKeyDown={(e) => {
            const composing = e.nativeEvent.isComposing
            if (e.key === 'Escape' && trigger) {
              e.preventDefault()
              e.stopPropagation()
              setTrigger(null)
              return
            }
            if (
              trigger &&
              popupCount > 0 &&
              (e.key === 'ArrowDown' || e.key === 'ArrowUp')
            ) {
              e.preventDefault()
              setHighlight((current) => {
                const next = e.key === 'ArrowDown' ? current + 1 : current - 1
                return (next + popupCount) % popupCount
              })
              return
            }
            if (!composing && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              if (canSend) onSend()
              return
            }
            // A space after an exact command, or after picking a skill, commits the chip
            if (!composing && e.key === ' ' && trigger) {
              if (trigger.kind === 'command' && isAgentPromptCommandId(trigger.text)) {
                e.preventDefault()
                pickCommand(trigger.text)
                return
              }
              if (trigger.kind === 'skill' && trigger.text.length > 0 && skillHits.length > 0) {
                e.preventDefault()
                const hit = skillHits[Math.min(highlight, skillHits.length - 1)]
                if (hit) pickSkill(hit)
                return
              }
            }
            if (!composing && trigger && popupCount > 0 && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              if (trigger.kind === 'command') {
                const hit = commandHits[Math.min(highlight, commandHits.length - 1)]
                if (hit) pickCommand(hit)
              } else if (trigger.kind === 'skill') {
                const hit = skillHits[Math.min(highlight, skillHits.length - 1)]
                if (hit) pickSkill(hit)
              } else {
                const hit = mentionHits[Math.min(highlight, mentionHits.length - 1)]
                if (hit) pickMention(hit.path)
              }
              return
            }
            if (e.key === 'Backspace' && !draft) {
              if (mentions.length > 0) {
                e.preventDefault()
                onMentions(mentions.slice(0, -1))
                return
              }
              if (skills.length > 0) {
                e.preventDefault()
                onSkills(skills.slice(0, -1))
                return
              }
              if (command) {
                e.preventDefault()
                onCommand(undefined)
                return
              }
            }
          }}
          style={{ height: effectiveComposerHeight, maxHeight: maxComposerHeight }}
          className="w-full resize-none overflow-y-auto bg-transparent py-1 text-sm leading-relaxed text-fg outline-none placeholder:text-muted/60 disabled:cursor-not-allowed"
        />
      </div>

      <div className="flex min-w-0 items-center gap-0.5">
        <div className="flex min-w-0 items-center gap-0.5">
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
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1">
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
          {contextUsage}
          <button
            type="button"
            onClick={onSend}
            disabled={!canSend}
            data-tip={sendTip}
            aria-label={sendTip}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[var(--r-control)] bg-accent text-accent-fg transition-opacity duration-fast hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-35"
          >
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}
