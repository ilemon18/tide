import { useState, useSyncExternalStore } from 'react'
import type { TabGroupId } from '../store/tabs'
import { useSettings } from '../store/settings'
import { useAgent } from '../store/agent'
import { editorSelections } from '../editor/selectionRegistry'
import type { ContextIntent } from '../lib/agentContext'
import { useT } from '../i18n'
import { ContextMenu } from './ContextMenu'
import { Icon } from './Icon'

export function EditorContextActions({ groupId }: { groupId: TabGroupId }) {
  const t = useT()
  const enabled = useSettings(state => state.agentEnabled)
  const available = useSyncExternalStore(editorSelections.subscribe, () => editorSelections.has(groupId))
  const [menu, setMenu] = useState<{ x: number; y: number; source: ReturnType<typeof editorSelections.read> } | null>(null)
  if (!enabled) return null
  const intents: ContextIntent[] = ['add', 'explain', 'refactor']
  return (
    <>
      <button type="button" disabled={!available} aria-label={t('agent.context.add')}
        data-tip={t('agent.context.add')} onMouseDown={event => event.preventDefault()}
        onClick={event => {
          const source = editorSelections.read(groupId)
          if (source?.attachments.length) setMenu({ x: event.clientX, y: event.clientY, source })
        }}
        className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-accent disabled:opacity-30">
        <Icon name="agent" size={15} />
      </button>
      {menu ? <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={intents.map(intent => ({
        label: t(intent === 'add' ? 'agent.context.add' : intent === 'explain' ? 'agent.context.explain' : 'agent.context.refactor'),
        onClick: () => { if (menu.source) useAgent.getState().addContext(menu.source.root, menu.source.attachments, intent) },
      }))} /> : null}
    </>
  )
}
