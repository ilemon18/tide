import { expect, it, vi } from 'vitest'
vi.mock('../i18n', () => ({ t: (key: string) => key }))
import { tabTitle, tabTooltip } from './tabTitle'

it('uses an Agent tab label while retaining the conversation title in its tooltip', () => {
  const tab = { kind: 'chat' as const, name: 'Investigate streaming', rel: '', pinned: false }
  expect(tabTitle(tab)).toBe('agent.tabLabel')
  expect(tabTooltip(tab)).toBe('Investigate streaming')
  expect(tabTooltip({ ...tab, pinned: true })).toBe('Investigate streamingtabs.pinnedSuffix')
  expect(tabTooltip({ ...tab, name: '' })).toBe('agent.newChat')
})
