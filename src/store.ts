import { app, safeStorage } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// Local persistence. JSON for the spike; swap to SQLite (better-sqlite3) in v0.2.
// Lives in the OS app-data dir, NOT in the repo.
const DIR = app.getPath('userData')
const HISTORY_FILE = path.join(DIR, 'history.json')
const SETTINGS_FILE = path.join(DIR, 'settings.json')
const KEYS_FILE = path.join(DIR, 'keys.enc.json') // encrypted API keys (Keychain-backed)

export interface Entry {
  id: number
  ts: number // epoch ms
  text: string
  provider: string
  model: string
  lang: string
  ms: number // transcription latency
  appName?: string // frontmost app when dictated
}

export interface Settings {
  provider: string
  model: string
  language: string
  triggerKeycode: number // uiohook keycode for push-to-talk
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, data: unknown) {
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file) // atomic-ish
}

export function loadHistory(): Entry[] {
  return readJson<Entry[]>(HISTORY_FILE, [])
}

export function addEntry(e: Omit<Entry, 'id'>): Entry {
  const h = loadHistory()
  const entry: Entry = { ...e, id: (h[0]?.id ?? 0) + 1 }
  h.unshift(entry) // newest first
  if (h.length > 2000) h.length = 2000
  writeJson(HISTORY_FILE, h)
  return entry
}

export function clearHistory() {
  writeJson(HISTORY_FILE, [])
}

export function loadSettings(def: Settings): Settings {
  return { ...def, ...readJson<Partial<Settings>>(SETTINGS_FILE, {}) }
}

export function saveSettings(s: Settings) {
  writeJson(SETTINGS_FILE, s)
}

// --- API keys: encrypted at rest via Electron safeStorage (macOS Keychain-backed).
// Keys are never stored in plaintext and never returned to the web UI. ---
export function saveKey(provider: string, key: string) {
  const all = readJson<Record<string, string>>(KEYS_FILE, {})
  const trimmed = key.trim()
  if (!trimmed) {
    delete all[provider]
  } else {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('OS encryption unavailable — cannot store key securely')
    }
    all[provider] = safeStorage.encryptString(trimmed).toString('base64')
  }
  writeJson(KEYS_FILE, all)
}

export function getKey(provider: string): string {
  const all = readJson<Record<string, string>>(KEYS_FILE, {})
  const enc = all[provider]
  if (!enc) return ''
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return '' // corrupt/undecryptable — treat as absent
  }
}

export function hasKey(provider: string): boolean {
  return getKey(provider).length > 0
}
