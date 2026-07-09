# netraluisWhisper

Local push-to-talk voice dictation for macOS, Wispr Flow style. Hold a key, speak,
release, and the transcription is pasted wherever your cursor is — terminal, editor,
browser, any app.

**Website:** https://whisper.netraluis.com

- **Local or cloud, your choice.** Run open Whisper models fully on-device (free,
  offline, private, WebGPU-accelerated) or use a cloud API (Groq / OpenAI) with your own key.
- **Your key, your machine.** Cloud keys are stored encrypted in the macOS Keychain.
  Nothing is sent anywhere except the STT provider you pick.
- **History + insight.** Every transcription is saved locally; see what you've dictated
  and where.

> macOS on Apple Silicon.

## Install

### Option 1 — Download

1. Download `netraluisWhisper.dmg` from the [latest release](../../releases/latest).
2. Open it and **drag the app into Applications**.
3. First launch (the app is unsigned, so macOS blocks it):
   ```bash
   xattr -dr com.apple.quarantine /Applications/netraluisWhisper.app
   ```
   Then open it normally. (Or: System Settings → Privacy & Security → scroll down → "Open Anyway".)

### Option 2 — Homebrew (terminal)

```bash
brew install --cask netraluis/tap/netraluiswhisper   # install
brew upgrade --cask netraluiswhisper                  # update
brew uninstall --cask netraluiswhisper                # remove
```

Homebrew removes the Gatekeeper quarantine for you, so no manual `xattr` step.

## Permissions (required, macOS asks on first use)

- **Microphone** — to record your voice.
- **Input Monitoring** — for the global push-to-talk key.
- **Accessibility** — to paste into the focused app.

Grant them in System Settings → Privacy & Security, then relaunch.

## Use

Hold the trigger key (default **Right Cmd**), speak, release. The text pastes at your
cursor. Open the menubar **🎙** to configure:

- **Engine:** Local (download a model) or Cloud (paste your Groq/OpenAI key).
- **Model, language, and the push-to-talk key** — all set from the UI, saved locally.

## Develop

```bash
git clone https://github.com/netraluis/netraluisWhisper.git
cd netraluisWhisper
npm install
npm start          # run from source
npm run dist       # build the .dmg (dist/netraluisWhisper.dmg)
```

Stack: Electron + TypeScript. Local inference via `@huggingface/transformers`
(WebGPU) in a dedicated window; global hotkey via `uiohook-napi`; paste via
AppleScript; config/history served locally by Express and shown in an in-app window.

## License

MIT
