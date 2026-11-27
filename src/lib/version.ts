/** Format a semantic app version for users while accepting values from tags and manifests. */
export function formatVersion(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? ''
  if (!trimmed) return ''
  return trimmed.startsWith('v') || trimmed.startsWith('V') ? `v${trimmed.slice(1)}` : `v${trimmed}`
}

/** Semantic ordering of published app versions; build metadata does not change precedence. */
export function compareAppVersions(a: string, b: string): number {
  const split = (value: string) => {
    const [core, ...pre] = value.replace(/^[vV]/, '').split('+')[0].split('-')
    return { core: core.split('.').map(Number), pre: pre.join('-').split('.').filter(Boolean) }
  }
  const aa = split(a),
    bb = split(b)
  for (let i = 0; i < 3; i++) if (aa.core[i] !== bb.core[i]) return aa.core[i] - bb.core[i]
  if (!aa.pre.length || !bb.pre.length) return aa.pre.length ? -1 : bb.pre.length ? 1 : 0
  for (let i = 0; i < Math.max(aa.pre.length, bb.pre.length); i++) {
    const left = aa.pre[i],
      right = bb.pre[i]
    if (left === right) continue
    if (left === undefined) return -1
    if (right === undefined) return 1
    const ln = /^\d+$/.test(left),
      rn = /^\d+$/.test(right)
    if (ln && rn) return Number(left) - Number(right)
    if (ln !== rn) return ln ? -1 : 1
    return left.localeCompare(right)
  }
  return 0
}
