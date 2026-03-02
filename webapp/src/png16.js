/**
 * png16.js
 * Encodes 16-bit RGB data into a PNG file (ArrayBuffer).
 *
 * Uses CompressionStream('deflate') when available (modern browsers),
 * falling back to a pure-JS uncompressed zlib implementation.
 */

// ─── CRC-32 table ─────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf, off, len) {
  let crc = 0xFFFFFFFF
  for (let i = off; i < off + len; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ─── zlib / deflate ───────────────────────────────────────────────────────────

/**
 * Compress data using CompressionStream('deflate') → zlib (RFC 1950).
 * Falls back to uncompressed zlib if API is unavailable.
 */
async function compressZlib(data) {
  if (typeof CompressionStream !== 'undefined') {
    try {
      const cs = new CompressionStream('deflate')
      const writer = cs.writable.getWriter()
      writer.write(data)
      writer.close()

      const chunks = []
      const reader = cs.readable.getReader()
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      let total = 0
      for (const c of chunks) total += c.length
      const out = new Uint8Array(total)
      let pos = 0
      for (const c of chunks) { out.set(c, pos); pos += c.length }
      return out
    } catch (_) { /* fall through */ }
  }
  return zlibStored(data)
}

/**
 * Wrap raw data in uncompressed zlib (RFC 1950) + Adler-32 checksum.
 * Used as a fallback when CompressionStream is unavailable.
 */
function zlibStored(data) {
  const BLOCK = 65535
  const blocks = Math.max(1, Math.ceil(data.length / BLOCK))
  // 2 (header) + blocks*(5+blockData) + 4 (adler32)
  const out = new Uint8Array(2 + data.length + blocks * 5 + 4)
  let pos = 0

  // zlib header: CMF=0x78, FLG=0x01  (0x7801 % 31 == 0)
  out[pos++] = 0x78
  out[pos++] = 0x01

  for (let i = 0; i < data.length || i === 0; i += BLOCK) {
    const end = Math.min(i + BLOCK, data.length)
    const len = end - i
    const last = end >= data.length ? 1 : 0
    out[pos++] = last
    out[pos++] = len & 0xFF;       out[pos++] = (len >> 8) & 0xFF
    out[pos++] = (~len) & 0xFF;    out[pos++] = (~len >> 8) & 0xFF
    out.set(data.subarray(i, end), pos); pos += len
  }

  // Adler-32
  let s1 = 1, s2 = 0
  for (let i = 0; i < data.length; i++) {
    s1 = (s1 + data[i]) % 65521
    s2 = (s2 + s1) % 65521
  }
  const adler = (s2 << 16) | s1
  out[pos++] = (adler >>> 24) & 0xFF
  out[pos++] = (adler >> 16) & 0xFF
  out[pos++] = (adler >> 8) & 0xFF
  out[pos++] = adler & 0xFF

  return out.subarray(0, pos)
}

// ─── PNG builder ──────────────────────────────────────────────────────────────

/**
 * Encode three Uint16Array channels as a 16-bit RGB PNG.
 *
 * @param {Uint16Array} r16
 * @param {Uint16Array} g16
 * @param {Uint16Array} b16
 * @param {number} width
 * @param {number} height
 * @returns {Promise<Uint8Array>}  Raw PNG bytes
 */
export async function encodePNG16bit(r16, g16, b16, width, height) {
  // Build raw scanline data: [filter=0, R_hi, R_lo, G_hi, G_lo, B_hi, B_lo, ...] × height
  const rowBytes = 1 + width * 6
  const raw = new Uint8Array(rowBytes * height)

  for (let y = 0; y < height; y++) {
    const rowOff = y * rowBytes
    raw[rowOff] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const i = y * width + x
      const o = rowOff + 1 + x * 6
      raw[o]   = r16[i] >> 8;    raw[o+1] = r16[i] & 0xFF
      raw[o+2] = g16[i] >> 8;    raw[o+3] = g16[i] & 0xFF
      raw[o+4] = b16[i] >> 8;    raw[o+5] = b16[i] & 0xFF
    }
  }

  const compressed = await compressZlib(raw)

  // Total size:
  //   8 (sig) + [4+4+13+4] IHDR + [4+4+N+4] IDAT + [4+4+4] IEND
  const totalSize = 8 + 25 + (12 + compressed.length) + 12
  const out = new Uint8Array(totalSize)
  const view = new DataView(out.buffer)
  let p = 0

  const wb  = v => { out[p++] = v }
  const w4  = v => { view.setUint32(p, v, false); p += 4 }
  const wStr = s => { for (let i = 0; i < s.length; i++) out[p++] = s.charCodeAt(i) }

  // PNG signature
  ;[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].forEach(b => wb(b))

  // IHDR chunk
  w4(13)
  const ihdrStart = p
  wStr('IHDR')
  w4(width); w4(height)
  wb(16)  // bit depth
  wb(2)   // color type: RGB
  wb(0)   // compression method
  wb(0)   // filter method
  wb(0)   // interlace method
  w4(crc32(out, ihdrStart, p - ihdrStart))

  // IDAT chunk
  w4(compressed.length)
  const idatStart = p
  wStr('IDAT')
  out.set(compressed, p); p += compressed.length
  w4(crc32(out, idatStart, p - idatStart))

  // IEND chunk
  w4(0)
  const iendStart = p
  wStr('IEND')
  w4(crc32(out, iendStart, p - iendStart))

  return out
}
