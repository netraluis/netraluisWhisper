// Hidden renderer: owns the microphone. main.ts drives it via IPC.
const { ipcRenderer } = require('electron')

let mediaRecorder = null
let chunks = []

async function init() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    })
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm'
    mediaRecorder = new MediaRecorder(stream, { mimeType: mime })
    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    mediaRecorder.onstop = async () => {
      const blob = new Blob(chunks, { type: 'audio/webm' })
      chunks = []
      const buf = await blob.arrayBuffer()
      ipcRenderer.send('audio-data', buf)
    }
    console.log('recorder ready:', mime)
  } catch (err) {
    console.error('getUserMedia failed:', err)
  }
}

ipcRenderer.on('start-recording', () => {
  if (mediaRecorder && mediaRecorder.state === 'inactive') {
    chunks = []
    mediaRecorder.start()
  }
})

ipcRenderer.on('stop-recording', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop()
  }
})

init()
