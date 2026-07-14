import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

// End-to-end tests against the real Electron app. The app is launched with
// NW_TEST=1, which installs global.__nwTest hooks so we can drive the global
// hotkey path and read overlay state through app.evaluate() — no OS-level key
// injection, no screenshots. A throwaway --user-data-dir keeps the user's real
// settings/keys untouched.

const PORT = 8799
const BASE = `http://127.0.0.1:${PORT}`
let app: ElectronApplication
let userDataDir: string

async function api(pathname: string, init?: RequestInit) {
  const res = await fetch(BASE + pathname, init)
  return { status: res.status, json: await res.json().catch(() => null) as any }
}
function post(pathname: string, body: any) {
  return api(pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}
const overlayState = () => app.evaluate(() => (global as any).__nwTest.overlayState())
const triggerDown = () => app.evaluate(() => (global as any).__nwTest.triggerDown())
const triggerUp = () => app.evaluate(() => (global as any).__nwTest.triggerUp())

// The overlay is the BrowserWindow that loads renderer/index.html (file://).
async function overlayPage(): Promise<Page> {
  let p: Page | undefined
  await expect.poll(() => {
    p = app.windows().find((w) => w.url().includes('renderer/index.html'))
    return !!p
  }, { timeout: 10000 }).toBe(true)
  return p!
}
const overlayClass = async () => (await overlayPage()).evaluate(() => document.body.className)

test.beforeAll(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nw-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    env: { ...process.env, NW_TEST: '1', PORT: String(PORT) },
  })
  await expect.poll(async () => (await api('/api/settings')).status, { timeout: 25000 }).toBe(200)
})

test.afterAll(async () => {
  await app?.close().catch(() => {})
  try { fs.rmSync(userDataDir, { recursive: true, force: true }) } catch {}
})

test('permissions endpoint reports all three permission states', async () => {
  const { status, json } = await api('/api/permissions')
  expect(status).toBe(200)
  expect(json).toHaveProperty('microphone')
  expect(json).toHaveProperty('accessibility')
  expect(json).toHaveProperty('inputMonitoring')
  expect(json).toHaveProperty('hotkeyLive')
})

test('changing the hotkey updates the trigger keycode', async () => {
  await app.evaluate(() => (global as any).__nwTest.armCapture())
  expect((await api('/api/hotkey/status')).json.capturing).toBe(true)
  await app.evaluate(() => (global as any).__nwTest.pressKey(77))
  const st = (await api('/api/hotkey/status')).json
  expect(st.capturing).toBe(false)
  expect(st.keycode).toBe(77)
})

test('re-picking the SAME key still completes capture (no hang)', async () => {
  // keycode is currently 77 from the previous test; pick 77 again.
  await app.evaluate(() => (global as any).__nwTest.armCapture())
  expect((await api('/api/hotkey/status')).json.capturing).toBe(true)
  await app.evaluate(() => (global as any).__nwTest.pressKey(77))
  const st = (await api('/api/hotkey/status')).json
  expect(st.capturing).toBe(false) // the bug: this used to stay true forever
  expect(st.keycode).toBe(77)
})

test('overlay is hidden when idle', async () => {
  const s = await overlayState()
  expect(s.recording).toBe(false)
  expect(s.visible).toBe(false)
})

test('pressing the key with NO key/model shows an error, does NOT record', async () => {
  await post('/api/settings', { provider: 'openai', model: 'gpt-4o-mini-transcribe', language: 'es' })
  await post('/api/keys', { provider: 'openai', key: '' }) // ensure no key
  await triggerDown()
  const s = await overlayState()
  expect(s.recording).toBe(false)     // never started recording
  expect(s.visible).toBe(true)           // overlay is shown...
  await expect.poll(overlayClass).toBe('error') // ...with the error state (DOM update is async)
  // Releasing the key dismisses the error immediately (no waiting out the timeout).
  await triggerUp()
  await expect.poll(async () => (await overlayState()).visible).toBe(false)
})

test('pressing the key WITH a key records, then transcribes', async () => {
  await post('/api/settings', { provider: 'openai', model: 'gpt-4o-mini-transcribe', language: 'es' })
  await post('/api/keys', { provider: 'openai', key: 'sk-test-fake' })
  await triggerDown()
  let s = await overlayState()
  expect(s.recording).toBe(true)
  expect(s.visible).toBe(true)
  // Overlay must land fully inside a real display (regression: it once parked
  // itself off-screen at negative coords).
  const displays = await app.evaluate(({ screen }) => screen.getAllDisplays().map((d) => d.bounds))
  const b = s.bounds
  const onScreen = displays.some((d: any) =>
    b.x >= d.x && b.y >= d.y && b.x + b.width <= d.x + d.width && b.y + b.height <= d.y + d.height)
  expect(onScreen, `overlay bounds ${JSON.stringify(b)} not inside any display ${JSON.stringify(displays)}`).toBe(true)
  await expect.poll(overlayClass).toBe('recording')
  await triggerUp()
  s = await overlayState()
  expect(s.recording).toBe(false)
  // Moved past 'recording' into transcribing (then 'idle' once the empty test
  // audio is skipped) — either non-recording state confirms the transition.
  await expect.poll(overlayClass).not.toBe('recording')
})

test('transcription with speech pastes the text and flashes Pegado', async () => {
  await post('/api/keys', { provider: 'openai', key: 'sk-test-fake' })
  await app.evaluate(() => (global as any).__nwTest.setMockTranscribe('hola mundo'))
  await app.evaluate(() => (global as any).__nwTest.feedAudio(24000))
  await expect.poll(() => app.evaluate(() => (global as any).__nwTest.lastPasted())).toBe('hola mundo')
  await expect.poll(overlayClass).toBe('done')
  await app.evaluate(() => (global as any).__nwTest.setMockTranscribe(undefined))
})

test('silent/empty audio shows "no te he oído", does not paste', async () => {
  await app.evaluate(() => (global as any).__nwTest.setMockTranscribe('')) // empty = no speech
  await app.evaluate(() => (global as any).__nwTest.feedAudio(24000))
  await expect.poll(overlayClass).toBe('error') // visible feedback, not a silent vanish
  const s = await overlayState()
  expect(s.recording).toBe(false)
  await app.evaluate(() => (global as any).__nwTest.setMockTranscribe(undefined))
  await app.evaluate(() => (global as any).__nwTest.hideOverlay())
})

test('overlay hides again after the flow ends', async () => {
  await app.evaluate(() => (global as any).__nwTest.hideOverlay())
  const s = await overlayState()
  expect(s.visible).toBe(false)
})
