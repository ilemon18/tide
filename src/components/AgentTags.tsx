import type { MessageKey } from '../i18n'
import { t, useT } from '../i18n'
import type { AgentCommandId, AgentPromptCommandId, AgentSkillRef } from '../lib/agentCommand'
import { Icon } from './Icon'

export const COMMAND_LABELS: Record<AgentCommandId, MessageKey> = {
  plan: 'agent.command.plan.label',
  goal: 'agent.command.goal.label',
  review: 'agent.command.review.label',
  test: 'agent.command.test.label',
  explain: 'agent.command.explain.label',
  new: 'agent.local.new.label',
  resume: 'agent.local.resume.label',
  fork: 'agent.local.fork.label',
  compact: 'agent.local.compact.label',
  status: 'agent.local.status.label',
  model: 'agent.local.model.label',
  permissions: 'agent.local.permissions.label',
  help: 'agent.local.help.label',
}

export const COMMAND_DESCRIPTIONS: Record<AgentCommandId, MessageKey> = {
  plan: 'agent.command.plan.desc',
  goal: 'agent.command.goal.desc',
  review: 'agent.command.review.desc',
  test: 'agent.command.test.desc',
  explain: 'agent.command.explain.desc',
  new: 'agent.local.new.desc',
  resume: 'agent.local.resume.desc',
  fork: 'agent.local.fork.desc',
  compact: 'agent.local.compact.desc',
  status: 'agent.local.status.desc',
  model: 'agent.local.model.desc',
  permissions: 'agent.local.permissions.desc',
  help: 'agent.local.help.desc',
}

export function commandLabel(id: AgentCommandId): string {
  return t(COMMAND_LABELS[id])
}

export function CommandChip({
  id,
  onRemove,
}: {
  id: AgentPromptCommandId
  onRemove?: () => void
}) {
  const t = useT()
  return (
    <span
      data-tip={t(COMMAND_DESCRIPTIONS[id])}
      className="flex max-w-[240px] items-center gap-1 rounded-[var(--r-row)] border border-accent/30 bg-accent/10 py-0.5 pl-1 pr-0.5 text-2xs text-accent"
    >
      <Icon name="command" size={11} className="shrink-0" />
      <span className="min-w-0 truncate font-mono text-[11px]">/{id}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={t('agent.command.remove')}
          onClick={onRemove}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-accent/70 hover:bg-accent/15 hover:text-accent"
        >
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  )
}

export function SkillChip({
  skill,
  onRemove,
}: {
  skill: AgentSkillRef
  onRemove?: () => void
}) {
  const t = useT()
  return (
    <span
      data-tip={skill.path}
      className="flex max-w-[260px] items-center gap-1 rounded-[var(--r-row)] border border-line-soft bg-panel-alt py-0.5 pl-1 pr-0.5 text-2xs text-fg/80"
    >
      <Icon name="sparkle" size={11} className="shrink-0 text-accent" />
      <span className="min-w-0 truncate font-mono text-[11px]">{skill.name}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={t('agent.skill.remove')}
          onClick={onRemove}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] text-muted/70 hover:bg-hover hover:text-fg"
        >
          <Icon name="close" size={10} />
        </button>
      ) : null}
    </span>
  )
}
