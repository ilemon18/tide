import type { Text } from '@codemirror/state'

/** Preview subscribers are multiplexed because both editor panes can show a Markdown preview. */
type MarkdownDocListener = (tabId: string, doc: Text) => void

const listeners = new Set<MarkdownDocListener>()

export function subscribeMarkdownDocs(listener: MarkdownDocListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Independent from signals.onDocChanged: preview updates must never alter split-pane mirroring. */
export function publishMarkdownDoc(tabId: string, doc: Text): void {
  for (const listener of listeners) listener(tabId, doc)
}
