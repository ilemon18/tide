import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('bundled CSS fonts are valid local resources with the upstream Smiley Sans license and checksum', () => {
  const cssUrl = new URL('../src/styles/index.css', import.meta.url)
  const css = readFileSync(cssUrl, 'utf8')
  const faces = [...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match => match[1])
  assert(faces.some(face => face.includes("font-family: 'Smiley Sans'")))
  for (const face of faces) {
    const source = /url\(['"]([^'"]+)['"]\)/.exec(face)?.[1]
    if (!source) {
      assert.match(face, /font-family: 'Tide Terminal (System|Consolas) Oblique'/)
      assert.match(face, /src:\s*local\(/)
      continue
    }
    const bytes = readFileSync(new URL(source, cssUrl))
    assert(bytes.length > 48)
    if (source.endsWith('.woff2')) {
      assert.equal(bytes.subarray(0, 4).toString(), 'wOF2')
      assert.equal(bytes.readUInt32BE(8), bytes.length)
    } else assert.equal(bytes.readUInt32BE(0), 0x00010000)
  }
  const provenance = readFileSync(new URL('../src/assets/fonts/SmileySans-SOURCE.md', import.meta.url), 'utf8')
  const expected = /SHA-256: `([0-9a-f]{64})`/.exec(provenance)?.[1]
  assert(expected)
  const font = readFileSync(new URL('../src/assets/fonts/SmileySans-Oblique.woff2', import.meta.url))
  assert.equal(createHash('sha256').update(font).digest('hex'), expected)
  assert(readFileSync(new URL('../public/licenses/SmileySans-OFL.txt', import.meta.url), 'utf8').includes('SIL OPEN FONT LICENSE'))
})

test('derived terminal oblique faces retain their licensed source and recorded checksums', () => {
  const root = new URL('../', import.meta.url)
  const provenance = JSON.parse(readFileSync(new URL('src/assets/fonts/terminal-oblique/SOURCE.json', root), 'utf8'))
  assert.equal(provenance.faces.length, 7)
  for (const face of provenance.faces) {
    for (const [path, hash] of [[face.source, face.sourceSha256], [face.asset, face.sha256]]) {
      assert.equal(createHash('sha256').update(readFileSync(new URL(path, root))).digest('hex'), hash)
    }
    assert(readFileSync(new URL(face.license, root), 'utf8').includes('SIL OPEN FONT LICENSE'))
    assert.match(face.family, /^Tide Terminal Oblique [ABCD]$/)
  }
})
