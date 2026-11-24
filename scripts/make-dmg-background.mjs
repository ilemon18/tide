// Zero-dependency, deterministic PNG artwork for the Finder drag-to-Applications window.
// Usage: node scripts/make-dmg-background.mjs
// Native icons and their labels are supplied by Finder; only the arrow and waves are baked in.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'
import { dmgLayoutIssues } from './dmg-contract.mjs'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  let crc = 0xffffffff
  for (const byte of body) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length, 0)
  body.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}

function distanceToSegment(x, y, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
  return Math.hypot(x - ax - t * dx, y - ay - t * dy)
}

export function renderDmgBackground(dmg) {
  const issues = dmgLayoutIssues(dmg)
  if (issues.length) throw new Error(issues.join('; '))
  const { width, height } = dmg.windowSize
  const arrowX = (dmg.appPosition.x + dmg.applicationFolderPosition.x) / 2
  const arrowY = dmg.appPosition.y
  const samples = 4
  const stride = width * 4 + 1
  const raw = Buffer.alloc(stride * height)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      let arrow = 0
      let backWave = 0
      let frontWave = 0
      for (let sx = 0; sx < samples; sx++) {
        const x = px + (sx + 0.5) / samples
        const wave = Math.sin(2 * Math.PI * (x / width + 0.08))
        for (let sy = 0; sy < samples; sy++) {
          const y = py + (sy + 0.5) / samples
          if (y > height * (0.84 + 0.027 * wave)) backWave++
          if (y > height * (0.93 + 0.022 * wave)) frontWave++
          const ax = x - arrowX
          const ay = y - arrowY
          if (Math.abs(ax) <= 31 && Math.abs(ay) <= 18 && Math.min(
            distanceToSegment(ax, ay, -28, 0, 28, 0),
            distanceToSegment(ax, ay, 13, -15, 28, 0),
            distanceToSegment(ax, ay, 13, 15, 28, 0),
          ) <= 2) arrow++
        }
      }
      const t = py / height
      const color = [248 - 15 * t, 251 - 8 * t, 253 - 3 * t]
      for (const [hits, layer] of [
        [backWave, [222, 237, 248]],
        [frontWave, [209, 229, 244]],
        [arrow, [40, 105, 153]],
      ]) {
        const alpha = hits / (samples * samples)
        for (let channel = 0; channel < 3; channel++) {
          color[channel] = color[channel] * (1 - alpha) + layer[channel] * alpha
        }
      }
      const offset = py * stride + 1 + px * 4
      for (let channel = 0; channel < 3; channel++) raw[offset + channel] = Math.round(color[channel])
      raw[offset + 3] = 255
    }
  }

  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const configPath = fileURLToPath(new URL('../src-tauri/tauri.conf.json', import.meta.url))
  const dmg = JSON.parse(readFileSync(configPath, 'utf8')).bundle.macOS.dmg
  const png = renderDmgBackground(dmg)
  const out = resolve(dirname(configPath), dmg.background)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, png)
  console.log('DMG background written:', out)
}
