import { app, BrowserWindow, ipcMain, clipboard, systemPreferences, screen, Tray, Menu, nativeImage, shell } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { exec } from 'child_process'
import * as path from 'path'
import * as dotenv from 'dotenv'
import {
  addEntry, loadSettings, saveSettings, loadHistory, clearHistory,
  saveKey, getKey, hasKey, type Settings,
} from './store'
import { startServer } from './server'
import { encodeWav } from './wav'

dotenv.config()

// WebGPU for the local inference window (no-op if already enabled).
app.commandLine.appendSwitch('enable-unsafe-webgpu')
app.commandLine.appendSwitch('enable-features', 'WebGPU')

// --- STT engines. Two kinds:
//   cloud: HTTP API + your key (Groq/OpenAI)
//   local: on-device Whisper via transformers.js in a dedicated window ---
interface Model { id: string; label: string }
type Provider =
  | { kind: 'cloud'; base: string; keyEnv: string; models: Model[] }
  | { kind: 'local'; models: Model[] }

const PROVIDERS: Record<string, Provider> = {
  local: {
    kind: 'local',
    models: [
      { id: 'Xenova/whisper-tiny', label: 'tiny (~40MB, rápido)' },
      { id: 'Xenova/whisper-base', label: 'base (~80MB)' },
      { id: 'Xenova/whisper-small', label: 'small (~250MB, recomendado)' },
      { id: 'onnx-community/whisper-large-v3-turbo', label: 'large-v3-turbo (~1.6GB)' },
    ],
  },
  groq: {
    kind: 'cloud',
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    models: [
      { id: 'whisper-large-v3-turbo', label: 'whisper-large-v3-turbo' },
      { id: 'whisper-large-v3', label: 'whisper-large-v3' },
      { id: 'distil-whisper-large-v3-en', label: 'distil-whisper-large-v3-en' },
    ],
  },
  openai: {
    kind: 'cloud',
    base: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: [
      { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe' },
      { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe' },
      { id: 'whisper-1', label: 'whisper-1' },
    ],
  },
}

const SAMPLE_RATE = 16000

const DEFAULT_SETTINGS: Settings = {
  provider: (process.env.STT_PROVIDER || 'groq').toLowerCase(),
  model: process.env.GROQ_MODEL || 'whisper-large-v3-turbo',
  language: process.env.STT_LANG || 'es',
  triggerKeycode: Number(process.env.TRIGGER_KEYCODE || 3676), // Right Cmd default
}
let settings: Settings = { ...DEFAULT_SETTINGS }

const DEBUG_KEYS = process.env.DEBUG_KEYS === '1'
const PORT = Number(process.env.PORT || 8765)
let captureHotkey = false // when true, next keypress sets the trigger key
let updateInfo: { latest: string; url: string } | null = null

const REPO = 'netraluis/netraluisWhisper'

function isNewer(latest: string, current: string): boolean {
  const a = latest.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const b = current.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

// Check GitHub for a newer release. Silent on any failure (offline, rate limit).
async function checkForUpdate() {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'User-Agent': 'netraluisWhisper', Accept: 'application/vnd.github+json' },
    })
    if (!res.ok) return
    const data = (await res.json()) as { tag_name?: string; html_url?: string }
    const latest = (data.tag_name || '').replace(/^v/, '')
    if (latest && isNewer(latest, app.getVersion())) {
      updateInfo = { latest, url: data.html_url || `https://github.com/${REPO}/releases/latest` }
      console.log('[update] nueva versión disponible:', latest)
    }
  } catch {
    /* offline / rate-limited: ignore */
  }
}

let win: BrowserWindow | null = null // overlay pill + mic
let inferWin: BrowserWindow | null = null // dedicated local-inference window
let configWin: BrowserWindow | null = null // the config/history UI (own window, no browser)
let tray: Tray | null = null
let boundPort = 8765
let quitting = false
let recording = false
let pendingApp = ''

// Local inference state (reported by inferWin).
let inferReadyModel = '' // which model is currently loaded+warm
let inferBackend = '' // webgpu | wasm — reported by the inference window
let inferLoading: { model: string; progress: number } | null = null
let inferError = ''
let pendingInfer: ((r: { text?: string; error?: string }) => void) | null = null

function createOverlay() {
  win = new BrowserWindow({
    width: 240, height: 72, show: false, frame: false, transparent: true,
    hasShadow: false, resizable: false, focusable: false, skipTaskbar: true,
    alwaysOnTop: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.setIgnoreMouseEvents(true)
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  win.setBounds({ x: Math.round(width / 2 - 120), y: height - 100, width: 240, height: 72 })
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'))
}

let inferRelaunches = 0
function createInferWindow() {
  // Opaque, no nodeIntegration, http origin => web backend + WebGPU + model cache.
  inferWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'infer-preload.js'),
      backgroundThrottling: false,
    },
  })
  inferWin.loadURL(`http://127.0.0.1:${boundPort}/infer/`)

  // Resilience: a big model can crash the render process (GPU device-loss / OOM).
  // Don't die silently — reset state, tell the user, and relaunch the window.
  inferWin.webContents.on('render-process-gone', (_e, details) => {
    console.error('[local] inference window crashed:', details.reason)
    const msg = 'El modelo se quedó sin memoria. Prueba uno menor.'
    inferReadyModel = ''
    inferBackend = ''
    inferLoading = null
    inferError = msg
    if (pendingInfer) {
      const cb = pendingInfer
      pendingInfer = null
      cb({ error: msg })
    }
    if (inferRelaunches < 5) {
      inferRelaunches++
      setTimeout(() => { try { inferWin?.destroy() } catch {} ; createInferWindow() }, 500)
    }
  })
}

// The config/history UI, in the app's own window (no external browser).
function createConfigWindow() {
  configWin = new BrowserWindow({
    width: 900, height: 720, show: false, title: 'netraluisWhisper',
    backgroundColor: '#0f1012',
  })
  configWin.loadURL(`http://127.0.0.1:${boundPort}/`)
  // Show only once the UI is painted, then pull it to the front. Without the
  // explicit focus the window opens behind other apps and users think nothing
  // happened (the app is menubar-based, so there's no other visible cue).
  configWin.once('ready-to-show', () => {
    if (!configWin || configWin.isDestroyed()) return
    configWin.center()
    configWin.show()
    configWin.focus()
    if (process.platform === 'darwin') app.focus({ steal: true })
  })
  configWin.on('close', (e) => {
    // Closing the window keeps the app running (menubar); only quit via tray.
    if (!quitting) {
      e.preventDefault()
      configWin?.hide()
    }
  })
}

function showConfig() {
  if (!configWin || configWin.isDestroyed()) createConfigWindow()
  else { configWin.show(); configWin.focus() }
  if (process.platform === 'darwin') app.focus({ steal: true })
}

// Menubar icon (monochrome waveform, template image so macOS tints it to match
// light/dark). 16px base + 32px @2x for retina. A real icon renders more
// reliably than an emoji title, which some menubars drop behind the notch.
const TRAY_ICON_16 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAMUlEQVR4nGNgoDH4D8X0NQBZE1UNwGsYMZqoagCGYaMGoAKyNFHVAFyGkQUoNoAgAABVTFepQ3tMgAAAAABJRU5ErkJggg=='
const TRAY_ICON_32 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAQklEQVR4nO3OOQ4AMAgDQf7/aWhTpEGQiGNXcu0RoVh6DMB8wO2sJOAZahcgclYS4EYBAAAAwDhASgDaAL4GAED/DInuBwjSPaGpAAAAAElFTkSuQmCC'

function trayIcon() {
  const img = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_16, 'base64'))
  img.addRepresentation({ scaleFactor: 2, buffer: Buffer.from(TRAY_ICON_32, 'base64') })
  img.setTemplateImage(true)
  return img
}

function setupTray() {
  tray = new Tray(trayIcon())
  tray.setToolTip('netraluisWhisper')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir netraluisWhisper', click: () => showConfig() },
      { type: 'separator' },
      { label: 'Salir', click: () => { quitting = true; cleanupAndQuit() } },
    ])
  )
  tray.on('click', () => showConfig())
}

function cleanupAndQuit() {
  try { uIOhook.stop() } catch {}
  app.quit()
}

function showOverlay(state: 'recording' | 'transcribing') {
  if (!win) return
  win.webContents.send('state', state)
  win.showInactive()
}
function hideOverlay() {
  win?.webContents.send('state', 'idle')
  win?.hide()
}
// Success confirmation: flash "Pegado ✓" briefly, then hide.
function doneOverlay() {
  if (!win) return
  win.webContents.send('state', 'done')
  win.showInactive()
  setTimeout(() => hideOverlay(), 950)
}
// Hard-stop, visible: flash the reason in the pill, then hide.
function errorOverlay(msg: string) {
  if (!win) return
  win.webContents.send('state', 'error', msg)
  win.showInactive()
  setTimeout(() => hideOverlay(), 2800)
}

// Single instance: a second launch just focuses the running app (avoids
// double-binding the port + global hotkey).
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showConfig())
  // Clicking the Dock icon (macOS) reopens the config window. The Dock icon is
  // the reliable reopen path: unlike the menubar item, a notch can't hide it.
  app.on('activate', () => showConfig())

  app.whenReady().then(async () => {
    settings = loadSettings(DEFAULT_SETTINGS)
    if (process.platform === 'darwin') {
      try {
        await systemPreferences.askForMediaAccess('microphone')
      } catch {}
    }
    await startWebUi() // server must be up before windows load their URLs
    createOverlay()
    createInferWindow()
    setupInferIpc()
    setupHotkey()
    setupTray()
    createConfigWindow() // show the UI in our own window on launch
    banner()
    checkForUpdate() // non-blocking; result surfaced in the UI if newer
  })
}

// --- Local inference IPC (with the dedicated window) ---
function setupInferIpc() {
  ipcMain.on('model-progress', (_e, d: { model: string; progress: number }) => {
    inferLoading = d
  })
  ipcMain.on('model-ready', (_e, d: { model: string; device?: string }) => {
    inferReadyModel = d.model
    inferBackend = d.device || ''
    inferLoading = null
    inferError = ''
    console.log(`[local] model ready: ${d.model}${d.device ? ' [' + d.device + ']' : ''}`)
  })
  ipcMain.on('model-error', (_e, d: { error: string }) => {
    inferLoading = null
    inferError = d.error
    console.error('[local] model error:', d.error)
  })
  ipcMain.on('infer-result', (_e, r: { text?: string; error?: string }) => {
    const cb = pendingInfer
    pendingInfer = null
    cb?.(r)
  })
  ipcMain.on('cache-cleared', (_e, d: { model: string }) => {
    console.log('[local] cache cleared, re-downloading', d.model)
    inferReadyModel = ''
    loadLocalModel(d.model) // fresh download + load
  })
}

// Wipe the model cache and re-download (repairs a corrupt/interrupted download).
function resetLocalModel(model: string) {
  if (!inferWin) return
  inferError = ''
  inferReadyModel = inferReadyModel === model ? '' : inferReadyModel
  inferLoading = { model, progress: 0 }
  inferWin.webContents.send('clear-cache', { model })
}

function loadLocalModel(model: string) {
  if (!inferWin) return
  inferError = ''
  inferLoading = { model, progress: 0 }
  inferReadyModel = inferReadyModel === model ? inferReadyModel : ''
  inferWin.webContents.send('load-model', { model })
}

function localInfer(pcm: Float32Array, language: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!inferWin) return reject(new Error('inference window missing'))
    if (pendingInfer) return reject(new Error('otra transcripción en curso'))
    pendingInfer = (r) => (r.error ? reject(new Error(r.error)) : resolve(r.text || ''))
    inferWin.webContents.send('infer', { audio: pcm, language })
  })
}

function firstCloudWithKey(): string {
  for (const [name, p] of Object.entries(PROVIDERS)) {
    if (p.kind === 'cloud' && hasKey(name)) return name
  }
  return ''
}

async function cloudTranscribe(
  pcm: Float32Array, providerName: string, model: string, language: string
): Promise<string> {
  const p = PROVIDERS[providerName]
  if (!p || p.kind !== 'cloud') throw new Error(`not a cloud provider: ${providerName}`)
  // Keys come only from the UI (Keychain). No .env fallback => no secret ever
  // lives in a file that could ship inside the packaged app.
  const key = getKey(providerName)
  if (!key) throw new Error(`Falta la API key de ${providerName} (métela en Ajustes)`)

  const wav = encodeWav(pcm, SAMPLE_RATE)
  const ab = wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
  const form = new FormData()
  form.append('file', new Blob([ab], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  form.append('language', language)
  form.append('response_format', 'json')

  const res = await fetch(`${p.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) {
    const body = await res.text()
    console.error(`[${providerName}] ${res.status}: ${body}`) // full detail for debugging
    throw new Error(friendlyHttpError(providerName, res.status))
  }
  const data = (await res.json()) as { text?: string }
  return (data.text || '').trim()
}

// Turn a provider HTTP status into a short, clear message for the overlay.
function friendlyHttpError(provider: string, status: number): string {
  if (status === 401 || status === 403) return `Key de ${provider} incorrecta o sin permiso`
  if (status === 429) return `${provider}: sin crédito o límite alcanzado`
  if (status === 400) return `${provider}: petición rechazada (revisa el modelo)`
  if (status >= 500) return `${provider} no disponible, reintenta`
  return `${provider}: error ${status}`
}

async function startWebUi() {
  boundPort = await startServer(PORT, {
    getHistory: () => loadHistory(),
    clearHistory: () => clearHistory(),
    getSettings: () => settings,
    setSettings: (s) => {
      settings = s
      saveSettings(s)
      console.log('[settings]', s.provider, s.model, s.language)
    },
    getProviders: () =>
      Object.fromEntries(
        Object.entries(PROVIDERS).map(([name, p]) => [
          name,
          {
            kind: p.kind,
            models: p.models,
            keyPresent: p.kind === 'local' ? true : hasKey(name),
          },
        ])
      ),
    setKey: (provider, key) => saveKey(provider, key),
    loadLocalModel: (model) => loadLocalModel(model),
    resetLocalModel: (model) => resetLocalModel(model),
    getModelStatus: () => ({ ready: inferReadyModel, loading: inferLoading, error: inferError }),
    startHotkeyCapture: () => { captureHotkey = true },
    openPrivacyPane: (pane) => openPrivacyPane(pane),
    getUpdate: () => ({
      current: app.getVersion(),
      updateAvailable: !!updateInfo,
      latest: updateInfo?.latest || '',
      url: updateInfo?.url || '',
    }),
    openReleasePage: () => {
      if (updateInfo?.url) shell.openExternal(updateInfo.url)
    },
    repaste: (text) => repasteWithDelay(text),
  })
  console.log('web UI (own window):', `http://127.0.0.1:${boundPort}`)
}

function banner() {
  const p = PROVIDERS[settings.provider]
  console.log('\n=== netraluisWhisper ===')
  console.log(`trigger keycode : ${settings.triggerKeycode} (hold to talk)`)
  console.log(`engine          : ${settings.provider} (${p?.kind})  model: ${settings.model}  lang: ${settings.language}`)
  console.log(`web UI          : http://127.0.0.1:${boundPort} (in-app window + menubar 🎙)`)
  console.log('Hold the trigger key, speak, release. Grant Mic + Input Monitoring + Accessibility.\n')
}

// Jump the user straight to the right macOS privacy pane (onboarding).
function openPrivacyPane(pane: string) {
  const panes: Record<string, string> = {
    microphone: 'Privacy_Microphone',
    accessibility: 'Privacy_Accessibility',
    input: 'Privacy_ListenEvent',
  }
  const anchor = panes[pane]
  if (!anchor) return
  exec(`open "x-apple.systempreferences:com.apple.preference.security?${anchor}"`)
}

function getFrontApp(): Promise<string> {
  return new Promise((res) => {
    exec(
      `osascript -e 'tell application "System Events" to get name of first process whose frontmost is true'`,
      (err, out) => res(err ? '' : out.trim())
    )
  })
}

function setupHotkey() {
  uIOhook.on('keydown', (e) => {
    if (DEBUG_KEYS) console.log('[keydown] keycode =', e.keycode)
    // Hotkey-capture mode: the next key the user presses becomes the trigger.
    if (captureHotkey) {
      captureHotkey = false
      settings = { ...settings, triggerKeycode: e.keycode }
      saveSettings(settings)
      console.log('[hotkey] trigger set to keycode', e.keycode)
      return
    }
    if (e.keycode === settings.triggerKeycode && !recording) {
      recording = true
      pendingApp = ''
      getFrontApp().then((a) => (pendingApp = a))
      showOverlay('recording')
      win?.webContents.send('start-recording')
      console.log('recording...')
    }
  })
  uIOhook.on('keyup', (e) => {
    if (e.keycode === settings.triggerKeycode && recording) {
      recording = false
      showOverlay('transcribing')
      win?.webContents.send('stop-recording')
      console.log('stopped, transcribing...')
    }
  })
  uIOhook.start()
}

ipcMain.on('audio-pcm', async (_evt, buf: ArrayBuffer, len: number) => {
  const ab: ArrayBuffer = buf instanceof ArrayBuffer ? buf : (buf as any).buffer
  const pcm = new Float32Array(ab, 0, len || undefined)
  if (pcm.length < 1600) {
    console.log('(recording too short, skipped)')
    hideOverlay()
    return
  }
  const provider = PROVIDERS[settings.provider]
  let usedProvider = settings.provider
  let usedModel = settings.model
  const audioSec = pcm.length / SAMPLE_RATE
  const t0 = Date.now()
  try {
    let text = ''
    if (provider?.kind === 'local') {
      if (inferReadyModel === settings.model) {
        text = await localInfer(pcm, settings.language)
      } else {
        // D3: model not ready — fall back to cloud if a key exists, else tell user.
        const cloud = firstCloudWithKey()
        if (cloud) {
          const cp = PROVIDERS[cloud] as Extract<Provider, { kind: 'cloud' }>
          usedProvider = cloud
          usedModel = cp.models[0].id
          console.log('[local] model not ready -> falling back to', cloud)
          text = await cloudTranscribe(pcm, cloud, usedModel, settings.language)
        } else {
          throw new Error('modelo local no activado — actívalo en Ajustes (o añade una key cloud)')
        }
      }
    } else {
      text = await cloudTranscribe(pcm, settings.provider, settings.model, settings.language)
    }

    if (text) {
      const ms = Date.now() - t0
      pasteText(text)
      const words = text.trim().split(/\s+/).filter(Boolean).length
      addEntry({
        ts: Date.now(), text, provider: usedProvider, model: usedModel,
        lang: settings.language, ms, appName: pendingApp || undefined,
      })
      const backend = usedProvider === 'local' && inferBackend ? ` [${inferBackend}]` : ''
      console.log(
        `[stt] ${usedProvider}/${usedModel} · ${audioSec.toFixed(1)}s audio → ${ms}ms · ${words} palabras${backend}`
      )
      doneOverlay() // "Pegado ✓"
    } else {
      console.log('(no speech detected)')
      hideOverlay()
    }
  } catch (err) {
    const msg = (err as Error).message
    console.error('transcribe error:', msg)
    errorOverlay(msg) // hard-stop, visible to the user (not a silent failure)
  }
})

function sendCmdV(cb?: () => void) {
  const script = 'tell application "System Events" to keystroke "v" using command down'
  exec(`osascript -e '${script}'`, (err) => {
    if (err) console.error('paste failed (grant Accessibility):', err.message)
    cb?.()
  })
}

function pasteText(text: string) {
  const prev = clipboard.readText()
  clipboard.writeText(text)
  sendCmdV(() => setTimeout(() => clipboard.writeText(prev), 600))
}

function repasteWithDelay(text: string, delayMs = 2000) {
  clipboard.writeText(text)
  setTimeout(() => sendCmdV(), delayMs)
}

app.on('window-all-closed', () => {})
process.on('SIGINT', () => {
  try { uIOhook.stop() } catch {}
  app.quit()
})
