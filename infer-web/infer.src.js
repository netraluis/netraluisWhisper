// Local Whisper inference, running in a dedicated hidden window over http
// origin so transformers.js uses the WEB backend (WebGPU) and caches models.
// Bundled with esbuild (no CDN) so local transcription survives a CDN outage.
// The onnxruntime wasm is self-hosted under ./ort/ (see build:infer).
import { pipeline, env } from '@huggingface/transformers'

// Serve the ORT wasm from our own origin instead of a CDN.
env.backends.onnx.wasm.wasmPaths = new URL('ort/', location.href).href
// Single-threaded wasm avoids needing SharedArrayBuffer / COOP-COEP headers;
// WebGPU (the fast path) doesn't use wasm threads anyway.
env.backends.onnx.wasm.numThreads = 1

const bridge = window.bridge
let pipe = null
let currentModel = ''

async function pickDevice() {
  if (!('gpu' in navigator)) return 'wasm'
  try {
    const adapter = await navigator.gpu.requestAdapter()
    return adapter ? 'webgpu' : 'wasm'
  } catch {
    return 'wasm'
  }
}

bridge.onLoadModel(async ({ model }) => {
  if (model === currentModel && pipe) {
    bridge.ready({ model })
    return
  }
  try {
    const device = await pickDevice()
    let last = 0
    pipe = await pipeline('automatic-speech-recognition', model, {
      device,
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress') {
          const pct = Math.round(p.progress || 0)
          if (pct - last >= 5) {
            last = pct
            bridge.progress({ model, progress: pct })
          }
        }
      },
    })
    // Warm-up: a throwaway inference so the user's first real dictation is fast.
    await pipe(new Float32Array(16000), { language: 'es', task: 'transcribe' })
    currentModel = model
    bridge.ready({ model })
  } catch (e) {
    pipe = null
    currentModel = ''
    bridge.error({ error: String(e?.message || e) })
  }
})

bridge.onInfer(async ({ audio, language }) => {
  if (!pipe) {
    bridge.result({ error: 'model not loaded' })
    return
  }
  try {
    const out = await pipe(new Float32Array(audio), { language: language || 'es', task: 'transcribe' })
    bridge.result({ text: (out.text || '').trim() })
  } catch (e) {
    bridge.result({ error: String(e?.message || e) })
  }
})
