/**
 * Infer the format to restore on save from the file content. CodeMirror documents always use `\n`,
 * so writing back directly would turn CRLF files into LF (a whole-file diff in git); indentation is
 * the same — without detection, a tab project would be treated as spaces.
 */

export type Eol = 'lf' | 'crlf'

/** Scan limits: how many lines / characters per line are enough to judge from the start of a large file */
const MAX_SCAN_LINES = 400
const MAX_LINE_LEN = 200
/** Max newlines counted when judging the EOL style */
const MAX_EOL_SCAN = 200

export type TextMeta = {
  eol: Eol
  /** Width of one indent level (spaces); falls back to the global setting when undetected */
  indentSize?: number
  /** Indent with tabs (Go / Makefile style) */
  useTabs?: boolean
}

/** Go with the majority of the first newlines: gives a saner answer for mixed files */
export function detectEol(text: string): Eol {
  let crlf = 0
  let lf = 0
  let index = 0
  for (let seen = 0; seen < MAX_EOL_SCAN; seen += 1) {
    const next = text.indexOf('\n', index)
    if (next < 0) break
    if (next > 0 && text.charCodeAt(next - 1) === 13) crlf += 1
    else lf += 1
    index = next + 1
  }
  return crlf > lf ? 'crlf' : 'lf'
}

function gcd(a: number, b: number): number {
  let x = a
  let y = b
  while (y) {
    const t = x % y
    x = y
    y = t
  }
  return x
}

/**
 * Indent detection: count leading whitespace on non-blank lines near the top. Mostly tabs means tabs;
 * for spaces, take the GCD of all indent widths as one level (recognizes 2/3/4).
 */
function detectIndent(text: string): { indentSize?: number; useTabs?: boolean } {
  let tabLines = 0
  let spaceLines = 0
  const widths: number[] = []

  let start = 0
  for (let line = 0; line < MAX_SCAN_LINES; line += 1) {
    const end = text.indexOf('\n', start)
    const raw = text.slice(start, end < 0 ? text.length : end)
    start = end < 0 ? text.length : end + 1

    const line_ = raw.length > MAX_LINE_LEN ? raw.slice(0, MAX_LINE_LEN) : raw
    const trimmed = line_.trimStart()
    if (!trimmed) continue
    const indent = line_.length - trimmed.length
    if (indent === 0) continue
    if (line_.charCodeAt(0) === 9) {
      tabLines += 1
      continue
    }
    if (line_.charCodeAt(0) === 32) {
      spaceLines += 1
      widths.push(indent)
    }

    if (end < 0) break
  }

  if (tabLines === 0 && widths.length === 0) return {}
  if (tabLines > spaceLines) return { useTabs: true }

  const size = widths.reduce((acc, value) => gcd(acc, value), 0)
  // Single-space indents (or absurd widths): do not judge, defer to the global setting
  if (size < 2 || size > 8) return {}
  return { indentSize: size, useTabs: false }
}

export function detectTextMeta(text: string): TextMeta {
  return { eol: detectEol(text), ...detectIndent(text) }
}
/**
 * Tidy text before saving (can be turned off in settings): strip trailing spaces / tabs, ensure a
 * final newline (except empty files). Documents use \n internally; CRLF is restored when writing.
 */
export function tidyText(
  text: string,
  options: { trim: boolean; finalNewline: boolean },
): string {
  let out = text
  if (options.trim) out = out.replace(/[ \t]+$/gm, '')
  if (options.finalNewline && out.length > 0 && !out.endsWith('\n')) out += '\n'
  return out
}
