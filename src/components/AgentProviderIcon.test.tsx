// @vitest-environment jsdom
import React from 'react'
import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('./Icon', () => ({ Icon: (props: { name: string }) => <span data-testid={`icon-${props.name}`} /> }))

import { AgentProviderIcon } from './AgentProviderIcon'

it('uses provider artwork and falls back to the generic agent icon for unknown providers', () => {
  const { container, rerender } = render(<AgentProviderIcon provider="codex" size={14} />)
  expect(container.querySelector('img')).toBeTruthy()
  rerender(<AgentProviderIcon provider="future-provider" size={14} />)
  expect(container.querySelector('[data-testid="icon-agent"]')).toBeTruthy()
})
