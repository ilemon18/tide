import { EditorState, type Extension } from '@codemirror/state'
import {
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completeAnyWord,
} from '@codemirror/autocomplete'
import {
  highlightSelectionMatches,
  search,
  selectNextOccurrence,
  selectSelectionMatches,
} from '@codemirror/search'
import { foldingExtension } from './folding'
import { indentGuides } from './indentGuides'
import type { DocTier } from './largeFile'
import { t } from '../i18n'

export type BaseOptions = {
  tabSize: number
  /** File is Tab-indented (detected per file, overrides the global setting) */
  useTabs?: boolean
  /** Draw indent guides (can be turned off in settings) */
  indentGuides?: boolean
  tier: DocTier
  /** Include the search state field (the custom ⌘F bar relies on it) */
  includeSearchState?: boolean
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Fold arrow: a small VSCode-style chevron, down when open and right when folded;
 * CSS rotates one icon (`⌄` / `›` vary in size and baseline across fonts).
 */
function foldMarker(open: boolean): HTMLElement {
  const marker = document.createElement('span')
  marker.className = `cm-fold-marker ${open ? 'cm-fold-marker-open' : 'cm-fold-marker-closed'}`
  marker.title = open ? t('editor.foldTip') : t('editor.unfoldTip')
  marker.setAttribute('aria-hidden', 'true')

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('fill', 'none')

  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', 'M4.5 6.25 8 9.75l3.5-3.5')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '1.75')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')

  svg.appendChild(path)
  marker.appendChild(svg)
  return marker
}

/** Base editor extensions. Viewport-only highlighting is CodeMirror's default; here expensive features are also disabled by file size. */
export function buildBaseExtensions(opts: BaseOptions): Extension[] {
  const heavy = opts.tier === 'full'
  const foldable = opts.tier !== 'preview'

  const base: Extension[] = [
    // Gutter order follows extension order: line numbers leftmost, fold arrows right beside them (VSCode layout)
    lineNumbers(),
    ...(foldable ? [foldGutter({ markerDOM: foldMarker }), foldingExtension] : []),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    drawSelection(),
    dropCursor(),
    // Multi-cursor: rectangular selection (⌥ drag for column select) keeps multiple ranges only with this facet,
    // otherwise CM collapses the selection into one
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    // searchKeymap is deliberately omitted: the custom VSCode-style bar owns ⌘F,
    // but search() still provides the query state and match highlighting.
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      // Multi-cursor: ⌘D selects the next match, ⌘⇧L selects all matches
      // (⌥⌘↑/↓ adding cursors comes with defaultKeymap)
      { key: 'Mod-d', run: selectNextOccurrence },
      { key: 'Mod-Shift-l', run: selectSelectionMatches },
      ...historyKeymap,
      indentWithTab,
    ]),
    search({ top: true }),
    EditorState.tabSize.of(opts.tabSize),
    // Indent unit follows the file so Enter / auto-indent aligns with surrounding code in Tab projects
    indentUnit.of(opts.useTabs ? '\t' : ' '.repeat(Math.max(1, opts.tabSize))),
  ]

  if (opts.tier !== 'preview') {
    base.push(history({ minDepth: heavy ? 100 : 30, newGroupDelay: 400 }))
    base.push(closeBrackets())
    base.push(indentOnInput())
    base.push(bracketMatching())
  }

  // Word completion: no LSP here, but words from the document / grammar lexer are enough.
  // Full tier only: scanning a big file for words means walking the whole doc.
  if (heavy) {
    base.push(
      EditorState.languageData.of(() => [{ autocomplete: completeAnyWord }]),
      autocompletion({ activateOnTyping: true, activateOnTypingDelay: 120 }),
    )
  }

  // Indent guides: enabled for large files too, they only cover the viewport
  if (opts.indentGuides !== false && opts.tier !== 'preview') {
    base.push(indentGuides(opts.tabSize))
  }

  return base
}