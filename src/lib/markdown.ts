import { dirname, extname } from './paths'

/** Markdown source files that can open the live preview. Extensions are case-insensitive. */
export function isMarkdownPath(rel: string): boolean {
  const ext = extname(rel)
  return ext === 'md' || ext === 'markdown'
}

/**
 * Resolve an image reference from a Markdown document to a workspace-relative path.
 *
 * This is a fast lexical rejection before the backend's canonical authorization check. It deliberately
 * accepts only relative workspace paths: remote/data/file URLs, root-relative paths, Windows drives and
 * any path that climbs above the workspace are rejected here.
 */
export function resolveMarkdownImage(docRel: string, src: string): string | null {
  const trimmed = src.trim()
  if (!trimmed || trimmed.includes('\\')) return null
  // URL query / fragment are not part of the file path. Strip them before decoding so an encoded
  // question mark can still be a legal filename.
  const withoutQuery = trimmed.split(/[?#]/, 1)[0]
  if (!withoutQuery) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(withoutQuery)
  } catch {
    return null
  }
  if (!decoded || decoded.startsWith('/') || decoded.includes('\\') || decoded.startsWith('//')) {
    return null
  }
  // Includes data:, https:, file:, mailto:, and Windows drive paths such as C:/...
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded)) return null

  const baseParts = dirname(docRel).split('/').filter(Boolean)
  const parts = [...baseParts]
  for (const part of decoded.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.length > 0 ? parts.join('/') : null
}
