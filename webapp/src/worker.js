/**
 * worker.js
 * Web Worker: runs the flow map algorithm off the main thread.
 */
import { processFlowMap } from './flowmap.js'

self.onmessage = (e) => {
  const { grayData, width, height, params } = e.data

  try {
    const result = processFlowMap(grayData, width, height, params, (msg) => {
      self.postMessage({ type: 'progress', message: msg })
    })

    // Transfer typed array buffers (zero-copy)
    self.postMessage(
      { type: 'done', r16: result.r16, g16: result.g16, b16: result.b16, skeleton: result.skeleton },
      [result.r16.buffer, result.g16.buffer, result.b16.buffer, result.skeleton.buffer]
    )
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message + '\n' + err.stack })
  }
}
