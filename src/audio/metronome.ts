/**
 * Lookahead-scheduled metronome ("A Tale of Two Clocks" pattern): a coarse
 * JS interval schedules sample-accurate clicks slightly ahead on the
 * AudioContext clock, so UI jank never shifts the beat.
 */
export class Metronome {
  bpm: number
  /** Every Nth beat is accented (the "landing" click). 1 = accent all. */
  accentEvery = 1

  private timer: number | null = null
  private nextTime = 0
  private index = 0

  constructor(
    private ctx: AudioContext,
    bpm: number,
    /**
     * Fires when a beat is *scheduled* — up to ~120 ms before it is audible.
     * `time` is the AudioContext time at which the click sounds; use it to
     * schedule UI updates and scoring windows.
     */
    private onBeat: (index: number, time: number) => void,
  ) {
    this.bpm = bpm
  }

  /** Index of the next beat to be scheduled (already-scheduled beats are below this) */
  get scheduledIndex() {
    return this.index
  }

  /** AudioContext time of the next beat to be scheduled */
  get scheduledTime() {
    return this.nextTime
  }

  start(delay = 0.6) {
    this.stop()
    this.index = 0
    this.nextTime = this.ctx.currentTime + delay
    this.timer = window.setInterval(this.schedule, 25)
    this.schedule()
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  private schedule = () => {
    // onBeat may call stop() (e.g. after a fixed click count) — check timer
    // each iteration so no extra beat gets scheduled after that.
    while (this.timer !== null && this.nextTime < this.ctx.currentTime + 0.12) {
      const accent =
        this.accentEvery <= 1 ||
        this.index % this.accentEvery === this.accentEvery - 1
      click(this.ctx, this.nextTime, accent)
      this.onBeat(this.index, this.nextTime)
      this.index++
      this.nextTime += 60 / this.bpm
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
