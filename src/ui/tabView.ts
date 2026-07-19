import type { DrillSession } from '../trainer'
import { DURATION_TICKS, type SequenceStep } from '../drills'
import { midiName } from '../notes'

/** Gibson-app finger colors: 1 blue, 2 green, 3 yellow, 4 pink */
export const FINGER_COLORS: Record<number, string> = {
  1: '#4f8fd8',
  2: '#54b45f',
  3: '#e7c14f',
  4: '#e05a9b',
}
export const FINGER_NAMES: Record<number, string> = {
  1: 'index',
  2: 'middle',
  3: 'ring',
  4: 'pinky',
}
/** Gibson-app convention: open strings are white */
export const OPEN_COLOR = '#f2f3f5'

function outlineColor(fret: number, finger: number | undefined, fallback: string): string {
  if (fret === 0) return OPEN_COLOR
  return finger && FINGER_COLORS[finger] ? FINGER_COLORS[finger] : fallback
}

// Tab convention: high e on top. Index 0 = string 1.
const STRING_LABELS = ['e', 'B', 'G', 'D', 'A', 'E']

const HIT_X = 64
const PX_PER_TARGET = 150

const C = {
  stringLine: '#2a2f3d',
  label: '#8a90a0',
  beat: 'rgba(255,255,255,0.05)',
  accent: 'rgba(255,255,255,0.13)',
  hitLine: '#4fc38a',
  upcoming: '#3d4456',
  upcomingText: '#e8eaf0',
  hit: '#4fc38a',
  hitText: '#0c2018',
  bad: '#d8724f',
  badText: '#1f120c',
  small: '#8a90a0',
}

/**
 * Rolling tab: notes scroll right-to-left; a note must be played when its
 * box crosses the hit line. Scored notes keep their color as they exit.
 */
export function renderTab(canvas: HTMLCanvasElement, session: DrillSession) {
  const g = canvas.getContext('2d')
  if (!g) return
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
  }
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const now = session.time
  const targetInterval = (session.scrollBeats * 60) / session.bpm
  const pxPerSec = PX_PER_TARGET / targetInterval
  const horizon = (w - HIT_X) / pxPerSec + 0.5
  const xAt = (t: number) => HIT_X + (t - now) * pxPerSec

  const topPad = 22
  const gap = (h - topPad - 30) / 5
  const yAt = (string: number) => topPad + (string - 1) * gap // string 1 (high e) on top

  // Beat grid.
  for (const b of session.beats(horizon)) {
    const x = xAt(b.time)
    if (x < 0 || x > w) continue
    g.strokeStyle = b.accent ? C.accent : C.beat
    g.lineWidth = b.accent ? 2 : 1
    g.beginPath()
    g.moveTo(x, topPad - 12)
    g.lineTo(x, topPad + 5 * gap + 12)
    g.stroke()
  }

  // String lines + labels.
  g.font = '12px system-ui, sans-serif'
  for (let s = 1; s <= 6; s++) {
    const y = yAt(s)
    g.strokeStyle = C.stringLine
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(24, y)
    g.lineTo(w, y)
    g.stroke()
    g.fillStyle = C.label
    g.fillText(STRING_LABELS[s - 1], 8, y + 4)
  }

  // Hit line.
  g.strokeStyle = C.hitLine
  g.lineWidth = 2
  g.shadowColor = C.hitLine
  g.shadowBlur = 6
  g.beginPath()
  g.moveTo(HIT_X, topPad - 16)
  g.lineTo(HIT_X, topPad + 5 * gap + 16)
  g.stroke()
  g.shadowBlur = 0

  // Notes and rests.
  const restY = (yAt(3) + yAt(4)) / 2
  g.font = 'bold 17px system-ui, sans-serif'
  g.textAlign = 'center'
  for (const n of session.timeline(horizon)) {
    const x = xAt(n.time)
    if (x < -40 || x > w + 40) continue

    if (n.target === null) {
      // Rest: small gray marker between the middle strings.
      g.fillStyle = C.upcoming
      g.beginPath()
      g.roundRect(x - 5, restY - 8, 10, 16, 3)
      g.fill()
      continue
    }

    const y = yAt(n.target.string)
    const label = String(n.target.fret)
    const boxW = Math.max(26, g.measureText(label).width + 14)

    g.beginPath()
    g.roundRect(x - boxW / 2, y - 12, boxW, 24, 7)
    if (n.status === 'hit' || n.status === 'wrong' || n.status === 'miss') {
      // Scored: solid fill tells the result.
      g.fillStyle = n.status === 'hit' ? C.hit : C.bad
      g.fill()
      g.fillStyle = n.status === 'hit' ? C.hitText : C.badText
    } else {
      // Upcoming: open container, finger color (white = open string) on the outline.
      g.strokeStyle = outlineColor(n.target.fret, n.target.finger, C.upcoming)
      g.lineWidth = 2
      g.stroke()
      g.fillStyle = C.upcomingText
    }
    g.fillText(label, x, y + 6)

    // Small annotation under the note.
    g.font = '10px system-ui, sans-serif'
    if (n.status === 'hit' && n.errorMs !== null) {
      g.fillStyle = C.hitLine
      g.fillText(`${n.errorMs >= 0 ? '+' : '−'}${Math.abs(n.errorMs).toFixed(0)}`, x, y + 26)
    } else if (n.status === 'wrong' && n.heardMidi !== null) {
      g.fillStyle = C.bad
      g.fillText(midiName(n.heardMidi), x, y + 26)
    } else if (n.status === 'miss') {
      g.fillStyle = C.bad
      g.fillText(n.heardMidi !== null ? midiName(n.heardMidi) : '∅', x, y + 26)
    }
    g.font = 'bold 17px system-ui, sans-serif'
  }
  g.textAlign = 'left'
}

/** Static tab of a sequence for the editor preview. Sizes its own canvas. */
export function renderSequencePreview(canvas: HTMLCanvasElement, steps: SequenceStep[]) {
  const g = canvas.getContext('2d')
  if (!g) return
  const dpr = window.devicePixelRatio || 1
  // Spacing is duration-proportional; scale so the SHORTEST duration in
  // the sequence still fits a note box (~24px). Sequences with 16ths
  // render wider and scroll.
  const minTicks = steps.reduce((m, s) => Math.min(m, DURATION_TICKS[s.dur ?? 'q']), 4)
  const perTick = Math.max(24 / minTicks, 8.5)
  const left = 34
  const contentW = steps.reduce((sum, s) => sum + perTick * DURATION_TICKS[s.dur ?? 'q'], 0)
  const w = Math.max(left + contentW + 16, canvas.parentElement?.clientWidth ?? 300)
  const h = 150
  canvas.style.width = `${w}px`
  canvas.style.height = `${h}px`
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, w, h)

  const topPad = 18
  const gap = (h - topPad - 24) / 5
  const yAt = (string: number) => topPad + (string - 1) * gap

  g.font = '11px system-ui, sans-serif'
  for (let s = 1; s <= 6; s++) {
    const y = yAt(s)
    g.strokeStyle = C.stringLine
    g.lineWidth = 1
    g.beginPath()
    g.moveTo(22, y)
    g.lineTo(w, y)
    g.stroke()
    g.fillStyle = C.label
    g.fillText(STRING_LABELS[s - 1], 8, y + 4)
  }

  const restY = (yAt(3) + yAt(4)) / 2
  g.font = 'bold 15px system-ui, sans-serif'
  g.textAlign = 'center'
  let cursor = left
  for (const step of steps) {
    const ticks = DURATION_TICKS[step.dur ?? 'q']
    const adv = perTick * ticks
    const x = cursor + adv / 2
    cursor += adv

    if (step.rest) {
      g.fillStyle = C.upcoming
      g.beginPath()
      g.roundRect(x - 4, restY - 7, 8, 14, 3)
      g.fill()
      continue
    }

    const y = yAt(step.string!)
    const label = String(step.fret)
    const boxW = Math.max(24, g.measureText(label).width + 12)
    g.beginPath()
    g.roundRect(x - boxW / 2, y - 11, boxW, 22, 6)
    g.strokeStyle = outlineColor(step.fret!, step.finger, C.upcoming)
    g.lineWidth = 2
    g.stroke()
    g.fillStyle = C.upcomingText
    g.fillText(label, x, y + 5)
  }
  g.textAlign = 'left'
}
