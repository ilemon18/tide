import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { inflateSync } from 'node:zlib'
import { dmgConfigIssues, dmgLayoutIssues, dmgWorkflowIssues } from './dmg-contract.mjs'
import { renderDmgBackground } from './make-dmg-background.mjs'

const configUrl = new URL('../src-tauri/tauri.conf.json', import.meta.url)
const dmg = JSON.parse(readFileSync(configUrl, 'utf8')).bundle.macOS.dmg
const png = readFileSync(new URL(dmg.background, configUrl))
const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')

test('committed DMG artwork matches the configured layout and its generator', () => {
  assert.deepEqual(dmgConfigIssues(dmg, (path) => readFileSync(new URL(path, configUrl))), [])
  assert.deepEqual(renderDmgBackground(dmg), png, 'regenerate with node scripts/make-dmg-background.mjs')

  const compressed = []
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset)
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
      compressed.push(png.subarray(offset + 8, offset + 8 + length))
    }
    offset += length + 12
  }
  const raw = inflateSync(Buffer.concat(compressed))
  const stride = dmg.windowSize.width * 4 + 1
  assert.equal(raw.length, stride * dmg.windowSize.height)
  for (let y = 0; y < dmg.windowSize.height; y++) {
    assert.equal(raw[y * stride], 0, 'rows use the unfiltered PNG encoding')
    for (let x = 0; x < dmg.windowSize.width; x++) {
      assert.equal(raw[y * stride + x * 4 + 4], 255, 'Finder background is opaque')
    }
  }
  const pixel = (x, y) => [...raw.subarray(y * stride + x * 4 + 1, y * stride + x * 4 + 4)]
  const centerX = (dmg.appPosition.x + dmg.applicationFolderPosition.x) / 2
  assert.deepEqual(pixel(centerX, dmg.appPosition.y), [40, 105, 153], 'arrow points between the native icons')
  assert.deepEqual(pixel(dmg.appPosition.x, dmg.appPosition.y), pixel(dmg.applicationFolderPosition.x, dmg.applicationFolderPosition.y), 'artwork leaves native icon positions clear')
})

test('missing and invalid DMG layouts fail before reading the background', () => {
  for (const invalid of [
    undefined,
    { ...dmg, background: undefined },
    { ...dmg, windowSize: { width: 0, height: 400 } },
    { ...dmg, windowSize: { width: 660.5, height: 400 } },
    { ...dmg, appPosition: { x: -1, y: 170 } },
    { ...dmg, applicationFolderPosition: { x: dmg.windowSize.width, y: 170 } },
    { ...dmg, applicationFolderPosition: { x: 480, y: dmg.windowSize.height } },
    { ...dmg, appPosition: dmg.applicationFolderPosition },
    { ...dmg, appPosition: dmg.applicationFolderPosition, applicationFolderPosition: dmg.appPosition },
    { ...dmg, applicationFolderPosition: { x: 480, y: 180 } },
  ]) {
    assert.ok(dmgLayoutIssues(invalid).length > 0)
    let reads = 0
    assert.ok(dmgConfigIssues(invalid, () => { reads++; return png }).length > 0)
    assert.equal(reads, 0)
  }
})

test('missing, malformed and stale background resources prevent release preflight', () => {
  assert.match(dmgConfigIssues(dmg, () => { throw new Error('ENOENT') })[0], /cannot read.*ENOENT/)
  for (const invalid of [Buffer.alloc(0), Buffer.alloc(png.length), png.subarray(0, 32), png.subarray(0, png.length - 12)]) {
    assert.match(dmgConfigIssues(dmg, () => invalid)[0], /not a complete PNG/)
  }
  assert.match(dmgConfigIssues({ ...dmg, windowSize: { width: 800, height: 500 } }, () => png)[0], /dimensions.*do not match/)
})

test('release builds opt into Finder layout only on macOS before invoking Tauri', () => {
  assert.deepEqual(dmgWorkflowIssues(workflow), [])
  const optIn = 'export TAURI_BUNDLER_DMG_IGNORE_CI=true'
  for (const invalid of [
    workflow.replace(optIn, ''),
    workflow.replace(optIn, '# ' + optIn),
    workflow.replace(optIn, 'export TAURI_BUNDLER_DMG_IGNORE_CI=false'),
    workflow.replace('if [ "${RUNNER_OS}" = "macOS" ]; then', 'if [ "${RUNNER_OS}" = "Windows" ]; then'),
    workflow.replace(optIn, '').replace('          pnpm tauri build "${args[@]}"', '          pnpm tauri build "${args[@]}"\n          ' + optIn),
    workflow.replace('      - name: Build release installers', '      - name: Another step'),
    workflow.replaceAll('set -euo pipefail', 'set -uo pipefail'),
  ]) {
    assert.ok(dmgWorkflowIssues(invalid).length > 0)
  }
})
