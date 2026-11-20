// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../i18n', () => ({ t: (key: string) => key, useT: () => (key: string) => key }))
vi.mock('./Icon', () => ({ Icon: () => null }))
import { CommandChip } from './AgentTags'
afterEach(cleanup)
it('lets the composer remove a plan chip without sending a message', () => {
  const remove = vi.fn()
  render(<CommandChip id="plan" onRemove={remove} />)
  expect(screen.getByText('/plan')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'agent.command.remove' }))
  expect(remove).toHaveBeenCalledOnce()
})
