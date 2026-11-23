export function basename(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i === -1 ? rel : rel.slice(i + 1)
}

export function dirname(rel: string): string {
  const i = rel.lastIndexOf('/')
  return i === -1 ? '' : rel.slice(0, i)
}

export function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name
}

export function extname(rel: string): string {
  const base = basename(rel)
  const i = base.lastIndexOf('.')
  if (i <= 0) return ''
  return base.slice(i + 1).toLowerCase()
}

export function isUnder(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(prefix + '/')
}

/**
 * Absolute path → path relative to a workspace root, or null when it lives outside the project.
 * Used by "save untitled as": the native dialog returns an absolute path, the backend only accepts (root, rel).
 */
export function relFromAbsolute(root: string, absolute: string): string | null {
  const normalized = absolute.replace(/\\/g, '/').replace(/\/+$/, '')
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!base) return null
  if (normalized === base) return ''
  if (!normalized.startsWith(`${base}/`)) return null
  return normalized.slice(base.length + 1)
}

export function parentChain(rel: string): string[] {
  const parts = rel.split('/').filter(Boolean)
  const out = ['']
  let acc = ''
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p
    out.push(acc)
  }
  return out
}

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export function isMac(): boolean {
  return typeof navigator !== 'undefined' && (navigator.platform.toLowerCase().includes('mac') || navigator.userAgent.includes('Mac'))
}

/** Display text for ⌘ / Ctrl */
export function modKey(): string {
  return isMac() ? '⌘' : 'Ctrl'
}

export function formatShortcut(keys: string): string {
  return keys.replace(/Mod/g, modKey()).replace(/Shift/g, '⇧').replace(/Alt/g, isMac() ? '⌥' : 'Alt')
}