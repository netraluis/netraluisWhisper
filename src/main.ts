import { app, BrowserWindow, ipcMain, clipboard, systemPreferences, screen, shell } from 'electron'
import { uIOhook } from 'uiohook-napi'
import { exec } from 'child_process'
import * as path from 'path'
import * as dotenv from 'dotenv'
import { addEntry, loadSettings, saveSettings, loadHistory, clearHistory, type Settings } from './store'
import { startServer } from './server'

dotenv.config()

// --- STT providers (pluggable). Keys stay in env/Keychain; provider+model+lang
// are chosen from the web UI at runtime. ---
interface ProviderMeta { base: string; keyEnv: string; models: string[] }
const PROVIDER_META: Record<string, ProviderMeta> = {
  groq: {
    base: 'https://api.groq.com/openai/v1',
    keyEnv: 'GROQ_API_KEY',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'],
  },
  openai: {
    base: 'https://api.openai.com/v1',
    keyEnv: 'OPENAI_API_KEY',
    models: ['gpt-4o-transcribe', 'gpt-4o-mini-transcribe', 'whisper-1'],
  },
}

const DEFAULT_SETTINGS: Settings = {
  provider: (process.env.STT_PROVIDER || 'groq').toLowerCase(),
  model: process.env.GROQ_MODEL || process.env.OPENAI_MODEL || 'whisper-large-v3-turbo',
  language: process.env.STT_LANG || 'es',
}
let settings: Settings = { ...DEFAULT_SETTINGS }

const TRIGGER_KEYCODE = Number(process.env.TRIGGER_KEYCODE || 3676) // Right Cmd
const DEBUG_KEYS = process.env.DEBUG_KEYS === '1'
const PORT = Number(process.env.PORT || 8765)

let win: BrowserWindow | null = null
let recording = false
let pendingApp = '' // frontmost app captured at record start

function createWindow() {
  // Visible overlay pill that ALSO runs getUserMedia. focusable:false +
  // showInactive() => never steals focus, so paste lands in your real app.
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

function showOverlay(state: 'recording' | 'transcribing') {
  if (!win) return
  win.webContents.send('state', state)
  win.showInactive()
}
function hideOverlay() {
  win?.webContents.send('state', 'idle')
  win?.hide()
}

app.whenReady().then(async () => {
  settings = loadSettings(DEFAULT_SETTINGS)
  if (process.platform === 'darwin') {
    try {
      const ok = await systemPreferences.askForMediaAccess('microphone')
      console.log('[perm] microphone access:', ok)
    } catch (e) {
      console.log('[perm] microphone request failed:', e)
    }
  }
  createWindow()
  setupHotkey()
  await startWebUi()
  banner()
})

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
        Object.entries(PROVIDER_META).map(([name, m]) => [
          name,
          { models: m.models, keyPresent: !!process.env[m.keyEnv] },
        ])
      ),
    repaste: (text) => repasteWithDelay(text),
  })
  const url = `http://127.0.0.1:${PORT}`
  console.log('web UI:', url)
  shell.openExternal(url)
}

function banner() {
  const m = PROVIDER_META[settings.provider]
  console.log('\n=== netraluisWhisper ===')
  console.log(`trigger keycode : ${TRIGGER_KEYCODE} (hold to talk)`)
  console.log(`provider        : ${settings.provider}  model: ${settings.model}  lang: ${settings.language}`)
  console.log(`api key         : ${m && process.env[m.keyEnv] ? 'set' : `MISSING for ${settings.provider}`}`)
  console.log(`web UI          : http://127.0.0.1:${PORT}`)
  console.log('Hold Right-Cmd, speak, release. Grant Mic + Input Monitoring + Accessibility.\n')
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
    if (e.keycode === TRIGGER_KEYCODE && !recording) {
      recording = true
      pendingApp = ''
      getFrontApp().then((a) => (pendingApp = a))
      showOverlay('recording')
      win?.webContents.send('start-recording')
      console.log('recording...')
    }
  })
  uIOhook.on('keyup', (e) => {
    if (e.keycode === TRIGGER_KEYCODE && recording) {
      recording = false
      showOverlay('transcribing')
      win?.webContents.send('stop-recording')
      console.log('stopped, transcribing...')
    }
  })
  uIOhook.start()
}

ipcMain.on('audio-data', async (_evt, buf: ArrayBuffer) => {
  const bytes = Buffer.from(buf)
  if (bytes.length < 1200) {
    console.log('(recording too short / empty, skipped)')
    hideOverlay()
    return
  }
  const t0 = Date.now()
  try {
    const text = await transcribe(bytes)
    const ms = Date.now() - t0
    if (text) {
      pasteText(text)
      addEntry({
        ts: Date.now(),
        text,
        provider: settings.provider,
        model: settings.model,
        lang: settings.language,
        ms,
        appName: pendingApp || undefined,
      })
      console.log('pasted:', JSON.stringify(text))
    } else {
      console.log('(no speech detected)')
    }
  } catch (err) {
    console.error('transcribe error:', (err as Error).message)
  } finally {
    hideOverlay()
  }
})

async function transcribe(bytes: Buffer): Promise<string> {
  const m = PROVIDER_META[settings.provider]
  if (!m) throw new Error(`unknown provider '${settings.provider}'`)
  const key = process.env[m.keyEnv]
  if (!key) throw new Error(`API key missing for '${settings.provider}' (.env: ${m.keyEnv})`)

  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const form = new FormData()
  form.append('file', new Blob([ab], { type: 'audio/webm' }), 'audio.webm')
  form.append('model', settings.model)
  form.append('language', settings.language)
  form.append('response_format', 'json')

  const res = await fetch(`${m.base}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  })
  if (!res.ok) throw new Error(`${settings.provider} ${res.status}: ${await res.text()}`)
  const data = (await res.json()) as { text?: string }
  return (data.text || '').trim()
}

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

// Re-paste from the web UI: the browser has focus, so give the user ~2s to
// switch to the target app before the synthetic Cmd+V fires. Clipboard is left
// with the text (no restore) so a manual paste also works.
function repasteWithDelay(text: string, delayMs = 2000) {
  clipboard.writeText(text)
  setTimeout(() => sendCmdV(), delayMs)
}

app.on('window-all-closed', () => {})
process.on('SIGINT', () => {
  try { uIOhook.stop() } catch {}
  app.quit()
})
