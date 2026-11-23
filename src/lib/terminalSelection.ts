import { createSelectionRegistry } from './contextSelection'
import type { AgentContextAttachment } from './ipc'
export const terminalSelections = createSelectionRegistry<{ root: string; attachments: AgentContextAttachment[] }>()
