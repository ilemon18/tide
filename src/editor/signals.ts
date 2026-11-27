import type { ViewUpdate } from '@codemirror/view'

/** One-way callback bridge between the editor and the store. Its own module avoids a store <-> editor cycle. */
export const signals = {
  onDirty: (_id: string) => {},
  /** The buffer is back to the text on disk (undo): nothing is modified any more */
  onClean: (_id: string) => {},
  onCursor: (_id: string, _line: number, _col: number) => {},
  /** Document edited: the split view mirrors the change into the other panel (received by mirror.ts) */
  onDocChanged: (_id: string, _update: ViewUpdate) => {},
  onSaved: (_root: string, _rel: string) => {},
  /** The document changed: the structure tree recomputes after a short debounce */
  onOutlineDirty: (_id: string) => {},
  /** A tab's EditorState was just mounted; refresh the outline without waiting for a keystroke */
  onOutlineReady: (_id: string) => {},
  /** ⌘+click on an import path: open the resolved target file */
  onOpenImport: (_root: string, _rel: string) => {},
  /** Whether the editor state is pinned (active or unsaved), used for LRU eviction */
  isPinned: (_id: string) => false,
}