import { Text, type EditorState } from '@codemirror/state'
import { api, errorCode } from '../lib/ipc'
import { createFileState, getEditorState, markCleanDoc } from './stateCache'
import { createMirrorState } from './mirror'
import { tierFor } from './largeFile'
import { useSettings } from '../store/settings'
import { isConflictedFile } from '../lib/conflictFiles'
import { detectTextMeta } from '../lib/textMeta'
import { editorStateKey, takeUntitledSeed, useTabs, type Tab, type TabGroupId } from '../store/tabs'
import { useUi } from '../store/ui'
import { t } from '../i18n'

/** Rebuild a state from disk (used when the cache was LRU-evicted or on first open) */
async function buildFromDisk(tab: Tab): Promise<EditorState | null> {
  // An untitled buffer has no file behind it. A non-empty one is dirty and therefore never evicted, so
  // reading back "empty" here is only ever correct (a fresh ⌘N, or one the user emptied again).
  if (tab.kind === 'untitled') {
    const settings = useSettings.getState()
    const state = await createFileState({
      id: tab.id,
      root: tab.root,
      rel: tab.rel,
      content: takeUntitledSeed(tab.id),
      tier: 'full',
      readOnly: false,
      tabSize: settings.tabSize,
      wordWrap: tab.wordWrap ?? settings.wordWrap,
      indentGuides: settings.indentGuides,
      inlineBlame: false,
    })
    // An untitled buffer has no file behind it: "unmodified" means empty. A draft restored with text stays marked
    // as unsaved until it is cleared again (its seed text is not a saved baseline)
    markCleanDoc(tab.id, Text.empty)
    return state
  }
  let payload
  try {
    payload = await api.readFile(tab.root, tab.rel)
  } catch (e) {
    // A lazily restored tab can outlive its file (deleted / renamed while Tide was closed): drop the tab with a
    // readable message instead of leaving a blank pane and a raw backend error
    if (errorCode(e) === 'io.notFound' && useTabs.getState().tabs.some((t) => t.id === tab.id)) {
      useUi.getState().toast(t('toast.fileGone', { name: tab.rel }), 'error')
      void useTabs.getState().close(tab.id, true)
    }
    throw e
  }
  if (payload.binary) return null
  const settings = useSettings.getState()
  const tier = tierFor(payload.size)
  // A tab restored lazily has no line ending / indent yet: take them from the content we just read, so a later
  // save writes the file back with its own EOL instead of rewriting a CRLF file as LF
  const meta = detectTextMeta(payload.content)
  useTabs.getState().applyRestoredMeta(tab.id, {
    size: payload.size,
    mtime: payload.mtime,
    eol: meta.eol,
    indentSize: meta.indentSize,
    useTabs: Boolean(meta.useTabs),
    tier,
  })
  return createFileState({
    id: tab.id,
    root: tab.root,
    rel: tab.rel,
    content: payload.content,
    tier,
    readOnly: tier === 'preview' || tab.readOnly,
    conflicted: await isConflictedFile(tab.root, tab.rel, payload.content),
    tabSize: meta.indentSize ?? settings.tabSize,
    useTabs: Boolean(meta.useTabs),
    wordWrap: tab.wordWrap ?? settings.wordWrap,
    indentGuides: settings.indentGuides,
    inlineBlame: settings.inlineBlame,
    // Lazily restored tabs remember their caret in the store: resume there instead of the top of the file
    cursor: useTabs.getState().cursors[tab.id],
  })
}

/**
 * Get the EditorState this panel should mount. Normally there is one (rebuilt from disk on demand when evicted,
 * only if unmodified); a split of the same file gives the secondary pane a mirror state copied from the main
 * state (disk may hold older content).
 */
export async function ensureEditorState(tab: Tab, groupId: TabGroupId): Promise<EditorState | null> {
  // Image preview / diff / welcome / settings pages mount no EditorState, each renders its own component
  if (tab.kind === 'image' || tab.kind === 'diff' || tab.kind === 'settings' || tab.kind === 'welcome')
    return null
  const key = editorStateKey(tab.id, groupId, useTabs.getState().groups)
  const cached = getEditorState(key)
  if (cached) return cached
  if (key === tab.id) return buildFromDisk(tab)

  const canonical = getEditorState(tab.id) ?? (await buildFromDisk(tab))
  if (!canonical) return null
  return createMirrorState({ tab, canonical })
}