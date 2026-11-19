/** Compact elapsed duration used by agent status. Whole seconds are floored. */
export function formatAgentDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(rest).padStart(2, '0')}s`
  if (minutes > 0) return `${minutes}m ${String(rest).padStart(2, '0')}s`
  return `${rest}s`
}

export function elapsedSeconds(startedAt: number, now = Date.now()): number {
  return Math.max(0, Math.floor((now - startedAt) / 1000))
}
