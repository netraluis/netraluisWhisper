// Preload for the dedicated inference window. contextIsolation stays ON and
// nodeIntegration OFF (so transformers.js resolves the WEB backend + WebGPU).
// This bridge is the only channel between the page and main.
import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('bridge', {
  // main -> page
  onLoadModel: (cb: (d: { model: string }) => void) =>
    ipcRenderer.on('load-model', (_e, d) => cb(d)),
  onInfer: (cb: (d: { audio: Float32Array; language: string }) => void) =>
    ipcRenderer.on('infer', (_e, d) => cb(d)),
  // page -> main
  progress: (d: { model: string; progress: number }) => ipcRenderer.send('model-progress', d),
  ready: (d: { model: string }) => ipcRenderer.send('model-ready', d),
  error: (d: { error: string }) => ipcRenderer.send('model-error', d),
  result: (d: { text?: string; error?: string }) => ipcRenderer.send('infer-result', d),
})
