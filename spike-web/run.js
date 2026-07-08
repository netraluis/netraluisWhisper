// Spike loads the lib from CDN (fully resolved ESM). The packaged app will
// bundle it with Vite instead; CDN is fine here since we need network anyway.
import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1'

const logEl = document.getElementById('log')
const verdictEl = document.getElementById('verdict')

function log(msg, cls = '') {
  const d = document.createElement('div')
  if (cls) d.className = cls
  d.textContent = msg
  logEl.appendChild(d)
  console.log(msg)
}

async function main() {
  // 1. Is WebGPU actually available in THIS window?
  const hasGpu = 'gpu' in navigator
  log(`navigator.gpu presente: ${hasGpu ? 'sí' : 'no'}`, hasGpu ? 'ok' : 'bad')

  let adapter = null
  if (hasGpu) {
    try {
      adapter = await navigator.gpu.requestAdapter()
    } catch (e) {
      log('requestAdapter lanzó: ' + e.message, 'bad')
    }
  }
  const vendor = adapter?.info?.vendor || (adapter ? 'gpu' : '')
  log(`WebGPU adapter: ${adapter ? 'SÍ (' + vendor + ')' : 'NO'}`, adapter ? 'ok' : 'bad')

  const MODEL = 'Xenova/whisper-small'
  const device = adapter ? 'webgpu' : 'wasm'
  log(`backend a probar: ${device}`)

  // 2. Load the model (cold), showing download progress.
  let lastPct = 0
  const t0 = performance.now()
  let pipe
  try {
    pipe = await pipeline('automatic-speech-recognition', MODEL, {
      device,
      dtype: device === 'webgpu' ? 'fp32' : 'q8',
      progress_callback: (p) => {
        if (p.status === 'progress' && p.progress - lastPct > 10) {
          lastPct = p.progress
          log(`descarga modelo: ${Math.round(p.progress)}%`, 'muted')
        }
      },
    })
  } catch (e) {
    log(`falló con ${device}: ${e.message} — reintento con wasm`, 'bad')
    pipe = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: 'q8' })
  }
  const loadMs = Math.round(performance.now() - t0)
  log(`modelo listo en ${(loadMs / 1000).toFixed(1)}s`, 'ok')

  // 3. Inference on a synthetic 3s clip (measures compute, not accuracy).
  const audio = new Float32Array(16000 * 3)
  for (let i = 0; i < audio.length; i++) audio[i] = Math.sin(i / 18) * 0.05

  const t1 = performance.now()
  await pipe(audio, { language: 'es', task: 'transcribe' })
  const infMs = Math.round(performance.now() - t1)
  log(`inferencia (3s de audio): ${(infMs / 1000).toFixed(2)}s`, infMs < 4000 ? 'ok' : 'bad')

  // 4. Warm second run.
  const t2 = performance.now()
  await pipe(audio, { language: 'es', task: 'transcribe' })
  log(`inferencia 2 (en caliente): ${((performance.now() - t2) / 1000).toFixed(2)}s`, 'muted')

  // Verdict
  const gpuOk = !!adapter
  const fast = infMs < 4000
  if (gpuOk && fast) {
    verdictEl.textContent = '✅ VIABLE — WebGPU disponible y rápido. Plan A sigue.'
    verdictEl.className = 'big ok'
  } else if (gpuOk) {
    verdictEl.textContent = '⚠️ WebGPU sí, pero lento. Probar modelo menor o revisar.'
    verdictEl.className = 'big bad'
  } else {
    verdictEl.textContent = '❌ Sin WebGPU (cae a WASM). Considerar plan B/C.'
    verdictEl.className = 'big bad'
  }
  log('CACHE: cierra y vuelve a lanzar `npm run spike` — la descarga debería saltarse si cachea bien.', 'muted')
}

main().catch((e) => {
  log('ERROR: ' + (e?.message || e), 'bad')
  verdictEl.textContent = '❌ Error en el spike'
  verdictEl.className = 'big bad'
})
