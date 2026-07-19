import { OPEN_STRING_MIDI } from './notes'

export type DrillKind = 'random' | 'pattern' | 'multi' | 'sequence'

/** Note length: quarter (default), eighth, sixteenth */
export type Duration = 'q' | 'e' | 's'

/** Scheduler ticks (sixteenths) per duration */
export const DURATION_TICKS: Record<Duration, number> = { q: 4, e: 2, s: 1 }

export interface SequenceStep {
  /** A pause instead of a note */
  rest?: boolean
  string?: number
  fret?: number
  /** Fretting finger 1–4 (index…pinky), optional */
  finger?: number
  /** Note length, default 'q' */
  dur?: Duration
}

export interface DrillConfig {
  kind: DrillKind
  /** 6 = low E … 1 = high E (single-string drills) */
  string: number
  fretPool: number[]
  /** For kind 'pattern', e.g. [3, 7, 10, 7] */
  pattern: number[]
  /** For kind 'sequence' */
  sequence: SequenceStep[]
  startBpm: number
  beatsPerTarget: number
  /** Eyes-closed mode: spoken targets + sound feedback */
  audioPrompts: boolean
}

export interface Target {
  string: number
  fret: number
  midi: number
  finger?: number
}

export const FRET_POOLS: Record<string, number[]> = {
  'Dots: 3 5 7 9 12': [3, 5, 7, 9, 12],
  'Dots + open': [0, 3, 5, 7, 9, 12],
  'Between dots: 2 4 8 10': [2, 4, 8, 10],
  'All frets 0–12': Array.from({ length: 13 }, (_, i) => i),
}

export const STRING_NAMES: Record<number, string> = {
  6: 'E (low)',
  5: 'A',
  4: 'D',
  3: 'G',
  2: 'B',
  1: 'E (high)',
}

export function midiFor(string: number, fret: number): number {
  return OPEN_STRING_MIDI[6 - string] + fret
}

function target(string: number, fret: number): Target {
  return { string, fret, midi: midiFor(string, fret) }
}

/**
 * Returns a function producing the next target. Generators never repeat the
 * previous target — scoring relies on each landing being a fresh note.
 */
export function makeGenerator(cfg: DrillConfig): () => Target {
  switch (cfg.kind) {
    case 'sequence':
      // Sequences are stepped directly by the session (they carry
      // durations and rests) — never via a generator.
      throw new Error('sequence drills do not use a generator')
    case 'pattern': {
      let i = -1
      return () => {
        i = (i + 1) % cfg.pattern.length
        return target(cfg.string, cfg.pattern[i])
      }
    }
    case 'random': {
      let lastFret = -1
      return () => {
        let fret: number
        do {
          fret = cfg.fretPool[Math.floor(Math.random() * cfg.fretPool.length)]
        } while (fret === lastFret && cfg.fretPool.length > 1)
        lastFret = fret
        return target(cfg.string, fret)
      }
    }
    case 'multi': {
      const strings = [6, 5, 4, 3, 2, 1]
      let last = ''
      return () => {
        let s: number, f: number
        do {
          s = strings[Math.floor(Math.random() * strings.length)]
          f = cfg.fretPool[Math.floor(Math.random() * cfg.fretPool.length)]
        } while (`${s}:${f}` === last)
        last = `${s}:${f}`
        return target(s, f)
      }
    }
  }
}

export function promptText(t: Target, cfg: DrillConfig): string {
  const fret = t.fret === 0 ? 'open' : String(t.fret)
  return cfg.kind === 'multi' || cfg.kind === 'sequence'
    ? `string ${t.string}, ${fret}`
    : fret
}

/**
 * Parses the compact sequence syntax: whitespace/comma-separated tokens.
 * Notes: `string:fret` plus optional `:finger` (1–4) and/or `:length`
 * (q/e/s), in any order — e.g. "6:5:1:e". Rests: `r`, `r:e`, `r:s`.
 */
export function parseSequence(text: string): { steps: SequenceStep[] } | { error: string } {
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return { error: 'Empty sequence' }
  const steps: SequenceStep[] = []
  for (const tok of tokens) {
    const parts = tok.split(/[:.\/]/)
    if (parts[0] === 'r' || /^r[qes]$/.test(parts[0])) {
      const durPart = parts[0].length === 2 ? parts[0][1] : parts[1]
      if (durPart && !'qes'.includes(durPart)) {
        return { error: `Can't read rest "${tok}" — use r, r:e or r:s` }
      }
      steps.push({ rest: true, ...(durPart && durPart !== 'q' ? { dur: durPart as Duration } : {}) })
      continue
    }
    const string = Number(parts[0])
    const fret = Number(parts[1])
    if (
      parts.length < 2 ||
      !/^[1-6]$/.test(parts[0]) ||
      !/^\d{1,2}$/.test(parts[1] ?? '') ||
      fret > 15
    ) {
      return { error: `Can't read "${tok}" — use string:fret(:finger)(:length), e.g. 6:5:1:e` }
    }
    const step: SequenceStep = { string, fret }
    for (const p of parts.slice(2)) {
      if (/^[1-4]$/.test(p)) step.finger = Number(p)
      else if (p === 'e' || p === 's') step.dur = p
      else if (p === 'q') continue
      else return { error: `Can't read "${p}" in "${tok}" — finger is 1–4, length is q, e or s` }
    }
    steps.push(step)
  }
  return { steps }
}

export function serializeSequence(steps: SequenceStep[]): string {
  return steps
    .map((s) => {
      const dur = s.dur && s.dur !== 'q' ? `:${s.dur}` : ''
      if (s.rest) return `r${dur}`
      return `${s.string}:${s.fret}${s.finger ? `:${s.finger}` : ''}${dur}`
    })
    .join(' ')
}
