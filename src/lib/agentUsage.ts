import type { AgentMessage } from '../store/agent'
import type { AgentUsage } from './ipc'

const TOKEN_KEYS = [
  'inputTokens',
  'cachedInputTokens',
  'cacheWriteInputTokens',
  'outputTokens',
  'reasoningOutputTokens',
  'totalTokens',
  'contextTokens',
] as const

type TokenKey = (typeof TOKEN_KEYS)[number]

/** Missing token fields mean zero; malformed present values invalidate the whole snapshot. */
function token(raw: Record<string, unknown>, key: TokenKey): number | undefined {
  if (!(key in raw) || raw[key] === undefined) return undefined
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.floor(value)
}

/** Normalize persisted or IPC usage without rejecting old transcripts that have no usage at all. */
export function normalizeAgentUsage(raw: unknown): AgentUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const value = raw as Record<string, unknown>
  const inputTokens = token(value, 'inputTokens')
  const cachedInputTokens = token(value, 'cachedInputTokens')
  const cacheWriteInputTokens = token(value, 'cacheWriteInputTokens')
  const outputTokens = token(value, 'outputTokens')
  const reasoningOutputTokens = token(value, 'reasoningOutputTokens')
  const reportedTotalTokens = token(value, 'totalTokens')
  const contextTokens = token(value, 'contextTokens')
  if (
    (contextTokens === undefined && value.contextTokens !== undefined) ||
    (inputTokens === undefined && value.inputTokens !== undefined) ||
    (cachedInputTokens === undefined && value.cachedInputTokens !== undefined) ||
    (cacheWriteInputTokens === undefined && value.cacheWriteInputTokens !== undefined) ||
    (outputTokens === undefined && value.outputTokens !== undefined) ||
    (reasoningOutputTokens === undefined && value.reasoningOutputTokens !== undefined) ||
    (reportedTotalTokens === undefined && value.totalTokens !== undefined)
  ) {
    return undefined
  }

  let costUsd: number | null = null
  if (value.costUsd !== undefined && value.costUsd !== null) {
    if (typeof value.costUsd !== 'number' || !Number.isFinite(value.costUsd) || value.costUsd < 0) {
      return undefined
    }
    costUsd = value.costUsd
  }

  const hasUsage =
    TOKEN_KEYS.some((key) => value[key] !== undefined) ||
    (value.costUsd !== undefined && value.costUsd !== null)
  if (!hasUsage) return undefined
  const input = inputTokens ?? 0
  const cachedInput = cachedInputTokens ?? 0
  const cacheWrite = cacheWriteInputTokens ?? 0
  const output = outputTokens ?? 0
  const reasoning = reasoningOutputTokens ?? 0
  const contextWindow =
    typeof value.contextWindow === 'number' &&
    Number.isInteger(value.contextWindow) &&
    value.contextWindow > 0
      ? value.contextWindow
      : undefined
  return {
    inputTokens: input,
    cachedInputTokens: cachedInput,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    totalTokens: reportedTotalTokens ?? input + cachedInput + cacheWrite + output,
    costUsd,
    contextWindow,
    contextTokens,
  }
}

/** Sum every assistant snapshot once. One unpriced turn makes the cumulative cost unavailable. */
export function cumulativeAgentUsage(messages: AgentMessage[]): AgentUsage | undefined {
  const usages = messages.flatMap((message) =>
    message.role === 'assistant' && message.usage ? [message.usage] : [],
  )
  if (usages.length === 0) return undefined
  const total = usages.reduce<AgentUsage>(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      cachedInputTokens: sum.cachedInputTokens + usage.cachedInputTokens,
      cacheWriteInputTokens: sum.cacheWriteInputTokens + usage.cacheWriteInputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      reasoningOutputTokens: sum.reasoningOutputTokens + usage.reasoningOutputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens,
      costUsd: sum.costUsd === null || usage.costUsd === null ? null : sum.costUsd + usage.costUsd,
    }),
    {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      costUsd: 0,
    },
  )
  return total
}

/** Usage from the latest assistant turn; never fall back to an earlier turn when it has none. */
export function latestAgentUsage(messages: AgentMessage[]): AgentUsage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'assistant') return message.usage
  }
  return undefined
}

/** Latest-turn context pressure, rounded and clamped; unavailable without a usable window. */
export function agentContextPercent(usage: AgentUsage | undefined): number | undefined {
  const window = usage?.contextWindow
  if (
    !usage ||
    usage.contextTokens === undefined ||
    !Number.isFinite(usage.contextTokens) ||
    window === undefined ||
    !Number.isInteger(window) ||
    window <= 0
  ) {
    return undefined
  }
  return Math.max(0, Math.min(100, Math.round((usage.contextTokens / window) * 100)))
}

export function formatAgentTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}m`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return String(count)
}

/** Replace this turn's contribution; streaming usage snapshots are not independent turns. */
export function replaceTurnUsage(total: AgentUsage | undefined, previous: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  const keys = ['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'reasoningOutputTokens', 'totalTokens'] as const
  const result = { ...next, contextTokens: undefined, contextWindow: undefined }
  for (const key of keys) result[key] = Math.max(0, (total?.[key] ?? 0) - (previous?.[key] ?? 0) + next[key])
  result.costUsd = next.costUsd === null || total?.costUsd === null ? null : Math.max(0, (total?.costUsd ?? 0) - (previous?.costUsd ?? 0) + next.costUsd)
  return result
}
