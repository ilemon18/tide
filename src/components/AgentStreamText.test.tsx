// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('./AgentMarkdown', () => ({ AgentMarkdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }))
import { AgentStreamText } from './AgentStreamText'
afterEach(() => { cleanup(); vi.useRealTimers() })
it('smooths newly received graphemes and immediately renders completed or historical content', () => {
  vi.useFakeTimers()
  const { rerender } = render(<AgentStreamText text="start" live />)
  rerender(<AgentStreamText text="start中文👩‍💻🙂" live />)
  expect(screen.getByTestId('markdown').textContent).toBe('start')
  act(() => { vi.advanceTimersByTime(24) })
  const partial = screen.getByTestId('markdown').textContent!
  expect('start中文👩‍💻🙂'.startsWith(partial)).toBe(true)
  expect(partial.endsWith('👩')).toBe(false)
  rerender(<AgentStreamText text="start中文👩‍💻🙂" live={false} />)
  expect(screen.getByTestId('markdown').textContent).toBe('start中文👩‍💻🙂')
})
it('replaces a corrected final snapshot instead of replaying the previous prefix', () => {
  const { rerender } = render(<AgentStreamText text="old" live />)
  rerender(<AgentStreamText text="corrected" live />)
  expect(screen.getByTestId('markdown').textContent).toBe('corrected')
})
