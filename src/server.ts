import express from 'express'
import * as path from 'path'
import type { Entry, Settings } from './store'

export interface ServerApi {
  getHistory: () => Entry[]
  clearHistory: () => void
  getSettings: () => Settings
  setSettings: (s: Settings) => void
  getProviders: () => Record<string, { models: string[]; keyPresent: boolean }>
  repaste: (text: string) => void
}

export function startServer(port: number, api: ServerApi): Promise<void> {
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
    api.setSettings({ provider, model, language: language || 'es' })
    res.json({ ok: true, settings: api.getSettings() })
  })

  server.post('/api/repaste', (req, res) => {
    const text = String(req.body?.text || '')
    if (text) api.repaste(text)
    res.json({ ok: !!text })
  })

  server.use(express.static(path.join(__dirname, '..', 'web')))

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve())
  })
}
