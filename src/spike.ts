// T1 feasibility spike (isolated, does NOT touch the real app).
// Question it answers: in a properly-configured Electron window, do we get
// WebGPU, how fast is Whisper-small, and does the model cache persist?
//
// Window is opaque, no nodeIntegration, loaded over http (not file://) so
// transformers.js resolves the WEB backend + Cache API works.
import { app, BrowserWindow } from 'electron'
import express from 'express'
import * as path from 'path'

// Best-effort enable WebGPU (no-op if already on).
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'WebGPU')

const PORT = 8799

function startServer(): Promise<void> {
  const a = express()
  // Serve the transformers.js WEB build + the spike page.
  a.use('/vendor', express.static(path.join(__dirname, '..', 'node_modules', '@huggingface', 'transformers', 'dist')))
  a.use(express.static(path.join(__dirname, '..', 'spike-web')))
  return new Promise((r) => a.listen(PORT, '127.0.0.1', () => r()))
}

app.whenReady().then(async () => {
  await startServer()
  const win = new BrowserWindow({
    width: 760,
    height: 680,
    show: true,
    backgroundColor: '#0f1012',
    webPreferences: {
      backgroundThrottling: false, // never throttle inference
      // no nodeIntegration, no contextIsolation:false => clean web context
    },
  })
  // Forward page console to the terminal so results are visible both places.
  win.webContents.on('console-message', (_e, _lvl, msg) => console.log('[spike]', msg))
  win.loadURL(`http://127.0.0.1:${PORT}/`)
  console.log(`\n=== T1 spike === open at http://127.0.0.1:${PORT}\n`)
})

app.on('window-all-closed', () => app.quit())
