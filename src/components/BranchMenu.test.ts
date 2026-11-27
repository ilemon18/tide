// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { branchesForMenu, searchBranches, selectRecentBranches, sortBranches } from './BranchMenu'
import type { GitBranch } from '../lib/ipc'

const branch = (name: string, kind: GitBranch['kind'], time: number, current = false): GitBranch => ({
  name,
  kind,
  time,
  current,
  upstream: '',
  sha: name,
  subject: name,
})

describe('branch menu data shaping', () => {
  it('limits each local and remote group independently and keeps current local branches first', () => {
    const branches = [
      ...Array.from({ length: 12 }, (_, i) => branch(`local-${i}`, 'local', 100 - i, i === 11)),
      ...Array.from({ length: 11 }, (_, i) => branch(`origin/remote-${i}`, 'remote', 100 - i)),
    ]
    const recent = selectRecentBranches(sortBranches(branches))
    expect(recent.filter((item) => item.kind === 'local')).toHaveLength(10)
    expect(recent.filter((item) => item.kind === 'remote')).toHaveLength(10)
    expect(recent[0].name).toBe('local-11')
    expect(recent.some((item) => item.name === 'local-10')).toBe(false)
  })

  it('includes old branches in complete search and keeps local results before remote results', () => {
    const branches = [
      branch('main', 'local', 10),
      branch('feature/old', 'local', 1),
      branch('origin/feature/old', 'remote', 99),
    ]
    expect(searchBranches(sortBranches(branches), 'old').map((item) => item.name)).toEqual([
      'feature/old',
      'origin/feature/old',
    ])
  })

  it('preserves the 200 result cap at the component boundary', () => {
    const branches = Array.from({ length: 205 }, (_, i) => branch(`feature-${i}`, 'local', 205 - i))
    expect(searchBranches(branches, 'feature')).toHaveLength(205)
    expect(searchBranches(branches, 'feature').slice(0, 200)).toHaveLength(200)
  })
})

it('source control branch picker only includes local branches', () => {
  const values = [branch('main', 'local', 1, true), branch('feature', 'local', 2), branch('origin/main', 'remote', 3)]
  expect(branchesForMenu(values, true).map(value => value.name)).toEqual(['main', 'feature'])
  expect(branchesForMenu(values)).toHaveLength(3)
})
