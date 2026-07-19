export interface PitchResult {
  /** Detected fundamental frequency in Hz */
  freq: number
  /** 0..1 — how periodic the signal is; treat < ~0.9 as unreliable */
  clarity: number
}

/**
 * McLeod Pitch Method (MPM): normalized square difference function + peak
 * picking. Works well on monophonic guitar signals down to low E (82.4 Hz)
 * with a 2048-sample window at 44.1/48 kHz.
 */
export function detectPitch(
  buf: Float32Array,
  sampleRate: number,
  minFreq = 70,
  maxFreq = 1200,
): PitchResult | null {
  const n = buf.length
  const maxLag = Math.min(Math.floor(n / 2), Math.floor(sampleRate / minFreq))
  const minLag = Math.max(2, Math.floor(sampleRate / maxFreq))

  // NSDF: nsdf[lag] = 2*acf(lag) / (m(0..) energy terms), in [-1, 1]
  const nsdf = new Float32Array(maxLag)
  const half = Math.floor(n / 2)
  for (let lag = minLag; lag < maxLag; lag++) {
    let acf = 0
    let div = 0
    for (let i = 0; i < half; i++) {
      const a = buf[i]
      const b = buf[i + lag]
      acf += a * b
      div += a * a + b * b
    }
    nsdf[lag] = div > 0 ? (2 * acf) / div : 0
  }

  // Collect local maxima between negative-to-positive zero crossings.
  const peaks: { lag: number; value: number }[] = []
  let searching = false
  let bestLag = -1
  let bestVal = 0
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (!searching) {
      if (nsdf[lag - 1] <= 0 && nsdf[lag] > 0) searching = true
      continue
    }
    if (nsdf[lag] < 0) {
      if (bestLag > 0) peaks.push({ lag: bestLag, value: bestVal })
      searching = false
      bestLag = -1
      bestVal = 0
      continue
    }
    if (nsdf[lag] > bestVal) {
      bestVal = nsdf[lag]
      bestLag = lag
    }
  }
  if (bestLag > 0) peaks.push({ lag: bestLag, value: bestVal })
  if (peaks.length === 0) return null

  // First peak within 90% of the global max wins — avoids octave errors
  // where a later (lower-frequency) peak is marginally taller.
  const globalMax = Math.max(...peaks.map((p) => p.value))
  const threshold = 0.9 * globalMax
  const chosen = peaks.find((p) => p.value >= threshold)!

  // Parabolic interpolation around the chosen lag for sub-sample precision.
  let lag: number = chosen.lag
  if (lag > minLag && lag < maxLag - 1) {
    const y0 = nsdf[lag - 1]
    const y1 = nsdf[lag]
    const y2 = nsdf[lag + 1]
    const denom = y0 - 2 * y1 + y2
    if (denom !== 0) lag += (0.5 * (y0 - y2)) / denom
  }

  return { freq: sampleRate / lag, clarity: chosen.value }
}

/** Root-mean-square level of a buffer — used to gate silence. */
export function rms(buf: Float32Array): number {
  let sum = 0
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
  return Math.sqrt(sum / buf.length)
}
