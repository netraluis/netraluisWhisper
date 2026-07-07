import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

// Local persistence. JSON for the spike; swap to SQLite (better-sqlite3) in v0.2.
// Lives in the OS app-data dir, NOT in the repo.
const DIR = app.getPath('userData')
const HISTORY_FILE = path.join(DIR, 'history.json')
const SETTINGS_FILE = path.join(DIR, 'settings.json')

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
