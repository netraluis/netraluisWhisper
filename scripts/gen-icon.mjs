// Generate the macOS app icon (1024px PNG) from the whisper logo, in pure Node
// (no rasterizer). Same design as the web logo: teal->sand rounded square with
// a white sound-wave. 2x2 supersampling for anti-aliasing. Transparent corners.
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'

const S = 1024
const k = S / 100 // scale from the 100-unit web logo

// Rounded-square (squircle) geometry, matching logo.svg rect(6,6,88,88) r=22.
const RX = 6 * k, RY = 6 * k, RW = 88 * k, RH = 88 * k, RR = 22 * k
// White waveform bars: [x, y, height] at width 6, radius 3.
const BARS = [[23, 43, 14], [35, 35, 30], [47, 27, 46], [59, 35, 30], [71, 43, 14]]
const BW = 6 * k, BR = 3 * k

// Brand colors.
const TEAL = [11, 85, 99] // #0B5563
const SAND = [244, 184, 96] // #F4B860
const WHITE = [234, 243, 244] // #EAF3F4

// Gradient axis: bottom-left (teal) -> top-right (sand), across the square.
const AX = RX, AY = RY + RH, BX = RX + RW, BY = RY
const dx = BX - AX, dy = BY - AY, dlen2 = dx * dx + dy * dy

function inRoundRect(px, py, x, y, w, h, r) {
  const x2 = x + w, y2 = y + h
  if (px < x || px > x2 || py < y || py > y2) return false
  let cx = null, cy = null
  if (px < x + r && py < y + r) { cx = x + r; cy = y + r }
  else if (px > x2 - r && py < y + r) { cx = x2 - r; cy = y + r }
  else if (px < x + r && py > y2 - r) { cx = x + r; cy = y2 - r }
  else if (px > x2 - r && py > y2 - r) { cx = x2 - r; cy = y2 - r }
  if (cx !== null) return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
  return true
}

function inAnyBar(px, py) {
  for (const [bx, by, bh] of BARS) {
    if (inRoundRect(px, py, bx * k, by * k, BW, bh * k, BR)) return true
  }
  return false
}

// Color of a single sub-sample: [r,g,b,a] with a in 0..1, or null (transparent).
function sample(px, py) {
  if (!inRoundRect(px, py, RX, RY, RW, RH, RR)) return null
  if (inAnyBar(px, py)) return [...WHITE, 1]
  let t = ((px - AX) * dx + (py - AY) * dy) / dlen2
  t = Math.max(0, Math.min(1, t))
  return [
    Math.round(TEAL[0] + (SAND[0] - TEAL[0]) * t),
    Math.round(TEAL[1] + (SAND[1] - TEAL[1]) * t),
    Math.round(TEAL[2] + (SAND[2] - TEAL[2]) * t),
    1,
  ]
}

// Build raw RGBA scanlines (filter byte 0 per row) with 2x2 supersampling.
const raw = Buffer.alloc(S * (1 + S * 4))
const OFF = [0.25, 0.75]
for (let y = 0; y < S; y++) {
  const rowStart = y * (1 + S * 4)
  raw[rowStart] = 0 // filter: none
  for (let px = 0; px < S; px++) {
    let r = 0, g = 0, b = 0, a = 0, n = 0
    for (const oy of OFF) for (const ox of OFF) {
      const s = sample(px + ox, y + oy)
      if (s) { r += s[0]; g += s[1]; b += s[2]; a += 1 }
      n++
    }
    const idx = rowStart + 1 + px * 4
    if (a > 0) {
      raw[idx] = Math.round(r / a)
      raw[idx + 1] = Math.round(g / a)
      raw[idx + 2] = Math.round(b / a)
      raw[idx + 3] = Math.round((a / n) * 255)
    } // else stays 0,0,0,0 (transparent)
  }
}

// PNG encode.
function crc32(buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k2 = 0; k2 < 8; k2++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (~c) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const idat = deflateSync(raw, { level: 9 })
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])

mkdirSync('build', { recursive: true })
writeFileSync('build/icon.png', png)
console.log('wrote build/icon.png', png.length, 'bytes,', S + 'x' + S)
