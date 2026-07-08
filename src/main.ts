import { app, BrowserWindow, ipcMain, clipboard, systemPreferences, screen, shell } from 'electron'
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

let win: BrowserWindow | null = null // overlay pill + mic
let inferWin: BrowserWindow | null = null // dedicated local-inference window
let recording = false
let pendingApp = ''

// Local inference state (reported by inferWin).
let inferReadyModel = '' // which model is currently loaded+warm
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

function createInferWindow() {
  // Opaque, no nodeIntegration, http origin => web backend + WebGPU + model cache.
  inferWin = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'infer-preload.js'),
      backgroundThrottling: false,
    },
  })
  inferWin.loadURL(`http://127.0.0.1:${PORT}/infer/`)
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
// Hard-stop, visible: flash the reason in the pill, then hide.
function errorOverlay(msg: string) {
  if (!win) return
  win.webContents.send('state', 'error', msg)
  win.showInactive()
  setTimeout(() => hideOverlay(), 2800)
}

app.whenReady().then(async () => {
  settings = loadSettings(DEFAULT_SETTINGS)
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.askForMediaAccess('microphone')
    } catch {}
  }
  await startWebUi() // server must be up before inferWin loads its URL
  createOverlay()
  createInferWindow()
  setupInferIpc()
  setupHotkey()
  banner()
})

// --- Local inference IPC (with the dedicated window) ---
function setupInferIpc() {
  ipcMain.on('model-progress', (_e, d: { model: string; progress: number }) => {
    inferLoading = d
  })
  ipcMain.on('model-ready', (_e, d: { model: string }) => {
    inferReadyModel = d.model
    inferLoading = null
    inferError = ''
    console.log('[local] model ready:', d.model)
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
  if (!res.ok) throw new Error(`${providerName} ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { text?: string }
  return (data.text || '').trim()
}

async function startWebUi() {
  await startServer(PORT, {
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
    getModelStatus: () => ({ ready: inferReadyModel, loading: inferLoading, error: inferError }),
    startHotkeyCapture: () => { captureHotkey = true },
    repaste: (text) => repasteWithDelay(text),
  })
  const url = `http://127.0.0.1:${PORT}`
  console.log('web UI:', url)
  shell.openExternal(url)
}

function banner() {
  const p = PROVIDERS[settings.provider]
  console.log('\n=== netraluisWhisper ===')
  console.log(`trigger keycode : ${settings.triggerKeycode} (hold to talk)`)
  console.log(`engine          : ${settings.provider} (${p?.kind})  model: ${settings.model}  lang: ${settings.language}`)
  console.log(`web UI          : http://127.0.0.1:${PORT}`)
  console.log('Hold the trigger key, speak, release. Grant Mic + Input Monitoring + Accessibility.\n')
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
      pasteText(text)
      addEntry({
        ts: Date.now(), text, provider: usedProvider, model: usedModel,
        lang: settings.language, ms: 0, appName: pendingApp || undefined,
      })
      console.log('pasted:', JSON.stringify(text))
    } else {
      console.log('(no speech detected)')
    }
    hideOverlay()
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
