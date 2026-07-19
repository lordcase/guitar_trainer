import type { GuitarInput } from './input'
import type { PitchEventTracker, NoteEvent } from './tracker'
import { Metronome } from './metronome'

export interface CalibrationResult {
  /** Seconds to subtract from detected event times before beat comparison */
  offset: number
  samples: number
}

const CLICKS = 12
const SKIP = 2 // ignore the first clicks while the user locks in
const MATCH_WINDOW = 0.3

/**
 * Measures the constant end-to-end latency (output + input + detection lag
 * + the player's own bias): plays steady clicks, the user plays a muted
 * chug or any note exactly on each click, and we take the median offset
 * between detected attacks and click times.
 */
export function calibrate(
  input: GuitarInput,
  tracker: PitchEventTracker,
  bpm: number,
  onProgress: (clicksPlayed: number, total: number) => void,
): Promise<CalibrationResult> {
  return new Promise((resolve, reject) => {
    const clickTimes: number[] = []
    const events: NoteEvent[] = []
    const prevHandler = tracker.onEvent
    tracker.onEvent = (e) => events.push(e)

    const finish = () => {
      metronome.stop()
      tracker.onEvent = prevHandler
      const diffs: number[] = []
      for (const t of clickTimes.slice(SKIP)) {
        let best: number | null = null
        for (const e of events) {
          const d = e.time - t
          if (Math.abs(d) <= MATCH_WINDOW && (best === null || Math.abs(d) < Math.abs(best))) {
            best = d
          }
        }
        if (best !== null) diffs.push(best)
      }
      if (diffs.length < (CLICKS - SKIP) / 2) {
        reject(new Error(`Only heard you on ${diffs.length} of ${CLICKS - SKIP} clicks — check signal and try again`))
        return
      }
      diffs.sort((a, b) => a - b)
      resolve({ offset: diffs[Math.floor(diffs.length / 2)], samples: diffs.length })
    }

    const metronome = new Metronome(input.ctx, bpm, (index, time) => {
      clickTimes.push(time)
      const uiDelay = Math.max(0, (time - input.ctx.currentTime) * 1000)
      setTimeout(() => onProgress(index + 1, CLICKS), uiDelay)
      if (index === CLICKS - 1) {
        setTimeout(finish, uiDelay + 800)
        metronome.stop()
      }
    })
    metronome.start()
  })
}
