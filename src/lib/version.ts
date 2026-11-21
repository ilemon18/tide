/** Format a semantic app version for users while accepting values from tags and manifests. */
export function formatVersion(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? `v${trimmed.slice(1)}` : `v${trimmed}`
}
