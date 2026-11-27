import { tags as t, type Tag } from '@lezer/highlight'
import type { CSSProperties } from 'react'
import type { SyntaxColors } from './palettes'

/**
 * The single source of truth for syntax highlighting.
 *
 * The editor (HighlightStyle in `cmTheme.ts`) and the diff view (`components/diffHighlight.ts`
 * generates classes with tagHighlighter) are both built from this, so the two color sets cannot
 * drift apart.
 *
 * `cls` is also the class name in the diff view: `diffTokenStyle()` looks colors up in the palette
 * by it, so a new rule only needs a `SyntaxColors` key (or `emphasis` for glyph-only rules).
 */
export type SyntaxRule = {
  cls: string
  /** Color key; omitted means the rule only adds glyphs (italic etc.) and no color */
  color?: keyof SyntaxColors
  tags: Tag[]
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export const SYNTAX_RULES: SyntaxRule[] = [
  {
    cls: 'keyword',
    color: 'keyword',
    tags: [t.keyword, t.moduleKeyword, t.operatorKeyword],
  },
  { cls: 'keywordControl', color: 'keywordControl', tags: [t.controlKeyword] },
  { cls: 'string', color: 'string', tags: [t.string, t.special(t.string), t.regexp] },
  { cls: 'number', color: 'number', tags: [t.number] },
  { cls: 'constant', color: 'constant', tags: [t.bool, t.null, t.atom] },
  {
    cls: 'comment',
    color: 'comment',
    tags: [t.comment, t.blockComment, t.lineComment, t.docComment],
  },
  {
    cls: 'function',
    color: 'function',
    tags: [t.function(t.variableName), t.function(t.propertyName), t.macroName],
  },
  {
    cls: 'type',
    color: 'type',
    tags: [t.typeName, t.className, t.namespace, t.standard(t.typeName)],
  },
  { cls: 'variable', color: 'variable', tags: [t.variableName, t.self, t.special(t.variableName)] },
  {
    cls: 'operator',
    color: 'operator',
    tags: [t.operator, t.derefOperator, t.compareOperator, t.arithmeticOperator],
  },
  {
    cls: 'punctuation',
    color: 'punctuation',
    tags: [t.punctuation, t.bracket, t.separator, t.angleBracket],
  },
  { cls: 'tag', color: 'tag', tags: [t.tagName, t.angleBracket] },
  { cls: 'attribute', color: 'attribute', tags: [t.attributeName] },
  { cls: 'property', color: 'property', tags: [t.propertyName, t.definition(t.propertyName)] },
  { cls: 'heading', color: 'heading', tags: [t.heading, t.strong], bold: true },
  { cls: 'emphasis', tags: [t.emphasis], italic: true },
  { cls: 'link', color: 'function', tags: [t.link, t.url], underline: true },
  { cls: 'invalid', color: 'invalid', tags: [t.invalid] },
  { cls: 'meta', color: 'comment', tags: [t.meta, t.processingInstruction] },
]

/** Glyph rules merge by cls: several rules with the same cls stack (color + bold + italic + underline) */
const STYLE_BY_CLS = new Map<string, Omit<SyntaxRule, 'tags'>>()
for (const rule of SYNTAX_RULES) {
  const prev = STYLE_BY_CLS.get(rule.cls)
  STYLE_BY_CLS.set(rule.cls, {
    cls: rule.cls,
    color: rule.color ?? prev?.color,
    bold: rule.bold || prev?.bold,
    italic: rule.italic || prev?.italic,
    underline: rule.underline || prev?.underline,
  })
}

/** Inline style cache for DiffView: each cls is computed once while the palette is unchanged */
let cachedSyntax: SyntaxColors | null = null
let styleCache = new Map<string, CSSProperties | null>()

/** Turn the cls from tagHighlighter into an inline style (color + glyphs); unknown cls falls back to the default foreground */
export function diffTokenStyle(cls: string, syntax: SyntaxColors): CSSProperties | null {
  if (cachedSyntax !== syntax) {
    cachedSyntax = syntax
    styleCache = new Map()
  }
  const hit = styleCache.get(cls)
  if (hit !== undefined) return hit

  // tagHighlighter may join several hits into one string ("variable definition"); merge them one by one
  const names = cls.includes(' ') ? cls.split(' ') : [cls]
  let style: CSSProperties | null = null
  for (const name of names) {
    const rule = STYLE_BY_CLS.get(name)
    if (!rule) continue
    style = style ?? {}
    if (rule.color) style.color = syntax[rule.color]
    if (rule.bold) style.fontWeight = 600
    if (rule.italic) style.fontStyle = 'italic'
    if (rule.underline) style.textDecoration = 'underline'
  }
  styleCache.set(cls, style)
  return style
}