import { useSyncExternalStore } from 'react'
import { terminalSelections } from '../lib/terminalSelection'
import { useSettings } from '../store/settings'
import { useAgent } from '../store/agent'
import { useT } from '../i18n'
import { Icon } from './Icon'

export function TerminalContextAction({ tabId }: { tabId: string | null }) {
  const t = useT()
  const enabled = useSettings(state => state.agentEnabled)
  const available = useSyncExternalStore(terminalSelections.subscribe, () => tabId ? terminalSelections.has(tabId) : false)
  if (!enabled) return null
  return (
    <button type="button" disabled={!available} aria-label={t('agent.context.terminal')}
      data-tip={t('agent.context.terminal')} onMouseDown={event => event.preventDefault()}
      onClick={() => {
        const source = tabId ? terminalSelections.read(tabId) : null
        if (source) useAgent.getState().addContext(source.root, source.attachments)
      }}
      className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-accent disabled:opacity-30">
      <Icon name="agent" size={15} />
    </button>
  )
}
