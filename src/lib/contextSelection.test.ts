import { expect, it, vi } from 'vitest'
import { createSelectionRegistry } from './contextSelection'

it('publishes availability without copying text, and unregisters only the current instance', () => {
  const registry = createSelectionRegistry<string>()
  const listener = vi.fn()
  const unsubscribe = registry.subscribe(listener)
  let selected = false
  const read = vi.fn(() => selected ? 'snapshot' : null)
  const old = registry.register('one', read, () => selected)
  expect(read).not.toHaveBeenCalled()
  selected = true; registry.notify('one')
  expect(listener).toHaveBeenCalledOnce()
  expect(registry.read('one')).toBe('snapshot')
  const current = registry.register('one', () => 'replacement', () => true)
  old()
  expect(registry.read('one')).toBe('replacement')
  current()
  expect(registry.has('one')).toBe(false)
  expect(registry.read('one')).toBeNull()
  unsubscribe()
})
