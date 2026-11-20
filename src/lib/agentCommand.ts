import type { AgentMention, AgentSkillInfo, AgentSkillSource } from './ipc'

export type { AgentSkillInfo, AgentSkillSource }

/** Prompt commands are wrapped into the turn and sent to the provider. */
export type AgentPromptCommandId = 'plan' | 'goal' | 'review' | 'test' | 'explain'
/** Local commands are executed by Tide and never reach the provider. */
export type AgentLocalCommandId =
  | 'new'
  | 'resume'
  | 'fork'
  | 'compact'
  | 'status'
  | 'model'
  | 'permissions'
  | 'help'
export type AgentCommandId = AgentPromptCommandId | AgentLocalCommandId

export const AGENT_PROMPT_COMMANDS: readonly AgentPromptCommandId[] = [
  'plan',
  'goal',
  'review',
  'test',
  'explain',
]
export const AGENT_LOCAL_COMMANDS: readonly AgentLocalCommandId[] = [
  'new',
  'resume',
  'fork',
  'compact',
  'status',
  'model',
  'permissions',
  'help',
]
export const AGENT_COMMANDS: readonly AgentCommandId[] = [
  ...AGENT_PROMPT_COMMANDS,
  ...AGENT_LOCAL_COMMANDS,
]

/** A skill chip: `path` is what the prompt points the agent at. */
export type AgentSkillRef = Pick<AgentSkillInfo, 'name' | 'path' | 'source'>

export type AgentDraft = {
  text: string
  mentions: AgentMention[]
  command?: AgentPromptCommandId
  skills?: AgentSkillRef[]
}

export function isAgentPromptCommandId(value: unknown): value is AgentPromptCommandId {
  return typeof value === 'string' && (AGENT_PROMPT_COMMANDS as readonly string[]).includes(value)
}

export function isAgentLocalCommandId(value: unknown): value is AgentLocalCommandId {
  return typeof value === 'string' && (AGENT_LOCAL_COMMANDS as readonly string[]).includes(value)
}

export function isAgentCommandId(value: unknown): value is AgentCommandId {
  return (
    isAgentPromptCommandId(value) ||
    isAgentLocalCommandId(value)
  )
}

/** Parse a slash command typed as the whole message. Local commands never carry arguments. */
export function parseAgentLocalCommand(value: string): {
  id: AgentLocalCommandId
  args: string
} | null {
  const match = /^\/([a-z][a-z-]*)(?:\s+([\s\S]*))?$/.exec(value.trim())
  if (!match || !isAgentLocalCommandId(match[1])) return null
  return { id: match[1], args: (match[2] ?? '').trim() }
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

const PLAN_INSTRUCTIONS = `
Planning mode:
- This turn is strictly read-only. Inspect the repository, but do not modify files or run commands with side effects.
- Ask the user only when a critical decision cannot be inferred from the repository or request. Ask at most one question per turn.
- If there is no blocking ambiguity, return a complete, decision-ready plan with the files and steps the implementation will touch.
- After a question is answered, continue from the same planning work. Ask again only if another critical decision remains; otherwise return the final plan.
`.trim()

const READ_ONLY_CONTINUATION = `
Read-only mode:
Answer the request without modifying files or running commands with side effects. Inspect the repository as needed. Do not implement changes unless the user explicitly switches to writable mode.
`.trim()

const QUESTION_PROTOCOL = `
Structured questions (only when the user must make a decision):
- Prefer discovering the answer from the repository. Do not ask about facts you can inspect.
- Ask at most one question in this turn. Never use a question marker for a status update, progress report, or confirmation that is not required.
- A question must have 2 to 4 options. Every option needs a non-empty label and a non-empty description.
- Set multiSelect to true only when several choices may be valid together. The UI also lets the user enter a custom answer.
- Emit exactly one marker as plain text, not inside a code fence, and use this shape:
<TIDE_QUESTION>{"header":"Short title","question":"The decision needed","multiSelect":false,"options":[{"label":"Option A","description":"What this choice means"},{"label":"Option B","description":"What this choice means"}]}</TIDE_QUESTION>
`.trim()

/** The user text with the command tag, skill pointers and shared prompt guidance the CLI agent reads. */
export function buildAgentPrompt(
  draft: AgentDraft,
  readOnly = draft.command === 'plan',
): string {
  const skills = draft.skills ?? []
  const body =
    draft.command === 'plan'
      ? `<plan>\n${draft.text}\n\n${PLAN_INSTRUCTIONS}\n</plan>`
      : draft.command
        ? `<${draft.command}>\n${draft.text}\n</${draft.command}>`
        : draft.text
  const planning = readOnly && draft.command !== 'plan' ? `\n\n${READ_ONLY_CONTINUATION}` : ''
  const questionProtocol = `\n\n${QUESTION_PROTOCOL}`
  const prompt = `${body}${planning}${questionProtocol}`
  const lines = skills.map((skill) => `Use the skill "${skill.name}" (SKILL.md: ${skill.path}).`)
  if (lines.length === 0) return prompt
  return `${lines.join('\n')}\n\n${prompt}`
}

/**
 * A draft typed without letting the space commit the tag still works: a leading exact
 * `/command` is stripped and sent as the wrapped tag.
 */
export function normalizeAgentDraft(draft: AgentDraft): AgentDraft {
  const text = draft.text.trim()
  if (draft.command) return { ...draft, text }
  const match = /^\/([a-z][a-z-]*)(?:\s+|$)/.exec(text)
  if (!match || !isAgentPromptCommandId(match[1])) return { ...draft, text }
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
