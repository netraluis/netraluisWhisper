// Encode mono Float32 PCM samples into a 16-bit WAV buffer.
// Cloud STT APIs (Groq/OpenAI) accept WAV; local inference uses the raw
// Float32 directly, so this is only on the cloud path.
export function encodeWav(samples: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buf = Buffer.alloc(44 + dataSize)

  // RIFF header
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8)
  // fmt chunk
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // audio format = PCM
  buf.writeUInt16LE(1, 22) // channels = 1
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28) // byte rate
  buf.writeUInt16LE(bytesPerSample, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  // data chunk
  buf.write('data', 36)
  buf.writeUInt32LE(dataSize, 40)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, offset)
    offset += 2
  }
  return buf
}
