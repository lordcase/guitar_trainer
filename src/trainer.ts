import type { GuitarInput } from './audio/input'
import type { PitchEventTracker, NoteEvent } from './audio/tracker'
import { Metronome, feedbackBeep, speak } from './audio/metronome'
import { makeGenerator, promptText, type DrillConfig, type Target } from './drills'

export type BeatKind = 'count' | 'prep' | 'land'
export type TargetStatus = 'pending' | 'hit' | 'wrong' | 'miss'

export interface HeardNote {
  midi: number
  /** Signed offset from the landing click in ms: negative = early */
  errorMs: number
}

export interface TargetResult {
  target: Target
  landTime: number
  status: TargetStatus
  /** Signed timing error in ms (hits only): negative = early */
  errorMs: number | null
  /** What was actually detected nearest this landing, if anything */
  heard: HeardNote | null
}

/** One note on the rolling-tab timeline: a scored/pending landing or a predicted upcoming one. */
export interface TimelineNote {
  time: number
  target: Target
  status: TargetStatus | 'upcoming'
  errorMs: number | null
  heardMidi: number | null
}

export interface SessionSummary {
  date: string
  kind: DrillConfig['kind']
  string: number
  totalTargets: number
  hits: number
  wrong: number
  missed: number
  accuracy: number
  startBpm: number
  endBpm: number
  maxBpm: number
  avgAbsErrorMs: number | null
  perFret: Record<number, { hits: number; total: number }>
}

export interface SessionCallbacks {
  onBeat(kind: BeatKind, time: number): void
  onResolve(r: TargetResult, state: { bpm: number; streak: number; hits: number; total: number }): void
  onTempoChange(bpm: number, dir: 'up' | 'down'): void
}

const COUNT_IN = 4
const WINDOW = 0.15 // ± seconds around the landing click
// The tracker's pitch vote can take up to ~300 ms after the attack, so a
// note played at the window's edge is reported well after the window
// closes — resolve late enough to catch it.
const RESOLVE_SLACK = 0.45
/** How far off-window we still report what was heard (diagnostics) */
const HEARD_RANGE = 0.5
const REPS_TO_ADVANCE = 8
const MISSES_TO_DROP = 3
const BPM_STEP = 5
const MIN_BPM = 40

export class DrillSession {
  results: TargetResult[] = []
  bpm: number
  maxBpm: number
  streak = 0

  private missStreak = 0
  private events: { t: number; midi: number }[] = []
  private metronome: Metronome
  private gen: () => Target
  /** All targets in play order, generated lazily as the timeline needs them */
  private targets: Target[] = []
  /** How many landings have been scheduled (= index of the next landing's target) */
  private landCount = 0
  private started = false
  private stopped = false
  private prevHandler: ((e: NoteEvent) => void) | null

  constructor(
    private input: GuitarInput,
    private tracker: PitchEventTracker,
    private cfg: DrillConfig,
    /** Latency offset from calibration, seconds */
    private offset: number,
    private cb: SessionCallbacks,
  ) {
    this.bpm = cfg.startBpm
    this.maxBpm = cfg.startBpm
    this.gen = makeGenerator(cfg)
    this.prevHandler = tracker.onEvent
    this.metronome = new Metronome(input.ctx, this.bpm, this.handleBeat)
    this.metronome.accentEvery = cfg.beatsPerTarget
  }

  get time() {
    return this.input.ctx.currentTime
  }

  get beatsPerTarget() {
    return this.cfg.beatsPerTarget
  }

  start() {
    this.tracker.onEvent = this.handleEvent
    this.started = true
    if (this.cfg.audioPrompts) speak(promptText(this.targetAt(0), this.cfg))
    this.metronome.start(0.8)
  }

  stop(): SessionSummary {
    this.stopped = true
    this.metronome.stop()
    this.tracker.onEvent = this.prevHandler
    window.speechSynthesis?.cancel()
    return this.summarize()
  }

  private targetAt(i: number): Target {
    while (this.targets.length <= i) this.targets.push(this.gen())
    return this.targets[i]
  }

  private isLanding(beatIndex: number): boolean {
    const bpt = this.cfg.beatsPerTarget
    return beatIndex >= COUNT_IN && (beatIndex - COUNT_IN) % bpt === bpt - 1
  }

  /** Scored + pending + predicted notes within `horizonSec` of now — feeds the rolling tab. */
  timeline(horizonSec: number): TimelineNote[] {
    if (!this.started) return []
    const out: TimelineNote[] = []
    for (const r of this.results.slice(-30)) {
      out.push({
        time: r.landTime,
        target: r.target,
        status: r.status,
        errorMs: r.errorMs,
        heardMidi: r.heard?.midi ?? null,
      })
    }
    const limit = this.time + horizonSec
    const ib = 60 / this.bpm
    let idx = this.metronome.scheduledIndex
    let t = this.metronome.scheduledTime
    let k = this.landCount
    while (t < limit) {
      if (this.isLanding(idx)) {
        out.push({ time: t, target: this.targetAt(k++), status: 'upcoming', errorMs: null, heardMidi: null })
      }
      t += ib
      idx++
    }
    return out
  }

  /** Beat grid within the visible range — accents mark landing beats. */
  beats(horizonSec: number): { time: number; accent: boolean }[] {
    if (!this.started) return []
    const res: { time: number; accent: boolean }[] = []
    const ib = 60 / this.bpm
    const idx0 = this.metronome.scheduledIndex
    const t0 = this.metronome.scheduledTime
    for (let m = 1; m <= 6; m++) {
      const bi = idx0 - m
      if (bi >= 0) res.push({ time: t0 - m * ib, accent: this.isLanding(bi) })
    }
    const limit = this.time + horizonSec
    let idx = idx0
    for (let t = t0; t < limit; t += ib, idx++) {
      res.push({ time: t, accent: this.isLanding(idx) })
    }
    return res
  }

  private handleBeat = (index: number, time: number) => {
    if (this.stopped) return
    if (index < COUNT_IN) {
      this.cb.onBeat('count', time)
      return
    }
    if (!this.isLanding(index)) {
      this.cb.onBeat('prep', time)
      return
    }

    this.cb.onBeat('land', time)
    const rec: TargetResult = {
      target: this.targetAt(this.landCount),
      landTime: time,
      status: 'pending',
      errorMs: null,
      heard: null,
    }
    this.landCount++
    this.results.push(rec)

    const ctx = this.input.ctx
    // Resolve after the scoring window closes AND the pitch vote settles.
    setTimeout(
      () => this.resolve(rec),
      Math.max(0, (time + WINDOW + RESOLVE_SLACK - ctx.currentTime) * 1000),
    )
    if (this.cfg.audioPrompts) {
      // Announce the next target shortly after this landing.
      const nextIdx = this.landCount
      const announceDelay = Math.min(0.3, (0.25 * (this.cfg.beatsPerTarget * 60)) / this.bpm)
      setTimeout(
        () => {
          if (!this.stopped) speak(promptText(this.targetAt(nextIdx), this.cfg))
        },
        Math.max(0, (time + announceDelay - ctx.currentTime) * 1000),
      )
    }
  }

  private handleEvent = (e: NoteEvent) => {
    if (e.midi === null || this.stopped) return
    const t = e.time - this.offset
    this.events.push({ t, midi: e.midi })
    if (this.events.length > 50) this.events.shift()
    // Only the most recent few targets can still be in their window.
    for (let i = this.results.length - 1; i >= 0 && i >= this.results.length - 3; i--) {
      const rec = this.results[i]
      if (rec.status !== 'pending') continue
      if (Math.abs(t - rec.landTime) <= WINDOW) {
        rec.heard = { midi: e.midi, errorMs: (t - rec.landTime) * 1000 }
        if (e.midi === rec.target.midi) {
          rec.status = 'hit'
          rec.errorMs = rec.heard.errorMs
        } else {
          rec.status = 'wrong'
        }
        return
      }
    }
  }

  private resolve(rec: TargetResult) {
    if (this.stopped) return
    if (rec.status === 'pending') {
      rec.status = 'miss'
      // Diagnostics: report the nearest detected note even if it was
      // outside the scoring window.
      let best: HeardNote | null = null
      for (const e of this.events) {
        const err = (e.t - rec.landTime) * 1000
        if (Math.abs(err) <= HEARD_RANGE * 1000 && (!best || Math.abs(err) < Math.abs(best.errorMs))) {
          best = { midi: e.midi, errorMs: err }
        }
      }
      rec.heard = best
    }

    if (rec.status === 'hit') {
      this.streak++
      this.missStreak = 0
      if (this.streak % REPS_TO_ADVANCE === 0) {
        this.bpm += BPM_STEP
        this.maxBpm = Math.max(this.maxBpm, this.bpm)
        this.metronome.bpm = this.bpm
        this.cb.onTempoChange(this.bpm, 'up')
      }
    } else {
      this.streak = 0
      this.missStreak++
      if (this.missStreak >= MISSES_TO_DROP) {
        this.missStreak = 0
        const dropped = Math.max(MIN_BPM, this.bpm - BPM_STEP)
        if (dropped !== this.bpm) {
          this.bpm = dropped
          this.metronome.bpm = this.bpm
          this.cb.onTempoChange(this.bpm, 'down')
        }
      }
    }

    if (this.cfg.audioPrompts) {
      feedbackBeep(this.input.ctx, rec.status === 'hit' ? 'hit' : 'miss')
    }
    const hits = this.results.filter((r) => r.status === 'hit').length
    this.cb.onResolve(rec, {
      bpm: this.bpm,
      streak: this.streak,
      hits,
      total: this.results.filter((r) => r.status !== 'pending').length,
    })
  }

  private summarize(): SessionSummary {
    const done = this.results.filter((r) => r.status !== 'pending')
    const hits = done.filter((r) => r.status === 'hit')
    const perFret: SessionSummary['perFret'] = {}
    for (const r of done) {
      const f = (perFret[r.target.fret] ??= { hits: 0, total: 0 })
      f.total++
      if (r.status === 'hit') f.hits++
    }
    return {
      date: new Date().toISOString(),
      kind: this.cfg.kind,
      string: this.cfg.string,
      totalTargets: done.length,
      hits: hits.length,
      wrong: done.filter((r) => r.status === 'wrong').length,
      missed: done.filter((r) => r.status === 'miss').length,
      accuracy: done.length ? hits.length / done.length : 0,
      startBpm: this.cfg.startBpm,
      endBpm: this.bpm,
      maxBpm: this.maxBpm,
      avgAbsErrorMs: hits.length
        ? hits.reduce((s, r) => s + Math.abs(r.errorMs!), 0) / hits.length
        : null,
      perFret,
    }
  }
}
