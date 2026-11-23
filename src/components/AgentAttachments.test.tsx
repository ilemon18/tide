// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button data-copy={text}>copy</button> }))
import { AgentAttachments } from './AgentAttachments'
afterEach(cleanup)

it('previews literal snapshot text and removes by id without editing the capture', () => {
  const remove = vi.fn()
  const item = { id: 'one', kind: 'editor-selection' as const, sourceRoot: '/repo', capturedAt: 10,
    text: '<script>alert(1)</script>', label: 'a.ts', rel: 'a.ts', unsaved: true,
    startLine: 2, startColumn: 1, endLine: 3, endColumn: 4 }
  const { container } = render(<AgentAttachments attachments={[item]} onRemove={remove} />)
  expect(screen.getByText('a.ts · 2:1–3:4')).toBeTruthy()
  expect(container.querySelector('script')).toBeNull()
  fireEvent.click(container.querySelector('summary')!)
  expect(screen.getByText(item.text)).toBeTruthy()
  expect(container.querySelector('[data-copy]')?.getAttribute('data-copy')).toBe(item.text)
  fireEvent.click(screen.getByRole('button', { name: 'agent.context.remove' }))
  expect(remove).toHaveBeenCalledWith('one')
  expect(item.text).toContain('<script>')
})
