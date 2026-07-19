export interface GuitarInput {
  ctx: AudioContext
  analyser: AnalyserNode
  stream: MediaStream
  stop(): void
}

/**
 * Opens an audio input with all voice-call processing disabled — echo
 * cancellation, noise suppression, and auto-gain would mangle a DI guitar
 * signal (the MOMIX presents as a plain USB audio input).
 */
export async function openInput(deviceId?: string): Promise<GuitarInput> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  })

  const ctx = new AudioContext()
  await ctx.resume() // iOS requires resume within a user gesture

  const source = ctx.createMediaStreamSource(stream)
  const analyser = ctx.createAnalyser()
  // 4096 @ 48 kHz ≈ 85 ms window — pitch stability on low fretted notes
  // matters more than per-frame latency (attack timing comes from the onset
  // detector, not the pitch reading).
  analyser.fftSize = 4096
  source.connect(analyser)

  return {
    ctx,
    analyser,
    stream,
    stop() {
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    },
  }
}

/** Input devices — labels are only populated after mic permission is granted. */
export async function listInputs(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter((d) => d.kind === 'audioinput')
}
