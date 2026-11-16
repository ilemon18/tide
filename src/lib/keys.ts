/**
 * Shortcut keys as a comparison string.
 *
 * `e.key` describes what the layout would type, which is not what a shortcut means: while an input method
 * is composing (Chinese / Japanese / Korean) WebKit reports `"Process"`, on a non-latin layout every letter
 * comes back as that layout's character, and shifted punctuation returns the shifted symbol (⌘⇧[ arrives as
 * "{"). All of that would make shortcuts silently stop working in the editor, right after typing Chinese.
 *
 * So: prefer the printable character from `e.key`, fall back to the physical key (`e.code`, then `keyCode`),
 * and fold shifted punctuation back to its base key. Letters come back lowercase ("f"), punctuation as
 * itself ("[", ",", "\\"), and named keys lowercase ("escape", "arrowleft").
 */

/** Shifted punctuation → base key, so ⌘⇧[ matches even when the layout types "{". */
const SHIFTED: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
}

/** Physical key → base key, for when `e.key` is unusable (composing input method, exotic layout). */
const CODE_CHAR: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
}

/** The parts of a keyboard event a shortcut needs (native or React's synthetic one). */
type KeyLike = { key: string; code?: string; keyCode?: number }

export function shortcutKey(e: KeyLike): string {
  // A single printable character is the most accurate answer when the layout is the one the user expects
  if (e.key.length === 1) return (SHIFTED[e.key] ?? e.key).toLowerCase()
  const code = e.code ?? ''
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase()
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  const byCode = CODE_CHAR[code]
  if (byCode) return byCode
  // Key events with `key: "Process"` still carry the layout-mapped keyCode; 229 flags a composition
  const legacy = e.keyCode ?? 0
  if (legacy >= 65 && legacy <= 90) return String.fromCharCode(legacy).toLowerCase()
  return e.key.toLowerCase()
}
