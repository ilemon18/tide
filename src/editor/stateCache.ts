import { Compartment, EditorState, type Extension, type Text } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { buildBaseExtensions } from './setup'
import { loadLanguage } from './languages'
import { buildEditorTheme } from '../theme/cmTheme'
import { palettes, type Palette } from '../theme/palettes'
import { signals } from './signals'
import { editorSelections } from './selectionRegistry'
import { getGroupOfView } from './viewRef'
import type { DocTier } from './largeFile'
import { blameExtension, blameField, setBlameEffect } from './blame'
import type { BlameResult } from '../lib/ipc'
import { flashExtension } from './highlight'
import { importLinkExtension, supportsImportLinks } from './importLinks'
import { diffMarksGutter } from './diffGutter'
import { conflictExtension, conflictRulerExtension, looksLikeConflict } from './conflicts'
import { mirrorKey } from './stateKeys'
import { publishMarkdownDoc } from './markdownDocs'

import type { MonoFont } from '../lib/ipc'
import { BUNDLED_MONO_FONT, SYSTEM_MONO_FONT, monoStack } from '../lib/fonts'
import { budget, feature } from '../lib/memoryBudget'

export { BUNDLED_MONO_FONT, SYSTEM_MONO_FONT, monoStack }


/** Theme/font size are reconfigured through a Compartment, so a theme switch keeps the EditorState (and undo history) */
export const themeCompartment = new Compartment()

/** Inline blame toggle */
export const blameCompartment = new Compartment()

/** Word wrap toggle (per file: ⌥Z / the command palette), reconfigured instead of rebuilding the state */
export const wrapCompartment = new Compartment()

/**
 * Wrapping is only ever enabled for the `full` tier: a wrapped 5MB line makes CodeMirror measure every
 * line of the document. The create path decides by tier, the toggle only flips it for full-tier files.
 */
export function wrapExtension(enabled: boolean): Extension {
  return enabled ? EditorView.lineWrapping : []
}

/** Flip wrapping on a mounted view without touching undo history */
export function setWordWrap(view: EditorView, enabled: boolean) {
  view.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension(enabled)) })
}

type Look = { palette: Palette; fontSize: number; lineHeight: number; fontFamily: string }

let look: Look = {
  palette: palettes['dark-modern'],
  fontSize: 13,
  lineHeight: 1.55,
  fontFamily: BUNDLED_MONO_FONT,
}
let themeCache: { key: string; ext: Extension } | null = null

/**
 * One EditorState per tab, keeping only the most recently used. EditorState (doc + syntax tree + undo history)
 * dominates memory; a count limit alone is not enough (one big file equals dozens of small ones), so the total
 * character count of resident documents is capped too. The limits live in lib/memoryBudget, which lowers them
 * in lightweight mode.
 */
const states = new Map<string, EditorState>()
/**
 * Text each tab had on disk when it was last read or written (keyed by tab id, never by a mirror key).
 * Comparing against it tells whether an edit really changed anything: undoing back to the saved text makes the
 * tab clean again instead of leaving the "modified" dot forever. CodeMirror documents are persistent trees, so
 * holding one more reference costs almost nothing and `Text.eq` skips identical leading / trailing chunks.
 */
const cleanDocs = new Map<string, Text>()
/** The slot id changes on rename; extensions read the latest tab id / relative path through it */
const slots = new Map<string, { id: string; rel: string }>()
const lastUsed = new Map<string, number>()
const weights = new Map<string, DocTier>()

let clock = 0

export function setEditorLook(
  palette: Palette,
  fontSize: number,
  fontFamily: MonoFont | undefined = 'jetbrains',
) {
  look = { palette, fontSize, lineHeight: 1.55, fontFamily: monoStack(fontFamily) }
  themeCache = null
}

export function currentThemeExtension(): Extension {
  const key = `${look.palette.id}:${look.fontSize}:${look.fontFamily}`
  if (themeCache?.key === key) return themeCache.ext
  const ext = buildEditorTheme(look.palette, {
    fontFamily: look.fontFamily,
    fontSize: look.fontSize,
    lineHeight: look.lineHeight,
  })
  themeCache = { key, ext }
  return ext
}

export function getEditorState(id: string): EditorState | null {
  const state = states.get(id)
  if (state) lastUsed.set(id, ++clock)
  return state ?? null
}

/** Remember the text that is on disk right now (file read / successful save) */
export function markCleanDoc(id: string, doc: Text) {
  cleanDocs.set(id, doc)
}

/** Whether the buffer still equals what was last written to / read from disk */
export function isCleanDoc(id: string, doc: Text): boolean {
  const clean = cleanDocs.get(id)
  return Boolean(clean && clean.eq(doc))
}

/** Write the view's latest state back to the cache. EditorState is immutable, so skipping this would return a stale snapshot on tab switch / background reload and overwrite unsaved edits. */
export function cacheEditorState(id: string, state: EditorState) {
  if (states.has(id)) states.set(id, state)
}

/** Drop a tab's state (plus the mirror state a split may have created) */
export function dropEditorState(id: string) {
  cleanDocs.delete(id)
  for (const key of [id, mirrorKey(id)]) {
    states.delete(key)
    slots.delete(key)
    lastUsed.delete(key)
    weights.delete(key)
    pendingBlame.delete(key)
  }
}

export function clearEditorStates() {
  states.clear()
  slots.clear()
  lastUsed.clear()
  weights.clear()
  pendingBlame.clear()
  cleanDocs.clear()
}

export function rekeyEditorState(fromId: string, toId: string) {
  // The baseline of "what is on disk" follows the tab id too
  const clean = cleanDocs.get(fromId)
  cleanDocs.delete(fromId)
  if (clean) cleanDocs.set(toId, clean)
  // Rename the main state together with the mirror state
  for (const [from, to] of [
    [fromId, toId],
    [mirrorKey(fromId), mirrorKey(toId)],
  ]) {
    const state = states.get(from)
    if (state) {
      states.delete(from)
      states.set(to, state)
    }
    const slot = slots.get(from)
    if (slot) {
      slot.id = toId
      slots.delete(from)
      slots.set(to, slot)
    }
    const weight = weights.get(from)
    if (weight) {
      weights.delete(from)
      weights.set(to, weight)
    }
    lastUsed.set(to, ++clock)
    lastUsed.delete(from)
  }
}

/** Sync the slot's relative path after a file rename (import links resolve against the new location) */
export function setEditorRel(id: string, rel: string) {
  for (const key of [id, mirrorKey(id)]) {
    const slot = slots.get(key)
    if (slot) slot.rel = rel
  }
}

export function editorStateCount(): number {
  return states.size
}

function isHeavy(id: string): boolean {
  const tier = weights.get(id)
  return tier !== undefined && tier !== 'full'
}

/** Evictable totals (pinned states cannot be evicted, so they are not counted) */
function evictableTotals(): { heavy: number; chars: number } {
  let heavy = 0
  let chars = 0
  for (const [id, state] of states) {
    if (signals.isPinned(id)) continue
    if (isHeavy(id)) heavy += 1
    chars += state.doc.length
  }
  return { heavy, chars }
}

/**
 * Evict by LRU until within budget. Never evict the active state, one with unsaved edits, or a just-created
 * one (keepId): the new tab is not in the tabs store yet, so isPinned cannot see it.
 */
function evictIfNeeded(keepId?: string) {
  const candidates = [...states.keys()]
    .filter((id) => id !== keepId && !signals.isPinned(id))
    .sort((a, b) => (lastUsed.get(a) ?? 0) - (lastUsed.get(b) ?? 0))

  for (const id of candidates) {
    const totals = evictableTotals()
    if (
      states.size <= budget.editorStates() &&
      totals.heavy <= budget.heavyEditorStates() &&
      totals.chars <= budget.editorChars()
    ) {
      break
    }
    dropEditorState(id)
  }
}

/** Trim to the current tab and tabs with unsaved edits. Called when the window hides or loses focus for a while, to hand docs and syntax trees back to the OS. */
export function trimEditorStates(keepId?: string | null) {
  for (const id of [...states.keys()]) {
    if (id === keepId) continue
    if (signals.isPinned(id)) continue
    dropEditorState(id)
  }
}

type CreateFileOpts = {
  /** Cache key: the tab id for a normal tab, `${tabId}@secondary` for a mirror state */
  id: string
  /** Which tab this state represents (mirror state edits count towards the real tab) */
  tabId?: string
  /** Workspace root, needed to resolve import links */
  root: string
  rel: string
  content: string
  tier: DocTier
  readOnly: boolean
  tabSize: number
  /** File uses Tab indentation */
  useTabs?: boolean
  /** Wrap long lines; ignored for the preview / large tiers (see wrapCompartment) */
  wordWrap: boolean
  /** Draw indent guides */
  indentGuides?: boolean
  inlineBlame: boolean
  /** git reports the file unmerged: attach conflict decorations and buttons */
  conflicted?: boolean
  /** Import-link extension; false for external files (their root is the file, not a project) */
  importLinks?: boolean
  /** Git change bar in the line-number gutter; omitted for untitled / external / preview states */
  diffGutter?: boolean
  blame?: BlameResult | null
  /** Where the caret goes: the remembered position (restored tab / cache rebuild), 1-based */
  cursor?: { line: number; col: number }
}

export async function createFileState(opts: CreateFileOpts): Promise<EditorState> {
  const lang = opts.tier === 'preview' ? null : await loadLanguage(opts.rel)
  // Project files get the change bar by default; external files pass importLinks: false and
  // untitled buffers opt out explicitly.
  const diffGutter = opts.diffGutter ?? (opts.importLinks !== false)
  const tabId = opts.tabId ?? opts.id
  const slot = { id: tabId, rel: opts.rel }
  slots.set(opts.id, slot)
  weights.set(opts.id, opts.tier)

  const state = EditorState.create({
    doc: opts.content,
    extensions: [
      // Registered before the line numbers, so the 4px change bar sits at the gutter's left edge.
      diffGutter && opts.tier !== 'preview' ? diffMarksGutter : [],
      buildBaseExtensions({
        tabSize: opts.tabSize,
        useTabs: opts.useTabs,
        indentGuides: opts.indentGuides,
        tier: opts.tier,
        includeSearchState: true,
      }),
      wrapCompartment.of(wrapExtension(opts.wordWrap && opts.tier === 'full')),
      lang ? [lang] : [],
      // Conflict view only when git confirms unmerged and markers really remain;
      // not in the read-only preview (buttons would dispatch edits into a read-only state)
      opts.conflicted && opts.tier !== 'preview' && looksLikeConflict(opts.content)
        ? [conflictExtension, conflictRulerExtension]
        : [],
      // Not in the read-only preview: the viewport scan also costs per line. Skipped in lightweight mode too
      opts.tier !== 'preview' &&
      opts.importLinks !== false &&
      feature.importLinks() &&
      supportsImportLinks(opts.rel)
        ? importLinkExtension(() => ({ root: opts.root, rel: slot.rel }))
        : [],
      themeCompartment.of(currentThemeExtension()),
      blameCompartment.of(opts.inlineBlame && feature.inlineBlame() ? blameExtension : []),
      flashExtension,
      EditorView.updateListener.of((update) => {
        const contextGroup = getGroupOfView(update.view)
        if (contextGroup && (update.selectionSet || update.docChanged)) editorSelections.notify(contextGroup)
        // Keep the cache pointing at the view's latest state so tab switches, closes
        // and background reloads never overwrite unsaved content with a stale snapshot
        cacheEditorState(opts.id, update.state)
        if (update.docChanged) {
          // Markdown previews use their own channel; split-pane mirroring stays on signals.onDocChanged.
          publishMarkdownDoc(slot.id, update.state.doc)
          // Undoing back to the text on disk is not a modification: the tab has nothing left to save, so the
          // "unsaved" dot goes away again (and the queued auto-save is dropped by onClean)
          if (isCleanDoc(slot.id, update.state.doc)) signals.onClean(slot.id)
          else signals.onDirty(slot.id)
          // Split view: forward this edit to the other panel (handled by mirror.ts)
          signals.onDocChanged(slot.id, update)
          // The structure panel only listens while visible; computing is debounced there
          signals.onOutlineDirty(slot.id)
        }
        if (update.selectionSet || update.docChanged) {
          // Only the focused pane updates the status bar line/column, else the mirror pane would overwrite it
          if (update.view.hasFocus) {
            const head = update.state.selection.main.head
            const line = update.state.doc.lineAt(head)
            signals.onCursor(slot.id, line.number, head - line.from + 1)
          }
        }
        if (update.selectionSet) signals.onBlameRefresh(slot.id)
      }),
      ...(opts.readOnly
        ? [
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            EditorView.editorAttributes.of({ class: 'cm-readonly' }),
          ]
        : []),
    ],
  })

  // A state always starts its caret at 0: a tab that was just restored from the session (or rebuilt after an
  // LRU eviction) must resume where it was, not at the top
  const placed = opts.cursor ? withCaret(state, opts.cursor) : state
  states.set(opts.id, placed)
  publishMarkdownDoc(slot.id, placed.doc)
  // A mirror state is built from the other pane's buffer, which may hold unsaved edits: only the primary state
  // (opts.tabId undefined) is known to hold exactly what is on disk, so only it resets the baseline
  if (opts.tabId === undefined) markCleanDoc(slot.id, placed.doc)
  lastUsed.set(opts.id, ++clock)
  evictIfNeeded(opts.id)

  if (opts.blame) {
    // No dispatch during create; the caller sets blame after mount
    pendingBlame.set(opts.id, opts.blame)
  }
  return placed
}

/** Move the selection to a 1-based line / column, clamped to the document */
function withCaret(state: EditorState, cursor: { line: number; col: number }): EditorState {
  const line = state.doc.line(Math.min(Math.max(1, cursor.line), state.doc.lines))
  const anchor = Math.min(line.to, line.from + Math.max(0, cursor.col - 1))
  if (anchor === 0) return state
  return state.update({ selection: { anchor } }).state
}

/** Blame to replay on first mount (dispatch is only possible after EditorState.create) */
const pendingBlame = new Map<string, BlameResult | null>()

export function takePendingBlame(id: string): BlameResult | null | undefined {
  const value = pendingBlame.get(id)
  pendingBlame.delete(id)
  return value
}

export function applyBlameToView(view: EditorView, blame: BlameResult | null) {
  // The field may be missing when the toggle was off at create time; add it on demand
  if (!view.state.field(blameField, false)) {
    view.dispatch({ effects: blameCompartment.reconfigure(blameExtension) })
  }
  view.dispatch({ effects: setBlameEffect.of(blame) })
}

export function setBlameEnabled(view: EditorView, enabled: boolean) {
  view.dispatch({
    effects: blameCompartment.reconfigure(enabled ? blameExtension : []),
  })
}

/** Reconfigure the mounted view after a theme / font size change */
export function reconfigureTheme(view: EditorView) {
  view.dispatch({ effects: themeCompartment.reconfigure(currentThemeExtension()) })
}
