// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import { applyCodeFontStyle, applyUiFontStyle } from './apply'

afterEach(() => { applyCodeFontStyle(400, false); applyUiFontStyle(400, false) })
it('keeps the UI and code CSS styles independent and removes italic when disabled', () => {
  applyCodeFontStyle(700, true)
  applyUiFontStyle(300, false)
  const root = document.documentElement.style
  expect([root.getPropertyValue('--code-font-weight'), root.getPropertyValue('--code-font-style')]).toEqual(['700', 'italic'])
  expect([root.getPropertyValue('--ui-font-weight'), root.getPropertyValue('--ui-font-style')]).toEqual(['300', 'normal'])
  applyUiFontStyle(600, true)
  applyCodeFontStyle(400, false)
  expect(root.getPropertyValue('--code-font-style')).toBe('normal')
  expect(root.getPropertyValue('--ui-font-style')).toBe('italic')
})
