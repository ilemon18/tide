// @vitest-environment jsdom
import React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const { openFile, openAt } = vi.hoisted(() => ({ openFile: vi.fn(), openAt: vi.fn() }))
vi.mock('../store/tabs', () => ({ useTabs: { getState: () => ({ openFile, openAt }) } }))
vi.mock('../i18n', () => ({ useT: () => (key: string) => key }))
vi.mock('./CopyButton', () => ({ CopyButton: ({ text }: { text: string }) => <button data-copy={text}>Copy</button> }))
import { AgentMarkdown } from './AgentMarkdown'

afterEach(() => { cleanup(); vi.clearAllMocks() })

it('renders semantic GFM tables, nested lists, tasks, headings, quotes and inline formatting', () => {
  const { container } = render(<AgentMarkdown text={'# Summary\n\n| File | Result |\n| :--- | ---: |\n| **app.ts** | ~~old~~ *new* |\n\n- [x] Done\n  - Nested\n\n> Quote\n\n`inline`'} />)
  expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Summary')
  expect(screen.getAllByRole('columnheader')).toHaveLength(2)
  expect(screen.getByRole('table').parentElement?.className).toContain('overflow-x-auto')
  expect(screen.getAllByRole('cell')[1].style.textAlign).toBe('right')
  expect(container.querySelector('strong')?.textContent).toBe('app.ts')
  expect(container.querySelector('del')?.textContent).toBe('old')
  expect(container.querySelector('em')?.textContent).toBe('new')
  expect(container.querySelector('li ul li')?.textContent).toBe('Nested')
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true)
  expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(true)
  expect(container.querySelector('blockquote')?.textContent).toContain('Quote')
  expect(container.querySelector('code')?.textContent).toBe('inline')
})

it('opens relative and absolute file links with the owning root and optional position', () => {
  render(<AgentMarkdown root="/repo" text={'[relative](src/main.ts) [absolute](/repo/README.md:8:2) [fragment](src/main.ts#L3)'} />)
  const relative = screen.getByRole('link', { name: 'relative' })
  expect(relative.className).toContain('underline')
  expect(relative.className).toContain('text-blue-500')
  expect(fireEvent.click(relative)).toBe(false)
  expect(openFile).toHaveBeenCalledWith('/repo', 'src/main.ts')
  fireEvent.click(screen.getByRole('link', { name: 'absolute' }))
  expect(openAt).toHaveBeenCalledWith('/repo', 'README.md', 8, 2)
  fireEvent.click(screen.getByRole('link', { name: 'fragment' }))
  expect(openAt).toHaveBeenCalledWith('/repo', 'src/main.ts', 3, 1)
})

it('blocks navigation and remote content while retaining readable output', () => {
  const { container } = render(<AgentMarkdown root="/repo" text={'[outside](../secret) [web](https://example.com) [bad](javascript:123)\n\n![image alt](https://example.com/image.png)\n\n<script>alert(1)</script>\n\n<iframe src="https://example.com"></iframe>'} />)
  for (const link of container.querySelectorAll('a')) {
    expect(fireEvent.click(link)).toBe(false)
    expect(fireEvent(link, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))).toBe(false)
  }
  expect(openFile).not.toHaveBeenCalled()
  expect(openAt).not.toHaveBeenCalled()
  expect(screen.getByText('bad').getAttribute('href')).toBe('')
  expect(container.querySelector('script, iframe, img')).toBeNull()
  expect(screen.getByText('image alt')).toBeTruthy()
})

it('renders incomplete fences and links safely as streamed text grows', () => {
  const { container, rerender } = render(<AgentMarkdown root="/repo" text={'```ts\nconst value = 1'} />)
  expect(container.querySelector('pre code')?.textContent).toBe('const value = 1')
  rerender(<AgentMarkdown root="/repo" text={'```ts\nconst value = 1\n```\n\n[File](src/main'} />)
  expect(screen.getByRole('button').getAttribute('data-copy')).toBe('const value = 1')
  expect(screen.queryByRole('link')).toBeNull()
  rerender(<AgentMarkdown root="/repo" text={'```ts\nconst value = 1\n```\n\n[File](src/main.ts)'} />)
  fireEvent.click(screen.getByRole('link', { name: 'File' }))
  expect(openFile).toHaveBeenCalledWith('/repo', 'src/main.ts')
})
