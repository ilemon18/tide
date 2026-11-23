import type { Tab } from '../store/tabs'
import { t } from '../i18n'

/**
 * Display titles for tabs. Welcome / settings / diff tab titles are **not stored in state** — storing
 * them would pin one language's text onto the tab and leave it there after a language switch. They
 * are resolved at render time from the current language.
 */
export function tabTitle(tab: Pick<Tab, 'kind' | 'name' | 'seq'>): string {
  if (tab.kind === 'welcome') return t('app.welcome')
  if (tab.kind === 'settings') return t('app.settings')
  if (tab.kind === 'chat') return tab.name || t('agent.newChat')
  if (tab.kind === 'untitled') return t('tab.untitledName', { count: tab.seq ?? 1 })
  return tab.name
}

/** Full tab tooltip (including pinned state) */
export function tabTooltip(tab: Pick<Tab, 'kind' | 'rel' | 'name' | 'pinned' | 'seq'>): string {
  const base = tab.kind === 'file' ? tab.rel : tab.kind === 'chat' ? tab.name || t('agent.newChat') : tabTitle(tab)
  return tab.pinned ? `${base}${t('tabs.pinnedSuffix')}` : base
}
