import type { Tab } from '../store/tabs'
import { t } from '../i18n'

/**
 * Display titles for tabs. Welcome / settings / diff tab titles are **not stored in state** — storing
 * them would pin one language's text onto the tab and leave it there after a language switch. They
 * are resolved at render time from the current language.
 */
export function tabTitle(tab: Pick<Tab, 'kind' | 'name' | 'staged' | 'seq'>): string {
  if (tab.kind === 'welcome') return t('app.welcome')
  if (tab.kind === 'settings') return t('app.settings')
  if (tab.kind === 'untitled') return t('tab.untitledName', { count: tab.seq ?? 1 })
  if (tab.kind === 'diff' && tab.staged) return t('tabs.stagedName', { name: tab.name })
  return tab.name
}

/** Full tab tooltip (including pinned state) */
export function tabTooltip(tab: Pick<Tab, 'kind' | 'rel' | 'name' | 'staged' | 'pinned' | 'seq'>): string {
  const base = tab.kind === 'file' ? tab.rel : tabTitle(tab)
  return tab.pinned ? `${base}${t('tabs.pinnedSuffix')}` : base
}