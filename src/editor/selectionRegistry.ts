import { createSelectionRegistry } from '../lib/contextSelection'
import type { AgentContextAttachment } from '../lib/ipc'
export const editorSelections = createSelectionRegistry<{ root: string; attachments: AgentContextAttachment[] }>()
