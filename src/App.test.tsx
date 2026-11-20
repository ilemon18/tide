// @vitest-environment jsdom
import React from 'react'
import { renderToString } from 'react-dom/server'
import { expect, it } from 'vitest'
import { App } from './App'

it('renders the startup frame before session restoration begins', () => {
  // Exercise the real root component and hooks without starting native IPC effects.
  // A render-time error here (such as a missing hook import) prevents even the
  // restoration timeout from being installed and leaves the packaged app blank.
  const container = document.createElement('div')
  container.innerHTML = renderToString(<App />)

  expect(container.childElementCount).toBe(1)
  expect(container.firstElementChild?.classList.contains('bg-bg')).toBe(true)
})
