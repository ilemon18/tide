import { relFromAbsolute } from './paths'

export type AgentFileLink = { rel: string; line?: number; col?: number }

/** Resolve model-produced links against the chat root; native reads still authorize/canonicalize. */
export function resolveAgentFileLink(root: string, href: string): AgentFileLink | null {
  if (!root || !href.trim()) return null
  const raw = href.trim()
  // Only file references, never URL schemes, network shares or same-document anchors.
  if (raw.startsWith('#') || raw.startsWith('//')) return null
  const fragment = /#L(\d+)(?:C(\d+))?$/.exec(raw)
  let path: string
  try { path = decodeURIComponent(raw.split(/[?#]/, 1)[0]) } catch { return null }
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.startsWith('//')) return null
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(path)
  if (scheme && !/^[A-Za-z]:[\\/]/.test(path) &&
    !(scheme[1].includes('.') && /:\d+(?::\d+)?$/.test(path))) return null
  const location = /:(\d+)(?::(\d+))?$/.exec(path)
  if (location) path = path.slice(0, location.index)
  const absolute = path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
  if (!absolute && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path)) return null
  if (absolute) {
    const relative = relFromAbsolute(root, path)
    if (relative === null) return null
    path = relative
  } else if (path.includes('\\')) return null
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!parts.length) return null
      parts.pop()
    } else parts.push(part)
  }
  if (!parts.length) return null
  const position = fragment ?? location
  if (!position) return { rel: parts.join('/') }
  const line = Number(position[1])
  const col = Number(position[2] ?? 1)
  if (!Number.isSafeInteger(line) || line < 1 || !Number.isSafeInteger(col) || col < 1) return null
  return { rel: parts.join('/'), line, col }
}
