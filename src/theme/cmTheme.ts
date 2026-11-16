import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, type TagStyle } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import type { Palette } from './palettes'
import { SYNTAX_RULES } from './syntax'

export type EditorAppearance = {
  fontFamily: string
  fontSize: number
  lineHeight: number
}

/**
 * Build the CodeMirror theme + syntax highlighting from a palette.
 * Theme switches reconfigure through a Compartment, without rebuilding the EditorState (undo
 * history survives).
 */
export function buildEditorTheme(p: Palette, look: EditorAppearance): Extension {
  const ui = p.ui
  const s = p.syntax

  const theme = EditorView.theme(
    {
      '&': {
        color: ui.fg,
        backgroundColor: ui.bg,
        height: '100%',
        fontSize: `${look.fontSize}px`,
      },
      '.cm-scroller': {
        fontFamily: look.fontFamily,
        lineHeight: String(look.lineHeight),
        overflow: 'auto',
      },
      '.cm-content': {
        caretColor: ui.accent,
        paddingTop: '6px',
        // Keep just a little breathing room: no full-screen blank below the last line when scrolled
        paddingBottom: '8px',
      },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: ui.accent, borderLeftWidth: '2px' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: `${ui.selection} !important`,
      },
      '.cm-activeLine': { backgroundColor: `${ui.hover}66` },
      // Line numbers: one size smaller, gray, right-aligned, and as unobtrusive as in VSCode
      '.cm-gutters': {
        backgroundColor: ui.bg,
        color: `${ui.muted}66`,
        border: 'none',
        paddingLeft: '4px',
        paddingRight: '2px',
        userSelect: 'none',
      },
      '.cm-lineNumbers .cm-gutterElement': {
        // One size smaller than the text, right-aligned. The line height must be spelled out in px
        // matching the text, otherwise a 0.82em font with a relative line height puts the digits
        // high or low in the line box and they no longer line up with the code.
        padding: '0 8px 0 6px',
        minWidth: '34px',
        fontSize: '0.82em',
        lineHeight: `${Math.round(look.fontSize * look.lineHeight)}px`,
        textAlign: 'right',
      },
      '.cm-activeLineGutter': {
        backgroundColor: 'transparent',
        color: `${ui.fg}99`,
      },
      // Fold gutter: vertically centered, width is the arrow's own 16px hit area
      '.cm-foldGutter .cm-gutterElement': {
        color: `${ui.muted}66`,
        padding: '0',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      },
      '.cm-foldPlaceholder': {
        backgroundColor: ui.panelAlt,
        border: `1px solid ${ui.border}`,
        color: ui.muted,
      },
      '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
        backgroundColor: `${ui.accent}33`,
        outline: `1px solid ${ui.accent}66`,
      },
      '.cm-nonmatchingBracket': { color: ui.danger },
      '.cm-selectionMatch': { backgroundColor: `${ui.accent}22` },
      '.cm-searchMatch': { backgroundColor: `${ui.warning}44`, outline: `1px solid ${ui.warning}66` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: `${ui.warning}77` },
      '.cm-panels': { backgroundColor: ui.panel, color: ui.fg, borderColor: ui.border },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${ui.border}` },
      '.cm-panel.cm-search': {
        padding: '6px 8px',
        fontFamily: look.fontFamily,
        fontSize: '12px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: '6px',
        alignItems: 'center',
      },
      '.cm-panel.cm-search input, .cm-panel.cm-search button': {
        backgroundColor: ui.panelAlt,
        color: ui.fg,
        border: `1px solid ${ui.border}`,
        borderRadius: '4px',
        padding: '2px 6px',
        outline: 'none',
      },
      '.cm-panel.cm-search button:hover': { backgroundColor: ui.active },
      '.cm-panel.cm-search label': { color: ui.muted },
      '.cm-tooltip': {
        backgroundColor: ui.panel,
        border: `1px solid ${ui.border}`,
        color: ui.fg,
        borderRadius: '6px',
      },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: ui.active,
        color: ui.fg,
      },
      // Line-level colors used by the diff view
      '.cm-diff-add': { backgroundColor: `${p.terminal.green}22` },
      '.cm-diff-del': { backgroundColor: `${p.terminal.red}22` },
      '.cm-diff-hunk': { backgroundColor: `${p.terminal.blue}1f`, color: p.terminal.blue },
      '.cm-diff-meta': { color: ui.muted },

      // Conflict resolution view: current (ours) greenish, incoming (theirs) bluish, base in gray
      '.cm-conflict-ours': {
        backgroundColor: `${p.terminal.green}1c`,
        borderLeft: `2px solid ${p.terminal.green}`,
      },
      '.cm-conflict-theirs': {
        backgroundColor: `${p.terminal.blue}1c`,
        borderLeft: `2px solid ${p.terminal.blue}`,
      },
      '.cm-conflict-base': {
        backgroundColor: `${ui.muted}12`,
        borderLeft: `2px solid ${ui.muted}55`,
        color: `${ui.fg}bb`,
      },
      '.cm-conflict-marker': {
        backgroundColor: `${ui.warning}12`,
        color: `${ui.muted}`,
        fontWeight: '600',
      },
      '.cm-conflict-actions': {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        marginLeft: '10px',
        verticalAlign: 'middle',
        userSelect: 'none',
        fontSize: '11px',
        lineHeight: '1.4',
      },
      '.cm-conflict-btn': {
        border: `1px solid ${ui.border}`,
        borderRadius: '3px',
        backgroundColor: ui.panelAlt,
        color: ui.fg,
        padding: '1px 6px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 'inherit',
      },
      '.cm-conflict-btn:hover': {
        backgroundColor: ui.hover,
        borderColor: ui.accent,
      },
      '.cm-conflict-hint': {
        color: ui.muted,
        marginLeft: '2px',
      },
      '.cm-readonly .cm-cursor': { display: 'none' },
    },
    { dark: p.dark },
  )

  // Tag groups come from theme/syntax.ts: the diff view colors with the same rules, so colors do not drift
  const highlight = HighlightStyle.define(
    SYNTAX_RULES.map((rule): TagStyle => {
      const spec: TagStyle = { tag: rule.tags }
      if (rule.color) spec.color = s[rule.color]
      if (rule.bold) spec.fontWeight = '600'
      if (rule.italic) spec.fontStyle = 'italic'
      if (rule.underline) spec.textDecoration = 'underline'
      return spec
    }),
  )

  return [theme, syntaxHighlighting(highlight)]
}