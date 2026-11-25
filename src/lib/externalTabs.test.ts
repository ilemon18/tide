// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { loadExternalTabs, saveExternalTabs } from './externalTabs'

beforeEach(() => window.localStorage.clear())

it('round-trips external paths with cursor and active state', () => {
  saveExternalTabs([
    { path: '/tmp/one.ts', line: 3, col: 2, active: false },
    { path: '/tmp/two.md', line: 9, col: 1, active: true },
  ])
  expect(loadExternalTabs()).toEqual([
    { path: '/tmp/one.ts', line: 3, col: 2, active: false },
    { path: '/tmp/two.md', line: 9, col: 1, active: true },
  ])
  saveExternalTabs([])
  expect(loadExternalTabs()).toEqual([])
})
