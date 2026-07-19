import type { GuitarInput } from './input'
import { detectPitch, rms } from './pitchDetector'
import { freqToNote } from '../notes'

export interface NoteEvent {
  /** AudioContext time of the attack (or of pitch change for legato) */
  time: number
  /** MIDI note, or null for an unpitched attack (muted chug) */
  midi: number | null
}

export interface LivePitch {
  level: number
  freq: number | null
  midi: number | null
  cents: number
}

const SILENCE_RMS = 0.003
/** Clarity needed for a frame's pitch to count toward event identification */
const VOTE_CLARITY = 0.9
/**
 * Clarity for the live display — lower, so the tuner recovers quickly when
 * a previous note is still ringing under the new one (the mixture drags
 * clarity down even though the new note dominates).
 */
const DISPLAY_CLARITY = 0.85
/**
 * Attack detection looks at only the newest samples of the analysis
 * buffer — an 85 ms RMS smears the pick transient so much that re-picking
 * over a still-ringing string never registers.
 */
const ATTACK_WINDOW = 512
const ONSET_RATIO = 2.0
const ONSET_REFRACTORY = 0.12
/** How long after an attack we keep collecting pitch votes before deciding */
const VOTE_TIMEOUT = 0.3
const VOTE_EARLY_COUNT = 8
const STABLE_FRAMES = 3

/**
 * Single owner of the analyser polling loop. Produces:
 *  - `live`: current pitch/level for tuner-style displays
 *  - note events: attack time + identified pitch, for beat scoring and
 *    latency calibration (unpitched chugs emit midi: null)
 *
 * Onsets come from an RMS jump over a decaying envelope. Pitch is NOT taken
 * from the first frames after the attack (the transient is where detection
 * lies): we collect per-frame readings for ~150-300 ms and emit the
 * majority vote. A pitch-change fallback catches legato notes that have no
 * picking attack.
 */
export class PitchEventTracker {
  onEvent: ((e: NoteEvent) => void) | null = null
  live: LivePitch = { level: 0, freq: null, midi: null, cents: 0 }

  private raf = 0
  private buf: Float32Array<ArrayBuffer>
  private attackEnv = 0
  private lastOnset = -1
  private onsetTime = -1
  private votes: number[] = []
  private candMidi = -1
  private candCount = 0
  private lastEmitMidi: number | null = null
  private lastEmitTime = -1

  constructor(private input: GuitarInput) {
    this.buf = new Float32Array(input.analyser.fftSize)
  }

  start() {
    this.raf = requestAnimationFrame(this.frame)
  }

  stop() {
    cancelAnimationFrame(this.raf)
  }

  private frame = () => {
    const { analyser, ctx } = this.input
    analyser.getFloatTimeDomainData(this.buf)
    const now = ctx.currentTime
    const level = rms(this.buf)
    const attack = rms(this.buf.subarray(this.buf.length - ATTACK_WINDOW))

    if (
      attack > SILENCE_RMS &&
      attack > this.attackEnv * ONSET_RATIO &&
      now - this.lastOnset > ONSET_REFRACTORY
    ) {
      this.lastOnset = now
      this.onsetTime = now
      this.votes = []
    }
    this.attackEnv = Math.max(attack, this.attackEnv * 0.9)

    let freq: number | null = null
    let midi: number | null = null
    let voteMidi: number | null = null
    let cents = 0
    if (level >= SILENCE_RMS) {
      const p = detectPitch(this.buf, ctx.sampleRate)
      if (p && p.clarity >= DISPLAY_CLARITY) {
        freq = p.freq
        const note = freqToNote(p.freq)
        midi = note.midi
        cents = note.cents
        if (p.clarity >= VOTE_CLARITY) voteMidi = midi
      }
    }

    // Live display: require a short stable run so the tuner doesn't flicker.
    if (midi !== null) {
      if (midi === this.candMidi) this.candCount++
      else {
        this.candMidi = midi
        this.candCount = 1
      }
    } else {
      this.candCount = 0
      this.candMidi = -1
    }
    const stableMidi = this.candCount >= STABLE_FRAMES ? this.candMidi : null
    this.live = {
      level,
      freq: stableMidi !== null ? freq : null,
      midi: stableMidi,
      cents,
    }

    if (this.onsetTime >= 0) {
      if (voteMidi !== null) this.votes.push(voteMidi)
      const decided =
        this.votes.length >= VOTE_EARLY_COUNT || now - this.onsetTime >= VOTE_TIMEOUT
      if (decided) {
        this.emit({ time: this.onsetTime, midi: majority(this.votes) })
      }
    } else if (
      stableMidi !== null &&
      stableMidi !== this.lastEmitMidi &&
      now - this.lastEmitTime > 0.25
    ) {
      // Legato/hammer-on: pitch changed without a detected attack.
      this.emit({ time: now - 0.08, midi: stableMidi })
    }

    this.raf = requestAnimationFrame(this.frame)
  }

  private emit(e: NoteEvent) {
    this.onsetTime = -1
    this.votes = []
    this.lastEmitMidi = e.midi
    this.lastEmitTime = e.time
    this.onEvent?.(e)
  }
}

function majority(votes: number[]): number | null {
  if (votes.length === 0) return null
  const counts = new Map<number, number>()
  let best: number | null = null
  let bestCount = 0
  for (const v of votes) {
    const c = (counts.get(v) ?? 0) + 1
    counts.set(v, c)
    if (c > bestCount) {
      best = v
      bestCount = c
    }
  }
  return best
}
