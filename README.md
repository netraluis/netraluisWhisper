# netraluisWhisper

Local push-to-talk voice dictation for macOS, Wispr Flow style. Hold a key, speak,
release, and the transcription pastes wherever your cursor is — terminal, editor,
browser, any app.

**Status:** riskiest-first spike. Validates the loop: global hotkey → mic → STT → paste.
Cloud STT (Groq) for now; local whisper.cpp, history, insight, and web UI come next.

## Prerequisites

- **macOS** on Apple Silicon (the spike targets it).
- **Node 18+** (tested on 24). Check: `node -v`.
- **Xcode Command Line Tools** — only if a native module has to compile on your machine
  (`uiohook-napi` ships prebuilds, so usually not needed). Install if `npm install` fails:
  `xcode-select --install`.
- An API key for your chosen STT provider (Groq or OpenAI).

## Run the spike

```bash
npm install
cp .env.example .env
# set STT_PROVIDER and the matching key in .env, then:
npm start
```

On start it opens a **web UI** at http://127.0.0.1:8765 (loopback only) with your
transcription history, usage insight, and the provider/model/language picker. Change the
model there — no need to edit `.env` (API keys still come from `.env`). To **quit** the
app, press `Ctrl-C` in the terminal where you ran `npm start`.

The floating recording pill and the web UI are the only visible surfaces; terminal logs
(`recording...`, `pasted: "..."`) are just debug.

### Choosing the STT provider

Not locked to one vendor. In `.env`:

- **Groq** (default, cheap + fast): `STT_PROVIDER=groq`, `GROQ_API_KEY=...` (https://console.groq.com/keys)
- **OpenAI**: `STT_PROVIDER=openai`, `OPENAI_API_KEY=...` (https://platform.openai.com/api-keys; model `whisper-1` or `gpt-4o-transcribe`)

Adding another cloud provider (Deepgram, ElevenLabs, AssemblyAI) is one more entry in
the `PROVIDERS` map in `src/main.ts`. Local whisper.cpp (offline, free) is planned for v0.2.

Then **hold Right-Cmd, speak, release.** The text pastes at your cursor.

### macOS permissions (required)

Grant these to the app running the spike (in dev that's **Electron**; you'll be prompted,
or add it manually):

- **System Settings → Privacy & Security → Microphone** — to record.
- **System Settings → Privacy & Security → Input Monitoring** — for the global hotkey.
- **System Settings → Privacy & Security → Accessibility** — to paste (synthetic Cmd+V).

After granting Accessibility/Input Monitoring you usually must restart the app.

### Find your trigger keycode

If Right-Cmd doesn't fire, discover your key's code:

```bash
npm run keys      # prints keycode for every key you press
```

Put the number in `.env` as `TRIGGER_KEYCODE=...`, then `npm start`.

## Troubleshooting

- **Nothing happens when I hold the key** — grant **Input Monitoring** to Electron and
  restart. Or the keycode is wrong: run `npm run keys` and set `TRIGGER_KEYCODE`.
- **`recording...` shows but nothing pastes** — grant **Accessibility** to Electron and
  restart. Without it the synthetic Cmd+V is silently blocked.
- **`api key missing`** — `STT_PROVIDER` and the matching `*_API_KEY` must both be set in
  `.env`.
- **`groq 401` / `openai 401`** — bad or expired API key.
- **`(recording too short / empty, skipped)`** — you released the key too fast; hold it
  while speaking.
- **Text pastes in the wrong app** — it pastes into whatever app has focus when you
  release. History/re-paste from the web UI is coming (design v0.4).
- **My clipboard changed** — it's saved and restored ~0.6s after paste. If an app is slow
  to accept Cmd+V, that window may be too short; tune the delay in `src/main.ts`.

## Design

Full design doc: `~/.gstack/projects/netraluisWhisper/`. Architecture is a resident
helper (this app) plus a future local web UI — a browser tab can't own a global hotkey
or paste into other apps, so that work lives in the native process.

## License

MIT
