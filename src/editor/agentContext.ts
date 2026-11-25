import type { EditorState } from '@codemirror/state'
import type { Tab } from '../store/tabs'
import type { AgentContextAttachment } from '../lib/ipc'
import { agentUid } from '../store/agent'

/** Use the exact live document, never a disk read or a stale cached state. */
export function captureEditorContext(state: EditorState, tab: Tab, root: string, capturedAt = Date.now()): AgentContextAttachment[] {
  return state.selection.ranges.filter(range => !range.empty).sort((a, b) => a.from - b.from).map(range => {
    const start = state.doc.lineAt(range.from)
    const end = state.doc.lineAt(range.to)
    return {
      id: agentUid('context'), kind: 'editor-selection' as const, sourceRoot: root, capturedAt,
      label: tab.external ? tab.root : tab.name,
      rel: tab.kind === 'untitled' || tab.external ? null : tab.rel,
      unsaved: tab.dirty || tab.kind === 'untitled',
      startLine: start.number, startColumn: range.from - start.from + 1,
      endLine: end.number, endColumn: range.to - end.from + 1,
      text: state.sliceDoc(range.from, range.to),
    }
  })
}
