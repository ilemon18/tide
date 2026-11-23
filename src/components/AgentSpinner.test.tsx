// @vitest-environment jsdom
import React from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { AgentSpinner } from './AgentSpinner'

afterEach(cleanup)

it.each([12, 18])('rotates a fixed %spx HTML box rather than the SVG', size => {
  const { container, rerender } = render(<AgentSpinner size={size} />)
  const spinner = container.querySelector('.agent-spinner')!
  expect(spinner.tagName).toBe('SPAN')
  expect(spinner.getAttribute('aria-hidden')).toBe('true')
  expect((spinner as HTMLElement).style.width).toBe(`${size}px`)
  expect((spinner as HTMLElement).style.height).toBe(`${size}px`)
  const icon = spinner.querySelector('svg')!
  expect(icon.getAttribute('width')).toBe(String(size))
  expect(icon.classList.contains('agent-spinner')).toBe(false)
  rerender(<AgentSpinner size={size} />)
  expect(container.querySelector('.agent-spinner')).toBe(spinner)
  expect(spinner.querySelector('svg')).toBe(icon)
})
