import assert from 'node:assert/strict'
import test from 'node:test'
import { checkTrackingState } from './release-git-state.mjs'

function inspect({ origin = 'remote', head = 'local', ahead = '2', behind = '0' } = {}) {
  const passes = []
  const warnings = []
  const calls = []
  checkTrackingState((command, args) => {
    assert.equal(command, 'git')
    calls.push(args)
    const key = args.join(' ')
    const values = {
      'rev-parse HEAD': head,
      'rev-parse --verify origin/main': origin,
      'rev-list --count origin/main..HEAD': ahead,
      'rev-list --count HEAD..origin/main': behind,
    }
    assert.ok(Object.hasOwn(values, key), 'only local, read-only git commands are allowed')
    return { ok: values[key] !== null, out: values[key] ?? '' }
  }, {
    pass: (message) => passes.push(message),
    warn: (message, hint) => warnings.push({ message, hint }),
  })
  return { passes, warnings, calls }
}

for (const [name, ahead, behind] of [['ahead', '2', '0'], ['behind', '0', '2'], ['diverged', '2', '3']]) {
  test(name + ' tracking state is advisory without requiring a push', () => {
    const result = inspect({ ahead, behind })
    assert.equal(result.passes.length, 0)
    assert.equal(result.warnings.length, 1)
    assert.match(result.warnings[0].message, new RegExp('ahead ' + ahead + ', behind ' + behind))
    assert.match(result.warnings[0].hint, /not required/)
    assert.equal(result.calls.length, 4)
  })
}

test('missing tracking ref allows local preflight without a fetch', () => {
  const result = inspect({ origin: null })
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0].hint, /local preflight can continue/)
  assert.equal(result.calls.length, 2)
})

test('matching tracking ref passes', () => {
  const result = inspect({ head: 'remote' })
  assert.equal(result.passes.length, 1)
  assert.equal(result.warnings.length, 0)
  assert.equal(result.calls.length, 2)
})
