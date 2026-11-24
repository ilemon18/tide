// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { suppressDefaultContextMenu } from './contextMenu'

it('suppresses native menus without blocking component context menus or propagation', () => {
  const stop = suppressDefaultContextMenu(document)
  const region = document.createElement('div')
  const customMenu = vi.fn()
  const bubbled = vi.fn()
  region.addEventListener('contextmenu', customMenu)
  document.body.addEventListener('contextmenu', bubbled)
  document.body.append(region)
  try {
    for (const tag of ['div', 'input', 'textarea', 'img']) {
      const element = document.createElement(tag)
      region.append(element)
      const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
      element.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(customMenu).toHaveBeenCalledTimes(4)
    expect(bubbled).toHaveBeenCalledTimes(4)
    stop()
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    region.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  } finally {
    stop()
    document.body.removeEventListener('contextmenu', bubbled)
    region.remove()
  }
})
