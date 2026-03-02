/**
 * main.js
 * UI logic: file drop, parameter controls, worker communication, preview, download.
 */
import { encodePNG16bit } from './png16.js'

// ─── State ────────────────────────────────────────────────────────────────────
let currentWorker = null
let lastResult    = null  // { r16, g16, b16, width, height }
let inputImage    = null  // { grayData, width, height, dataURL }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const dropZone      = document.getElementById('drop-zone')
const fileInput     = document.getElementById('file-input')
const generateBtn   = document.getElementById('generate-btn')
const cancelBtn     = document.getElementById('cancel-btn')
const downloadBtn   = document.getElementById('download-btn')
const progressArea  = document.getElementById('progress-area')
const progressBar   = document.getElementById('progress-bar')
const progressLog   = document.getElementById('progress-log')
const inCanvas      = document.getElementById('in-canvas')
const outCanvas     = document.getElementById('out-canvas')
const previewArea   = document.getElementById('preview-area')
const infoText      = document.getElementById('info-text')
const skelToggle    = document.getElementById('skel-toggle')

// ─── Parameter inputs ─────────────────────────────────────────────────────────
const sigmaInput      = document.getElementById('sigma')
const sigmaVal        = document.getElementById('sigma-val')
const smoothInput     = document.getElementById('smooth')
const smoothVal       = document.getElementById('smooth-val')
const baseDirSel      = document.getElementById('base-dir')
const morphSel        = document.getElementById('morph')
const blueInput       = document.getElementById('blue')
const blueVal         = document.getElementById('blue-val')

sigmaInput.addEventListener('input',  () => { sigmaVal.textContent  = sigmaInput.value })
smoothInput.addEventListener('input', () => { smoothVal.textContent = (+smoothInput.value).toFixed(1) })
blueInput.addEventListener('input',   () => { blueVal.textContent   = (+blueInput.value).toFixed(2) })

// ─── File loading ─────────────────────────────────────────────────────────────
function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    alert('画像ファイルを選択してください。')
    return
  }

  const reader = new FileReader()
  reader.onload = e => {
    const img = new Image()
    img.onload = () => {
      const w = img.width, h = img.height
      // Draw input to canvas
      inCanvas.width  = w
      inCanvas.height = h
      const ctx = inCanvas.getContext('2d')
      ctx.drawImage(img, 0, 0)

      // Convert to grayscale
      const imageData = ctx.getImageData(0, 0, w, h)
      const gray = new Uint8Array(w * h)
      for (let i = 0; i < w * h; i++) {
        const r = imageData.data[i*4], g = imageData.data[i*4+1], b = imageData.data[i*4+2]
        gray[i] = Math.round(0.299*r + 0.587*g + 0.114*b)
      }

      inputImage = { grayData: gray, width: w, height: h, dataURL: e.target.result }
      lastResult = null

      previewArea.style.display = 'flex'
      generateBtn.disabled = false
      downloadBtn.style.display = 'none'
      outCanvas.width = w; outCanvas.height = h
      outCanvas.getContext('2d').clearRect(0, 0, w, h)
      infoText.textContent = `${file.name}  ${w} × ${h} px`

      // Show skeleton toggle label only if result exists
      document.getElementById('skel-row').style.display = 'none'
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
}

dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over') })
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'))
dropZone.addEventListener('drop', e => {
  e.preventDefault()
  dropZone.classList.remove('drag-over')
  loadFile(e.dataTransfer.files[0])
})
dropZone.addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => loadFile(fileInput.files[0]))

// ─── Generate ─────────────────────────────────────────────────────────────────
generateBtn.addEventListener('click', () => {
  if (!inputImage) return

  // Kill previous worker if any
  if (currentWorker) { currentWorker.terminate(); currentWorker = null }

  const baseDirParts = baseDirSel.value.split(',').map(Number)
  const params = {
    MORPH_CLOSE_KERNEL_SIZE: parseInt(morphSel.value),
    SIGMA:          parseFloat(sigmaInput.value),
    SMOOTH_SIGMA:   parseFloat(smoothInput.value),
    BLUE_VALUE:     parseFloat(blueInput.value),
    BASE_VECTOR_X:  baseDirParts[0],
    BASE_VECTOR_Y:  baseDirParts[1],
  }

  // UI: start
  progressArea.style.display  = 'block'
  progressBar.style.width     = '5%'
  progressLog.textContent     = '開始...'
  generateBtn.disabled        = true
  cancelBtn.style.display     = 'inline-block'
  downloadBtn.style.display   = 'none'

  const STEPS = ['二値化', 'モルフォロジー', 'スケルトン', 'グラフ', 'ポリライン', 'タンジェント', 'ベクトル場', 'エンコード', '完了']
  let stepIdx = 0

  currentWorker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })

  currentWorker.onmessage = e => {
    const { type, message, r16, g16, b16, skeleton } = e.data

    if (type === 'progress') {
      progressLog.textContent = message
      stepIdx = Math.min(stepIdx + 1, STEPS.length)
      progressBar.style.width = Math.round((stepIdx / STEPS.length) * 90 + 5) + '%'

    } else if (type === 'done') {
      currentWorker = null
      lastResult = { r16, g16, b16, width: inputImage.width, height: inputImage.height, skeleton }

      drawFlowMapPreview(r16, g16, b16, inputImage.width, inputImage.height)

      document.getElementById('skel-row').style.display = 'flex'
      skelToggle.checked = false
      skelToggle.dispatchEvent(new Event('change'))

      progressBar.style.width     = '100%'
      progressLog.textContent     = '完了！'
      generateBtn.disabled        = false
      cancelBtn.style.display     = 'none'
      downloadBtn.style.display   = 'inline-block'

    } else if (type === 'error') {
      currentWorker = null
      progressLog.textContent   = '❌ エラー: ' + message
      generateBtn.disabled      = false
      cancelBtn.style.display   = 'none'
    }
  }

  // Transfer grayData buffer (zero-copy)
  const grayDataCopy = new Uint8Array(inputImage.grayData)
  currentWorker.postMessage(
    { grayData: grayDataCopy, width: inputImage.width, height: inputImage.height, params },
    [grayDataCopy.buffer]
  )
})

cancelBtn.addEventListener('click', () => {
  if (currentWorker) { currentWorker.terminate(); currentWorker = null }
  progressLog.textContent   = 'キャンセルしました。'
  progressBar.style.width   = '0%'
  generateBtn.disabled      = false
  cancelBtn.style.display   = 'none'
})

// ─── Preview ──────────────────────────────────────────────────────────────────
function drawFlowMapPreview(r16, g16, b16, w, h) {
  outCanvas.width  = w
  outCanvas.height = h
  const ctx = outCanvas.getContext('2d')
  const imgData = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    imgData.data[i*4]   = r16[i] >> 8
    imgData.data[i*4+1] = g16[i] >> 8
    imgData.data[i*4+2] = b16[i] >> 8
    imgData.data[i*4+3] = 255
  }
  ctx.putImageData(imgData, 0, 0)
}

// Skeleton overlay toggle
skelToggle.addEventListener('change', () => {
  if (!lastResult) return
  const { r16, g16, b16, skeleton, width, height } = lastResult

  if (!skelToggle.checked) {
    drawFlowMapPreview(r16, g16, b16, width, height)
    return
  }

  // Overlay skeleton pixels in red
  const ctx = outCanvas.getContext('2d')
  const imgData = ctx.createImageData(width, height)
  for (let i = 0; i < width * height; i++) {
    if (skeleton[i]) {
      imgData.data[i*4]   = 255
      imgData.data[i*4+1] = 50
      imgData.data[i*4+2] = 50
      imgData.data[i*4+3] = 255
    } else {
      imgData.data[i*4]   = r16[i] >> 8
      imgData.data[i*4+1] = g16[i] >> 8
      imgData.data[i*4+2] = b16[i] >> 8
      imgData.data[i*4+3] = 255
    }
  }
  ctx.putImageData(imgData, 0, 0)
})

// ─── Download 16-bit PNG ───────────────────────────────────────────────────────
downloadBtn.addEventListener('click', async () => {
  if (!lastResult) return
  const { r16, g16, b16, width, height } = lastResult

  downloadBtn.disabled   = true
  downloadBtn.textContent = 'エンコード中...'

  try {
    const pngBytes = await encodePNG16bit(r16, g16, b16, width, height)
    const blob = new Blob([pngBytes], { type: 'image/png' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = 'flowmap_16bit.png'
    a.click()
    URL.revokeObjectURL(url)
  } finally {
    downloadBtn.disabled   = false
    downloadBtn.textContent = 'ダウンロード 16-bit PNG'
  }
})
