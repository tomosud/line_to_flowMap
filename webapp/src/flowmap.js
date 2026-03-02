/**
 * flowmap.js
 * JavaScript port of line_to_flowmap.py
 *
 * Generates a flow map (16-bit RGB) from a line-art image.
 * Assumes white background with dark lines.
 */

// ─── Utilities ────────────────────────────────────────────────────────────────

function normalizeVec(x, y) {
  const len = Math.sqrt(x * x + y * y)
  if (len < 1e-8) return [1.0, 0.0]
  return [x / len, y / len]
}

// ─── Otsu binarization ────────────────────────────────────────────────────────

function binarize(grayData) {
  // Build histogram
  const hist = new Int32Array(256)
  for (let i = 0; i < grayData.length; i++) hist[grayData[i]]++

  // Compute Otsu threshold
  const total = grayData.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]

  let sumB = 0, wB = 0, maxVar = 0, thresh = 0
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > maxVar) { maxVar = v; thresh = t }
  }

  // THRESH_BINARY_INV: pixel > thresh → 0 (background), pixel <= thresh → 1 (line)
  const binary = new Uint8Array(grayData.length)
  for (let i = 0; i < grayData.length; i++) {
    binary[i] = grayData[i] > thresh ? 0 : 1
  }
  return binary
}

// ─── Morphological close ──────────────────────────────────────────────────────

function morphClose(binary, width, height, kSize) {
  if (kSize <= 1) return new Uint8Array(binary)
  const r = Math.floor(kSize / 2)
  const len = width * height

  // Dilation: set to 1 if any kSize×kSize neighbor is 1
  const dilated = new Uint8Array(len)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let found = 0
      loop: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy, nx = x + dx
          if (ny >= 0 && ny < height && nx >= 0 && nx < width && binary[ny * width + nx]) {
            found = 1; break loop
          }
        }
      }
      dilated[y * width + x] = found
    }
  }

  // Erosion: set to 1 only if all kSize×kSize neighbors are 1
  const eroded = new Uint8Array(len)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let all = 1
      loop: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ny = y + dy, nx = x + dx
          if (ny < 0 || ny >= height || nx < 0 || nx >= width || !dilated[ny * width + nx]) {
            all = 0; break loop
          }
        }
      }
      eroded[y * width + x] = all
    }
  }
  return eroded
}

// ─── Zhang-Suen skeletonization ───────────────────────────────────────────────

function skeletonize(binary, width, height, onProgress) {
  const cur = new Uint8Array(binary)
  let iter = 0
  const W = width

  while (true) {
    iter++
    if (onProgress) onProgress(`スケルトン抽出中 (第 ${iter} 反復)...`)

    let changed = false
    const rm1 = []

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (!cur[y * W + x]) continue
        const p2 = cur[(y-1)*W+x],   p3 = cur[(y-1)*W+x+1]
        const p4 = cur[y*W+x+1],     p5 = cur[(y+1)*W+x+1]
        const p6 = cur[(y+1)*W+x],   p7 = cur[(y+1)*W+x-1]
        const p8 = cur[y*W+x-1],     p9 = cur[(y-1)*W+x-1]
        const B = p2+p3+p4+p5+p6+p7+p8+p9
        if (B < 2 || B > 6) continue
        const A = ((!p2&&p3)?1:0)+((!p3&&p4)?1:0)+((!p4&&p5)?1:0)+((!p5&&p6)?1:0)
                +((!p6&&p7)?1:0)+((!p7&&p8)?1:0)+((!p8&&p9)?1:0)+((!p9&&p2)?1:0)
        if (A !== 1) continue
        if (p2 && p4 && p6) continue  // p2*p4*p6 = 0
        if (p4 && p6 && p8) continue  // p4*p6*p8 = 0
        rm1.push(y * W + x)
      }
    }
    for (const i of rm1) cur[i] = 0
    if (rm1.length) changed = true

    const rm2 = []
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        if (!cur[y * W + x]) continue
        const p2 = cur[(y-1)*W+x],   p3 = cur[(y-1)*W+x+1]
        const p4 = cur[y*W+x+1],     p5 = cur[(y+1)*W+x+1]
        const p6 = cur[(y+1)*W+x],   p7 = cur[(y+1)*W+x-1]
        const p8 = cur[y*W+x-1],     p9 = cur[(y-1)*W+x-1]
        const B = p2+p3+p4+p5+p6+p7+p8+p9
        if (B < 2 || B > 6) continue
        const A = ((!p2&&p3)?1:0)+((!p3&&p4)?1:0)+((!p4&&p5)?1:0)+((!p5&&p6)?1:0)
                +((!p6&&p7)?1:0)+((!p7&&p8)?1:0)+((!p8&&p9)?1:0)+((!p9&&p2)?1:0)
        if (A !== 1) continue
        if (p2 && p4 && p8) continue  // p2*p4*p8 = 0
        if (p2 && p6 && p8) continue  // p2*p6*p8 = 0
        rm2.push(y * W + x)
      }
    }
    for (const i of rm2) cur[i] = 0
    if (rm2.length) changed = true

    if (!changed) break
  }
  return cur
}

// ─── Skeleton graph ───────────────────────────────────────────────────────────

function buildGraph(skeleton, width, height) {
  const adjacency = new Map()

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x
      if (!skeleton[idx]) continue
      const nb = []
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dy && !dx) continue
          const ny = y + dy, nx = x + dx
          if (ny >= 0 && ny < height && nx >= 0 && nx < width && skeleton[ny * width + nx]) {
            nb.push(ny * width + nx)
          }
        }
      }
      adjacency.set(idx, nb)
    }
  }

  const endpoints = new Set()
  const junctions = new Set()
  for (const [idx, nb] of adjacency) {
    if (nb.length === 1) endpoints.add(idx)
    else if (nb.length >= 3) junctions.add(idx)
  }
  return { adjacency, endpoints, junctions }
}

// ─── Polyline tracing ─────────────────────────────────────────────────────────

function edgeKey(a, b) {
  return a < b ? `${a}_${b}` : `${b}_${a}`
}

function tracePath(startIdx, adjacency, visitedEdges, visitedPixels, junctions) {
  const polyline = [startIdx]
  visitedPixels.add(startIdx)
  let current = startIdx
  let prev = -1

  while (true) {
    const neighbors = adjacency.get(current)
    const candidates = neighbors.filter(n => n !== prev && !visitedEdges.has(edgeKey(current, n)))
    if (!candidates.length) break

    const nonJunc = candidates.filter(n => !junctions.has(n))
    const next = nonJunc.length ? nonJunc[0] : candidates[0]

    visitedEdges.add(edgeKey(current, next))
    polyline.push(next)
    visitedPixels.add(next)
    prev = current
    current = next

    if (current === startIdx) break // closed loop
  }
  return polyline
}

function traceAllPolylines(adjacency, endpoints, junctions, width, bvx, bvy) {
  const [v0x, v0y] = normalizeVec(bvx, bvy)
  const visitedEdges = new Set()
  const visitedPixels = new Set()
  const polylines = []

  function alignPolyline(pl) {
    if (pl.length < 2) return pl
    const y0 = Math.floor(pl[0] / width), x0 = pl[0] % width
    const y1 = Math.floor(pl[1] / width), x1 = pl[1] % width
    if (v0x * (x1 - x0) + v0y * (y1 - y0) < 0) return [...pl].reverse()
    return pl
  }

  // Open strokes: start from endpoints sorted by y*w+x (top-left first)
  const sortedEP = [...endpoints].sort((a, b) => a - b)
  for (const start of sortedEP) {
    if (visitedPixels.has(start)) {
      const rem = adjacency.get(start).filter(n => !visitedEdges.has(edgeKey(start, n)))
      if (!rem.length) continue
    }
    const pl = tracePath(start, adjacency, visitedEdges, visitedPixels, junctions)
    if (pl.length >= 2) polylines.push(alignPolyline(pl))
  }

  // Closed curves and unreached segments
  const allPx = [...adjacency.keys()]
  while (true) {
    let start = -1
    for (const p of allPx) {
      if (adjacency.get(p).some(n => !visitedEdges.has(edgeKey(p, n)))) { start = p; break }
    }
    if (start === -1) break
    const pl = tracePath(start, adjacency, visitedEdges, visitedPixels, junctions)
    if (pl.length >= 2) polylines.push(alignPolyline(pl))
  }
  return polylines
}

// ─── Tangent computation ──────────────────────────────────────────────────────

function computeTangents(polylines, width, height) {
  const tX = new Float32Array(width * height)
  const tY = new Float32Array(width * height)
  const mask = new Uint8Array(width * height)

  for (const pl of polylines) {
    const n = pl.length
    for (let i = 0; i < n; i++) {
      const idx = pl[i]
      const y = Math.floor(idx / width), x = idx % width
      let tx, ty

      if (n === 1) {
        [tx, ty] = [1.0, 0.0]
      } else if (i === 0) {
        const y1 = Math.floor(pl[1] / width), x1 = pl[1] % width
        ;[tx, ty] = normalizeVec(x1 - x, y1 - y)
      } else if (i === n - 1) {
        const yp = Math.floor(pl[n-2] / width), xp = pl[n-2] % width
        ;[tx, ty] = normalizeVec(x - xp, y - yp)
      } else {
        const yn = Math.floor(pl[i+1] / width), xn = pl[i+1] % width
        const yp = Math.floor(pl[i-1] / width), xp = pl[i-1] % width
        ;[tx, ty] = normalizeVec(xn - xp, yn - yp)
      }

      tX[idx] = tx
      tY[idx] = ty
      mask[idx] = 1
    }
  }
  return { tX, tY, mask }
}

// ─── Gaussian filter (true separable, matches scipy.ndimage.gaussian_filter) ──
// mode='reflect' (half-sample symmetric: ... c b | a b c d | c b a ...)
// truncate=4.0  (kernel radius = ceil(4 * sigma))

function _reflectIdx(i, n) {
  // Map index i into [0, n-1] using reflect (half-sample symmetric) boundary.
  // Equivalent to scipy mode='reflect': index -1 → 1, index n → n-2
  if (i < 0)   i = -i
  if (i >= n)   i = 2 * n - 2 - i
  // Safety clamp for very small images or extreme sigma
  if (i < 0)   i = 0
  if (i >= n)  i = n - 1
  return i
}

function gaussianFilter(data, width, height, sigma) {
  if (sigma <= 0) return new Float32Array(data)

  // Build 1D Gaussian kernel (truncate=4.0, normalized)
  const radius = Math.ceil(4.0 * sigma)
  const kLen   = 2 * radius + 1
  const kernel = new Float32Array(kLen)
  const s2inv  = 1.0 / (2.0 * sigma * sigma)
  let ksum = 0
  for (let i = 0; i < kLen; i++) {
    const d = i - radius
    kernel[i] = Math.exp(-d * d * s2inv)
    ksum += kernel[i]
  }
  for (let i = 0; i < kLen; i++) kernel[i] /= ksum

  // Horizontal pass: src → tmp
  const tmp = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    const row = y * width
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let k = 0; k < kLen; k++) {
        v += data[row + _reflectIdx(x + k - radius, width)] * kernel[k]
      }
      tmp[row + x] = v
    }
  }

  // Vertical pass: tmp → out
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0
      for (let k = 0; k < kLen; k++) {
        v += tmp[_reflectIdx(y + k - radius, height) * width + x] * kernel[k]
      }
      out[y * width + x] = v
    }
  }
  return out
}

// ─── Vector field ─────────────────────────────────────────────────────────────

function buildVectorField(tX, tY, mask, width, height, sigma, smoothSigma, bvx, bvy) {
  const eps = 1e-8
  const [v0x, v0y] = normalizeVec(bvx, bvy)
  const size = width * height
  const hasSkel = mask.some(v => v > 0)

  let blendX, blendY

  if (hasSkel) {
    const maskF = new Float32Array(size)
    const txM   = new Float32Array(size)
    const tyM   = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      maskF[i] = mask[i]
      txM[i]   = tX[i] * mask[i]
      tyM[i]   = tY[i] * mask[i]
    }

    const txSpread = gaussianFilter(txM, width, height, sigma)
    const tySpread = gaussianFilter(tyM, width, height, sigma)
    const wSpread  = gaussianFilter(maskF, width, height, sigma)

    const peak = 1.0 / (2.0 * Math.PI * sigma * sigma)
    blendX = new Float32Array(size)
    blendY = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const vsX = txSpread[i] / (wSpread[i] + eps)
      const vsY = tySpread[i] / (wSpread[i] + eps)
      const w   = Math.min(1.0, wSpread[i] / (peak + eps))
      blendX[i] = (1.0 - w) * v0x + w * vsX
      blendY[i] = (1.0 - w) * v0y + w * vsY
    }
  } else {
    blendX = new Float32Array(size).fill(v0x)
    blendY = new Float32Array(size).fill(v0y)
  }

  // Normalize
  const vfX = new Float32Array(size)
  const vfY = new Float32Array(size)
  for (let i = 0; i < size; i++) {
    const norm = Math.sqrt(blendX[i] ** 2 + blendY[i] ** 2)
    const n = norm < eps ? 1.0 : norm
    vfX[i] = blendX[i] / n
    vfY[i] = blendY[i] / n
  }

  // Smoothing
  if (smoothSigma > 0) {
    const smX = gaussianFilter(vfX, width, height, smoothSigma)
    const smY = gaussianFilter(vfY, width, height, smoothSigma)
    for (let i = 0; i < size; i++) {
      const norm = Math.sqrt(smX[i] ** 2 + smY[i] ** 2)
      const n = norm < eps ? 1.0 : norm
      vfX[i] = smX[i] / n
      vfY[i] = smY[i] / n
    }
  }

  return { vfX, vfY }
}

// ─── Flow map encode ──────────────────────────────────────────────────────────

function encodeFlowmap(vfX, vfY, width, height, blueValue) {
  const size = width * height
  const r16 = new Uint16Array(size)
  const g16 = new Uint16Array(size)
  const b16 = new Uint16Array(size)
  const bv16 = Math.round(blueValue * 65535)

  for (let i = 0; i < size; i++) {
    r16[i] = Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * vfX[i])) * 65535)
    g16[i] = Math.round(Math.max(0, Math.min(1, 0.5 + 0.5 * vfY[i])) * 65535)
    b16[i] = bv16
  }
  return { r16, g16, b16 }
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * @param {Uint8Array} grayData  - Grayscale pixel values (0–255), row-major
 * @param {number}     width
 * @param {number}     height
 * @param {object}     params    - Algorithm parameters (see DEFAULTS below)
 * @param {function}   onProgress - Callback(message: string)
 * @returns {{ r16, g16, b16, skeleton }}
 */
export function processFlowMap(grayData, width, height, params, onProgress) {
  const {
    MORPH_CLOSE_KERNEL_SIZE = 3,
    SIGMA                   = 20.0,
    SMOOTH_SIGMA            = 1.0,
    BLUE_VALUE              = 0.5,
    BASE_VECTOR_X           = 1.0,
    BASE_VECTOR_Y           = 1.0,
  } = params || {}

  const p = onProgress || (() => {})

  p('二値化中 (Otsu)...')
  const binary = binarize(grayData)

  p('モルフォロジー処理中...')
  const closed = morphClose(binary, width, height, MORPH_CLOSE_KERNEL_SIZE)

  const skeleton = skeletonize(closed, width, height, p)
  const skelCount = skeleton.reduce((s, v) => s + v, 0)
  p(`スケルトン画素数: ${skelCount}`)

  // No skeleton found → return base vector field
  if (skelCount === 0) {
    p('スケルトンが見つかりません。ベース方向場を出力します。')
    const [v0x, v0y] = normalizeVec(BASE_VECTOR_X, BASE_VECTOR_Y)
    const vfX = new Float32Array(width * height).fill(v0x)
    const vfY = new Float32Array(width * height).fill(v0y)
    const result = encodeFlowmap(vfX, vfY, width, height, BLUE_VALUE)
    return { ...result, skeleton }
  }

  p('グラフ構築中...')
  const { adjacency, endpoints, junctions } = buildGraph(skeleton, width, height)
  p(`端点: ${endpoints.size}, 分岐点: ${junctions.size}`)

  p('ポリライン追跡中...')
  const polylines = traceAllPolylines(adjacency, endpoints, junctions, width, BASE_VECTOR_X, BASE_VECTOR_Y)
  p(`ポリライン数: ${polylines.length}`)

  p('タンジェント計算中...')
  const { tX, tY, mask } = computeTangents(polylines, width, height)

  p('ベクトル場構築中 (Gaussian 拡散)...')
  const { vfX, vfY } = buildVectorField(tX, tY, mask, width, height, SIGMA, SMOOTH_SIGMA, BASE_VECTOR_X, BASE_VECTOR_Y)

  p('フローマップ変換中...')
  const result = encodeFlowmap(vfX, vfY, width, height, BLUE_VALUE)

  p('完了！')
  return { ...result, skeleton }
}
