// @vitest-environment jsdom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import codexIcon from '../assets/agentIcons/codex.svg'
import { AgentProviderIcon } from './AgentProviderIcon'

afterEach(cleanup)

it('tints single-colour provider marks with the current text colour', () => {
  const { container } = render(<AgentProviderIcon provider="codex" size={14} className="text-accent" />)
  const mark = container.firstElementChild as HTMLElement

  expect(mark.tagName).toBe('SPAN')
  expect(container.querySelector('img')).toBeNull()
  expect(mark.style.width).toBe('14px')
  expect(mark.style.height).toBe('14px')
  expect(mark.getAttribute('style')?.toLowerCase()).toContain(codexIcon.toLowerCase())
  expect(mark.getAttribute('style')?.toLowerCase()).toContain('currentcolor')
})

it('keeps multi-colour provider marks as images', () => {
  const { container } = render(<AgentProviderIcon provider="claude" size={16} />)
  const image = container.querySelector('img')

  expect(image).toBeTruthy()
  expect(image?.getAttribute('width')).toBe('16')
  expect(image?.getAttribute('height')).toBe('16')
})
