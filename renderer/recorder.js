// Hidden overlay renderer: owns the microphone. main.ts drives it via IPC.
// Captures mono Float32 PCM at 16kHz (what local Whisper needs; cloud path
// encodes it to WAV in main). Uses ScriptProcessor for simplicity.
const { ipcRenderer } = require('electron')

let audioCtx = null
let processor = null
let source = null
let recording = false
let chunks = []

async function init() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    // Ask for a 16kHz context so no resampling is needed downstream.
    audioCtx = new AudioContext({ sampleRate: 16000 })
    source = audioCtx.createMediaStreamSource(stream)
    processor = audioCtx.createScriptProcessor(4096, 1, 1)
    processor.onaudioprocess = (e) => {
      if (!recording) return
      const input = e.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input)) // copy — buffer is reused
    }
    source.connect(processor)
    // Route through a muted gain so onaudioprocess fires without echoing mic.
    const mute = audioCtx.createGain()
    mute.gain.value = 0
    processor.connect(mute)
    mute.connect(audioCtx.destination)
    console.log('recorder ready (PCM 16kHz):', audioCtx.sampleRate)
  } catch (err) {
    console.error('getUserMedia failed:', err)
  }
}

function merge() {
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Float32Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

ipcRenderer.on('start-recording', () => {
  chunks = []
  recording = true
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume()
})

ipcRenderer.on('stop-recording', () => {
  recording = false
  const pcm = merge()
  chunks = []
  // Transfer the underlying buffer to main (Float32 samples, 16kHz mono).
  ipcRenderer.send('audio-pcm', pcm.buffer, pcm.length)
})

init()
