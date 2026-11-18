import type { AgentMention, AgentSkillInfo, AgentSkillSource } from './ipc'

export type { AgentSkillInfo, AgentSkillSource }

/** Commands the composer understands; the tag sent to the CLI is the id itself. */
export type AgentCommandId = 'plan' | 'goal' | 'review' | 'test' | 'explain'

export const AGENT_COMMANDS: readonly AgentCommandId[] = [
  'plan',
  'goal',
  'review',
  'test',
  'explain',
]

/** A skill chip: `path` is what the prompt points the agent at. */
export type AgentSkillRef = Pick<AgentSkillInfo, 'name' | 'path' | 'source'>

export type AgentDraft = {
  text: string
  mentions: AgentMention[]
  command?: AgentCommandId
  skills?: AgentSkillRef[]
}

export function isAgentCommandId(value: unknown): value is AgentCommandId {
  return typeof value === 'string' && (AGENT_COMMANDS as readonly string[]).includes(value)
}

export function isAgentSkillSource(value: unknown): value is AgentSkillSource {
  return value === 'project' || value === 'user'
}

export function isAgentSkillRef(value: unknown): value is AgentSkillRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Partial<AgentSkillRef>
  return (
    typeof ref.name === 'string' &&
    ref.name.length > 0 &&
    typeof ref.path === 'string' &&
    ref.path.length > 0 &&
    isAgentSkillSource(ref.source)
  )
}

/** The user text with the command tag and skill pointers the CLI agent reads. */
export function buildAgentPrompt(draft: AgentDraft): string {
  const skills = draft.skills ?? []
  const body = draft.command
    ? `<${draft.command}>\n${draft.text}\n</${draft.command}>`
    : draft.text
  if (skills.length === 0) return body
  const lines = skills.map((skill) => `Use the skill "${skill.name}" (SKILL.md: ${skill.path}).`)
  return `${lines.join('\n')}\n\n${body}`
}

/**
 * A draft typed without letting the space commit the tag still works: a leading exact
 * `/command` is stripped and sent as the wrapped tag.
 */
export function normalizeAgentDraft(draft: AgentDraft): AgentDraft {
  const text = draft.text.trim()
  if (draft.command) return { ...draft, text }
  const match = /^\/([a-z][a-z-]*)(?:\s+|$)/.exec(text)
  if (!match || !isAgentCommandId(match[1])) return { ...draft, text }
  return {
    ...draft,
    text: text.slice(match[0].length).trimStart(),
    command: match[1],
  }
}

export type ComposerTrigger = {
  kind: 'mention' | 'command' | 'skill'
  /** Start of the `@` / `/` / `$` token in the value */
  start: number
  end: number
  /** Text after the trigger character, up to the caret */
  text: string
}

const MENTION_RE = /(?:^|\s)@([^\s@]*)$/
const COMMAND_RE = /(?:^|\s)\/([a-z][a-z-]*)$/
/** `$` must survive Chinese input: only a preceding word character suppresses the trigger */
const SKILL_RE = /(?:^|[^A-Za-z0-9_$])\$([^\s$]*)$/

function matchTrigger(
  before: string,
  caret: number,
  kind: ComposerTrigger['kind'],
  re: RegExp,
): ComposerTrigger | null {
  const match = re.exec(before)
  if (!match) return null
  const text = match[1]
  return { kind, start: caret - text.length - 1, end: caret, text }
}

/** The trigger closest to the caret wins when two patterns somehow overlap. */
export function triggerAt(value: string, caret: number): ComposerTrigger | null {
  const before = value.slice(0, caret)
  const skill = matchTrigger(before, caret, 'skill', SKILL_RE)
  // `$5` is a price, not a skill query
  const skillHit = skill && !/^\d/.test(skill.text) ? skill : null
  return [
    matchTrigger(before, caret, 'mention', MENTION_RE),
    matchTrigger(before, caret, 'command', COMMAND_RE),
    skillHit,
  ].reduce<ComposerTrigger | null>(
    (best, current) => (!best || (current && current.start > best.start) ? current : best),
    null,
  )
}

/** Filter the fixed command list; an empty query shows every command. */
export function matchCommands(query: string): AgentCommandId[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...AGENT_COMMANDS]
  return AGENT_COMMANDS.filter((id) => id.startsWith(q) || id.includes(q))
}

function skillScore(query: string, skill: AgentSkillInfo): number {
  const name = skill.name.toLowerCase()
  const description = skill.description.toLowerCase()
  let score = 0
  for (const term of query.split(/\s+/).filter(Boolean)) {
    if (name === term) score += 100
    else if (name.startsWith(term)) score += 80
    else if (name.includes(term)) score += 60
    else if (description.includes(term)) score += 20
    else return -1
  }
  return score - name.length * 0.01
}

/** Project skills first, then by name; a query ranks name hits above description hits. */
export function rankSkills(
  query: string,
  skills: AgentSkillInfo[],
  limit = 8,
): AgentSkillInfo[] {
  const q = query.trim().toLowerCase()
  const ordered = skills.slice().sort((a, b) => {
    if (a.source !== b.source) return a.source === 'project' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  if (!q) return ordered.slice(0, limit)
  return ordered
    .map((skill) => ({ skill, score: skillScore(q, skill) }))
    .filter((hit) => hit.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((hit) => hit.skill)
}
