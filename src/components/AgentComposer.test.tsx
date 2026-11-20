// @vitest-environment jsdom
import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../store/agent', () => ({ useAgent: (select: (state: unknown) => unknown) => select({ skillsByRoot: {}, skillsLoading: {} }) }))
vi.mock('../store/fileIndex', () => ({ useFileIndex: Object.assign((select: (state: unknown) => unknown) => select({ byRoot: {}, indexing: {} }), { getState: () => ({ ensure: vi.fn() }) }) }))
vi.mock('../store/settings', () => ({
  AGENT_COMPOSER_MAX_HEIGHT: 480, AGENT_COMPOSER_MIN_HEIGHT: 60,
  useSettings: (select: (state: unknown) => unknown) => select({ agentComposerHeight: 60 }),
}))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key, t: (key: string) => key }))
vi.mock('./AgentPickers', () => ({ AgentPicker: () => null, ModelPicker: () => null, EffortPicker: () => null }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { AgentComposer } from './AgentComposer'
afterEach(cleanup)
it('orders context, stop and send and allows a standalone plan toggle', () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const onChange = vi.fn()
  const view = render(<AgentComposer root="/repo" draft="/plan" mentions={[]} skills={[]} provider="codex" model="" effort=""
    running contextUsage={<button aria-label="context" />} onDraft={onChange} onMentions={onChange} onCommand={onChange}
    onSkills={onChange} onProvider={onChange} onModel={onChange} onEffort={onChange} onStop={onChange} onSend={onChange} />)
  const buttons = [...view.container.querySelectorAll('button')]
  expect(buttons.indexOf(screen.getByLabelText('context'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.stop')))
  expect(buttons.indexOf(screen.getByLabelText('agent.stop'))).toBeLessThan(buttons.indexOf(screen.getByLabelText('agent.queue.send')))
  expect((screen.getByLabelText('agent.queue.send') as HTMLButtonElement).disabled).toBe(false)
  vi.unstubAllGlobals()
})
