// Zero-dependency PNG generator: renders the 1024x1024 app icon for Tide
// Design: dark rounded background + two white waves (solid near, faint far, a tidal feel)
// Usage: node scripts/make-icon.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SIZE = 1024
const SS = 4 // Supersampling factor, keeps edges smooth
// macOS draws app icons on its own grid: the visible artwork should occupy ~824 of the 1024
// canvas. A full-bleed icon looks oversized in the Dock on several macOS versions.
const PAD = 100 / SIZE
const ART = 1 - PAD * 2

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Two waves spanning the whole canvas: the back one thin and semi-transparent, the front one thick and pure white
const WAVE = {
  phase: 0.12,
  back: { base: 0.415, amp: 0.065, thickness: 0.06, alpha: 0.62 },
  front: { base: 0.58, amp: 0.065, thickness: 0.085, alpha: 1 },
}

/** The wave band is an analytic shape: a hit is |y - center line| within half the thickness, no per-pixel intersection test */
function inBand(y, centerY, thickness) {
  return Math.abs(y - centerY) <= thickness / 2
}

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

const rgba = Buffer.alloc(SIZE * SIZE * 4)
const radius = 0.225

// Background: deep-sea gradient from #16324c (top left) to #081a2b (bottom right)
const BG_FROM = [0x16, 0x32, 0x4c]
const BG_TO = [0x08, 0x1a, 0x2b]

for (let py = 0; py < SIZE; py++) {
  for (let px = 0; px < SIZE; px++) {
    let bgHits = 0
    let backHits = 0
    let frontHits = 0
    for (let sx = 0; sx < SS; sx++) {
      const gx = (px + (sx + 0.5) / SS) / SIZE
      const x = (gx - PAD) / ART
      if (x < 0 || x > 1) continue
      // Both waves share one sin call for the same subpixel column
      const s = Math.sin(2 * Math.PI * (x + WAVE.phase))
      const backY = WAVE.back.base + WAVE.back.amp * s
      const frontY = WAVE.front.base + WAVE.front.amp * s
      for (let sy = 0; sy < SS; sy++) {
        const y = ((py + (sy + 0.5) / SS) / SIZE - PAD) / ART
        if (y < 0 || y > 1) continue
        if (inRoundedRect(x, y, radius)) bgHits++
        if (inBand(y, backY, WAVE.back.thickness)) backHits++
        if (inBand(y, frontY, WAVE.front.thickness)) frontHits++
      }
    }
    const total = SS * SS
    const bgA = bgHits / total
    const backA = (backHits / total) * WAVE.back.alpha
    const frontA = frontHits / total

    const cx = Math.min(1, Math.max(0, (px / SIZE - PAD) / ART))
    const cy = Math.min(1, Math.max(0, (py / SIZE - PAD) / ART))
    const t = Math.min(1, Math.max(0, cx * 0.4 + cy * 0.6))
    let r = Math.round(BG_FROM[0] + (BG_TO[0] - BG_FROM[0]) * t)
    let g = Math.round(BG_FROM[1] + (BG_TO[1] - BG_FROM[1]) * t)
    let b = Math.round(BG_FROM[2] + (BG_TO[2] - BG_FROM[2]) * t)

    // Composite the back wave (semi-transparent white) first, then the front wave (pure white)
    if (backA > 0) {
      r = Math.round(r * (1 - backA) + 0xff * backA)
      g = Math.round(g * (1 - backA) + 0xff * backA)
      b = Math.round(b * (1 - backA) + 0xff * backA)
    }
    if (frontA > 0) {
      r = Math.round(r * (1 - frontA) + 0xff * frontA)
      g = Math.round(g * (1 - frontA) + 0xff * frontA)
      b = Math.round(b * (1 - frontA) + 0xff * frontA)
    }

    const i = (py * SIZE + px) * 4
    rgba[i] = r
    rgba[i + 1] = g
    rgba[i + 2] = b
    rgba[i + 3] = bgA >= 1 ? 255 : Math.round(255 * bgA)
  }
}

const out = new URL('../assets/icon.png', import.meta.url)
mkdirSync(dirname(out.pathname), { recursive: true })
writeFileSync(out, encodePng(SIZE, SIZE, rgba))
console.log('icon written:', out.pathname)