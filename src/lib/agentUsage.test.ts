import { describe, expect, it } from 'vitest'
import { agentContextPercent, normalizeAgentUsage } from './agentUsage'

describe('provider context usage', () => {
  it('never substitutes cumulative tokens for current context', () => {
    const usage = normalizeAgentUsage({ totalTokens: 900000, contextWindow: 100000 })
    expect(agentContextPercent(usage)).toBeUndefined()
    expect(agentContextPercent(normalizeAgentUsage({ ...usage, contextTokens: 12000 }))).toBe(12)
  })
  it('preserves zero context and rejects malformed snapshots', () => {
    expect(agentContextPercent(normalizeAgentUsage({ contextTokens: 0, contextWindow: 100 }))).toBe(0)
    expect(normalizeAgentUsage({ contextTokens: -1 })).toBeUndefined()
    expect(normalizeAgentUsage({ contextTokens: Number.NaN })).toBeUndefined()
    expect(agentContextPercent(normalizeAgentUsage({ contextTokens: 100, contextWindow: 0 }))).toBeUndefined()
  })
})
