import express from 'express'
import * as path from 'path'
import type { Entry, Settings } from './store'

export interface ProviderInfo {
  kind: 'cloud' | 'local'
  models: { id: string; label: string }[]
  keyPresent: boolean
}
export interface ModelStatus {
  ready: string
  loading: { model: string; progress: number } | null
  error: string
}

export interface ServerApi {
  getHistory: () => Entry[]
  clearHistory: () => void
  getSettings: () => Settings
  setSettings: (s: Settings) => void
  getProviders: () => Record<string, ProviderInfo>
  setKey: (provider: string, key: string) => void
  loadLocalModel: (model: string) => void
  getModelStatus: () => ModelStatus
  startHotkeyCapture: () => void
  openPrivacyPane: (pane: string) => void
  repaste: (text: string) => void
}

export function startServer(port: number, api: ServerApi): Promise<number> {
  const server = express()
  server.use(express.json())

  // Security: loopback only. Reject anything whose Host isn't localhost to blunt
  // DNS-rebinding from a malicious website. (Token auth comes with the packaged app.)
  server.use((req, res, next) => {
    const host = (req.headers.host || '').split(':')[0]
    if (host !== '127.0.0.1' && host !== 'localhost') {
      res.status(403).send('forbidden')
      return
    }
    next()
  })

  server.get('/api/history', (_req, res) => res.json(api.getHistory()))
  server.delete('/api/history', (_req, res) => {
    api.clearHistory()
    res.json({ ok: true })
  })

  server.get('/api/settings', (_req, res) => {
    res.json({ settings: api.getSettings(), providers: api.getProviders() })
  })
  server.post('/api/settings', (req, res) => {
    const { provider, model, language } = req.body || {}
    if (!provider || !model) {
      res.status(400).json({ error: 'provider and model required' })
      return
    }
    // Preserve the hotkey (set via /api/hotkey/capture, not this form).
    const cur = api.getSettings()
    api.setSettings({ provider, model, language: language || 'es', triggerKeycode: cur.triggerKeycode })
    res.json({ ok: true, settings: api.getSettings() })
  })

  // Store an API key (encrypted via Keychain). The key value is write-only —
  // it is never returned by any endpoint. getProviders only reports keyPresent.
  server.post('/api/keys', (req, res) => {
    const provider = String(req.body?.provider || '')
    const key = String(req.body?.key ?? '')
    if (!provider) {
      res.status(400).json({ error: 'provider required' })
      return
    }
    try {
      api.setKey(provider, key)
      res.json({ ok: true, providers: api.getProviders() })
    } catch (e) {
      res.status(500).json({ error: (e as Error).message })
    }
  })

  // Trigger a local model download+load in the inference window.
  server.post('/api/model/load', (req, res) => {
    const model = String(req.body?.model || '')
    if (!model) {
      res.status(400).json({ error: 'model required' })
      return
    }
    api.loadLocalModel(model)
    res.json({ ok: true })
  })
  server.get('/api/model/status', (_req, res) => res.json(api.getModelStatus()))

  // Arm hotkey capture: the next global keypress becomes the push-to-talk key.
  server.post('/api/hotkey/capture', (_req, res) => {
    api.startHotkeyCapture()
    res.json({ ok: true })
  })

  server.post('/api/open-privacy', (req, res) => {
    api.openPrivacyPane(String(req.body?.pane || ''))
    res.json({ ok: true })
  })

  server.post('/api/repaste', (req, res) => {
    const text = String(req.body?.text || '')
    if (text) api.repaste(text)
    res.json({ ok: !!text })
  })

  // Dedicated inference window's page (loaded over http for the web backend).
  server.use('/infer', express.static(path.join(__dirname, '..', 'infer-web')))
  server.use(express.static(path.join(__dirname, '..', 'web')))

  // Bind loopback; if the port is taken, walk forward instead of hanging.
  return new Promise((resolve, reject) => {
    let attempts = 0
    const tryListen = (p: number) => {
      const srv = server.listen(p, '127.0.0.1', () => resolve(p))
      srv.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE' && attempts < 15) {
          attempts++
          tryListen(p + 1)
        } else {
          reject(err)
        }
      })
    }
    tryListen(port)
  })
}
