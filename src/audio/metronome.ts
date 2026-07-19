/**
 * Lookahead-scheduled metronome ("A Tale of Two Clocks" pattern): a coarse
 * JS interval schedules sample-accurate events slightly ahead on the
 * AudioContext clock, so UI jank never shifts the beat.
 *
 * The scheduler ticks at SIXTEENTH-note resolution so note lengths down to
 * 1/16 (and rests) share one coherent clock; audible clicks sound only on
 * quarter beats.
 */
export class Metronome {
  bpm: number
  /** Decides which quarter beats get the accented click. */
  accentFn: (quarter: number) => boolean = () => true
  readonly ticksPerBeat = 4

  private timer: number | null = null
  private nextTime = 0
  private tick = 0

  constructor(
    private ctx: AudioContext,
    bpm: number,
    /**
     * Fires when a tick is *scheduled* — up to ~120 ms before it is audible.
     * `time` is the AudioContext time of the tick; use it to schedule UI
     * updates and scoring windows.
     */
    private onTick: (tick: number, time: number) => void,
  ) {
    this.bpm = bpm
  }

  /** Index of the next tick to be scheduled (already-scheduled ticks are below this) */
  get scheduledIndex() {
    return this.tick
  }

  /** AudioContext time of the next tick to be scheduled */
  get scheduledTime() {
    return this.nextTime
  }

  /** Seconds per sixteenth tick at the current tempo */
  get tickInterval() {
    return 60 / this.bpm / this.ticksPerBeat
  }

  start(delay = 0.6) {
    this.stop()
    this.tick = 0
    this.nextTime = this.ctx.currentTime + delay
    this.timer = window.setInterval(this.schedule, 25)
    this.schedule()
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private schedule = () => {
    // onTick may call stop() — check timer each iteration so no extra tick
    // gets scheduled after that.
    while (this.timer !== null && this.nextTime < this.ctx.currentTime + 0.12) {
      if (this.tick % this.ticksPerBeat === 0) {
        click(this.ctx, this.nextTime, this.accentFn(this.tick / this.ticksPerBeat))
      }
      this.onTick(this.tick, this.nextTime)
      this.tick++
      this.nextTime += this.tickInterval
    }
  }
}

function click(ctx: AudioContext, time: number, accent: boolean) {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = accent ? 1568 : 1047
  gain.gain.setValueAtTime(accent ? 0.5 : 0.2, time)
  gain.gain.exponentialRampToValueAtTime(0.001, time + 0.05)
  osc.connect(gain).connect(ctx.destination)
  osc.start(time)
  osc.stop(time + 0.06)
}

/** Short feedback tone — success blip or low failure buzz. */
export function feedbackBeep(ctx: AudioContext, kind: 'hit' | 'miss') {
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  const t = ctx.currentTime
  if (kind === 'hit') {
    osc.frequency.value = 1319
    gain.gain.setValueAtTime(0.15, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09)
  } else {
    osc.type = 'square'
    osc.frequency.value = 196
    gain.gain.setValueAtTime(0.12, t)
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.16)
  }
  osc.connect(gain).connect(ctx.destination)
  osc.start(t)
  osc.stop(t + 0.2)
}

/** Spoken prompt for eyes-closed mode. Cancels any pending utterance. */
export function speak(text: string) {
  const synth = window.speechSynthesis
  if (!synth) return
  synth.cancel()
  const u = new SpeechSynthesisUtterance(text)
  u.rate = 1.2
  synth.speak(u)
}
