// Copy the onnxruntime-web JSEP (WebGPU) runtime next to the bundled infer.js
// so the app self-hosts it instead of fetching from a CDN.
import { mkdirSync, copyFileSync } from 'node:fs'

const SRC = 'node_modules/@huggingface/transformers/dist'
const DST = 'infer-web/ort'
const FILES = ['ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']

mkdirSync(DST, { recursive: true })
for (const f of FILES) {
  copyFileSync(`${SRC}/${f}`, `${DST}/${f}`)
  console.log('copied', f)
}
