import type { GuitarInput } from './audio/input'
import type { PitchEventTracker, NoteEvent } from './audio/tracker'
import { Metronome, feedbackBeep, speak } from './audio/metronome'
import {
  DURATION_TICKS,
  makeGenerator,
  midiFor,
  promptText,
  type DrillConfig,
  type Target,
} from './drills'

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
  /** ± scoring window in seconds (shrinks for short notes) */
  window: number
  status: TargetStatus
  /** Signed timing error in ms (hits only): negative = early */
  errorMs: number | null
  /** What was actually detected nearest this landing, if anything */
  heard: HeardNote | null
}

/** One entry on the rolling-tab timeline. `target` is null for rests. */
export interface TimelineNote {
  time: number
  target: Target | null
  /** Length in scheduler ticks (sixteenths); 4 = quarter */
  ticks: number
  status: TargetStatus | 'upcoming' | 'rest'
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

/** One scheduled slot: a note to land, or a rest. */
interface Step {
  target: Target | null
  ticks: number
}

const COUNT_IN_BEATS = 4
const TPB = 4 // scheduler ticks per quarter beat
const MAX_WINDOW = 0.15 // ± seconds around the landing, capped for short notes
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
  private gen: (() => Target) | null = null
  /** All steps in play order, generated lazily as the timeline needs them */
  private steps: Step[] = []
  private seqIdx = 0
  /** Index of the next step to land */
  private stepCount = 0
  /** Tick index at which the next step lands */
  private nextLandTick = COUNT_IN_BEATS * TPB
  private pastRests: { time: number; ticks: number }[] = []
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
    if (cfg.kind !== 'sequence') this.gen = makeGenerator(cfg)
    this.prevHandler = tracker.onEvent
    this.metronome = new Metronome(input.ctx, this.bpm, this.handleTick)
    // Landings start on the first beat after the count-in, so accents fall
    // on (q - COUNT_IN) % N === 0 — bar starts for sequences, target
    // landings otherwise.
    const accentPeriod = cfg.kind === 'sequence' ? 4 : cfg.beatsPerTarget
    this.metronome.accentFn = (q) =>
      q >= COUNT_IN_BEATS && (q - COUNT_IN_BEATS) % accentPeriod === 0
  }

  get time() {
    return this.input.ctx.currentTime
  }

  /** Beats' worth of scroll distance that one "unit" of spacing represents. */
  get scrollBeats() {
    return this.cfg.kind === 'sequence' ? 1 : this.cfg.beatsPerTarget
  }

  start() {
    this.tracker.onEvent = this.handleEvent
    this.started = true
    if (this.cfg.audioPrompts) {
      const first = this.stepAt(0).target
      if (first) speak(promptText(first, this.cfg))
    }
    this.metronome.start(0.8)
  }

  stop(): SessionSummary {
    this.stopped = true
    this.metronome.stop()
    this.tracker.onEvent = this.prevHandler
    window.speechSynthesis?.cancel()
    return this.summarize()
  }

  private stepAt(i: number): Step {
    while (this.steps.length <= i) {
      if (this.cfg.kind === 'sequence') {
        const s = this.cfg.sequence[this.seqIdx % this.cfg.sequence.length]
        this.seqIdx++
        const ticks = DURATION_TICKS[s.dur ?? 'q']
        this.steps.push(
          s.rest
            ? { target: null, ticks }
            : {
                target: {
                  string: s.string!,
                  fret: s.fret!,
                  midi: midiFor(s.string!, s.fret!),
                  finger: s.finger,
                },
                ticks,
              },
        )
      } else {
        this.steps.push({ target: this.gen!(), ticks: this.cfg.beatsPerTarget * TPB })
      }
    }
    return this.steps[i]
  }

  /** Scored + pending + rests + predicted notes within `horizonSec` of now. */
  timeline(horizonSec: number): TimelineNote[] {
    if (!this.started) return []
    const out: TimelineNote[] = []
    for (const r of this.results.slice(-30)) {
      out.push({
        time: r.landTime,
        target: r.target,
        ticks: 4,
        status: r.status,
        errorMs: r.errorMs,
        heardMidi: r.heard?.midi ?? null,
      })
    }
    for (const rest of this.pastRests.slice(-10)) {
      out.push({ time: rest.time, target: null, ticks: rest.ticks, status: 'rest', errorMs: null, heardMidi: null })
    }
    const limit = this.time + horizonSec
    const tickInt = this.metronome.tickInterval
    const timeOf = (tick: number) =>
      this.metronome.scheduledTime + (tick - this.metronome.scheduledIndex) * tickInt
    let tick = this.nextLandTick
    let k = this.stepCount
    let t = timeOf(tick)
    while (t < limit) {
      const step = this.stepAt(k)
      out.push({
        time: t,
        target: step.target,
        ticks: step.ticks,
        status: step.target ? 'upcoming' : 'rest',
        errorMs: null,
        heardMidi: null,
      })
      tick += step.ticks
      t = timeOf(tick)
      k++
    }
    return out
  }

  /** Quarter-beat grid within the visible range — accents per the drill's accent rule. */
  beats(horizonSec: number): { time: number; accent: boolean }[] {
    if (!this.started) return []
    const res: { time: number; accent: boolean }[] = []
    const tickInt = this.metronome.tickInterval
    const schedIdx = this.metronome.scheduledIndex
    const schedTime = this.metronome.scheduledTime
    const firstQuarter = Math.max(0, Math.floor(schedIdx / TPB) - 6)
    const limit = this.time + horizonSec
    for (let q = firstQuarter; ; q++) {
      const t = schedTime + (q * TPB - schedIdx) * tickInt
      if (t > limit) break
      res.push({ time: t, accent: this.metronome.accentFn(q) })
    }
    return res
  }

  private handleTick = (tick: number, time: number) => {
    if (this.stopped) return
    const countTicks = COUNT_IN_BEATS * TPB
    if (tick % TPB === 0 && tick !== this.nextLandTick) {
      this.cb.onBeat(tick < countTicks ? 'count' : 'prep', time)
    }
    if (tick < countTicks || tick !== this.nextLandTick) return

    const step = this.stepAt(this.stepCount)
    this.stepCount++
    this.nextLandTick += step.ticks

    if (!step.target) {
      this.pastRests.push({ time, ticks: step.ticks })
      if (this.pastRests.length > 20) this.pastRests.shift()
      return
    }

    this.cb.onBeat('land', time)
    const window = Math.min(MAX_WINDOW, 0.45 * step.ticks * this.metronome.tickInterval)
    const rec: TargetResult = {
      target: step.target,
      landTime: time,
      window,
      status: 'pending',
      errorMs: null,
      heard: null,
    }
    this.results.push(rec)

    const ctx = this.input.ctx
    // Resolve after the scoring window closes AND the pitch vote settles.
    setTimeout(
      () => this.resolve(rec),
      Math.max(0, (time + window + RESOLVE_SLACK - ctx.currentTime) * 1000),
    )
    if (this.cfg.audioPrompts) {
      // Announce the next note (skipping rests) shortly after this landing.
      let next: Target | null = null
      for (let i = this.stepCount; i < this.stepCount + 8; i++) {
        next = this.stepAt(i).target
        if (next) break
      }
      if (next) {
        const toSpeak = next
        const announceDelay = Math.min(0.3, (0.25 * step.ticks) / TPB) * (60 / this.bpm)
        setTimeout(
          () => {
            if (!this.stopped) speak(promptText(toSpeak, this.cfg))
          },
          Math.max(0, (time + announceDelay - ctx.currentTime) * 1000),
        )
      }
    }
  }

  private handleEvent = (e: NoteEvent) => {
    if (e.midi === null || this.stopped) return
    const t = e.time - this.offset
    this.events.push({ t, midi: e.midi })
    if (this.events.length > 50) this.events.shift()
    // Pick the pending target whose landing is CLOSEST to the event — with
    // short notes the windows of neighbours can overlap.
    let best: TargetResult | null = null
    for (let i = this.results.length - 1; i >= 0 && i >= this.results.length - 6; i--) {
      const rec = this.results[i]
      if (rec.status !== 'pending') continue
      if (Math.abs(t - rec.landTime) > rec.window) continue
      if (!best || Math.abs(t - rec.landTime) < Math.abs(t - best.landTime)) best = rec
    }
    if (!best) return
    best.heard = { midi: e.midi, errorMs: (t - best.landTime) * 1000 }
    if (e.midi === best.target.midi) {
      best.status = 'hit'
      best.errorMs = best.heard.errorMs
    } else {
      best.status = 'wrong'
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
