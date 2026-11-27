import { tags as t } from '@lezer/highlight'
import { describe, expect, it } from 'vitest'
import { SYNTAX_RULES } from './syntax'

const tagsFor = (cls: string) => SYNTAX_RULES.find((rule) => rule.cls === cls)?.tags ?? []

describe('syntax rules', () => {
  it('separates control keywords from ordinary keywords', () => {
    expect(tagsFor('keyword')).toContain(t.keyword)
    expect(tagsFor('keyword')).not.toContain(t.controlKeyword)
    expect(tagsFor('keywordControl')).toEqual([t.controlKeyword])
  })

  it('separates constants from numeric literals', () => {
    expect(tagsFor('number')).toEqual([t.number])
    expect(tagsFor('constant')).toEqual([t.bool, t.null, t.atom])
  })
})
