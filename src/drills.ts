import { OPEN_STRING_MIDI } from './notes'

export type DrillKind = 'random' | 'pattern' | 'multi' | 'sequence'

export interface SequenceStep {
  string: number
  fret: number
  /** Fretting finger 1–4 (index…pinky), optional */
  finger?: number
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
    case 'sequence': {
      let i = -1
      return () => {
        i = (i + 1) % cfg.sequence.length
        const s = cfg.sequence[i]
        return { ...target(s.string, s.fret), finger: s.finger }
      }
    }
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

const STEP_RE = /^([1-6])[:.\/](\d{1,2})(?:[:.\/]([1-4]))?$/

/**
 * Parses the compact sequence syntax: whitespace/comma-separated tokens of
 * `string:fret` or `string:fret:finger`, e.g. "6:3:1 6:5:2 5:3:1".
 */
export function parseSequence(text: string): { steps: SequenceStep[] } | { error: string } {
  const tokens = text.split(/[\s,]+/).filter(Boolean)
  if (tokens.length === 0) return { error: 'Empty sequence' }
  const steps: SequenceStep[] = []
  for (const tok of tokens) {
    const m = STEP_RE.exec(tok)
    if (!m) return { error: `Can't read "${tok}" — use string:fret or string:fret:finger, e.g. 6:3:1` }
    const fret = Number(m[2])
    if (fret > 15) return { error: `Fret ${fret} in "${tok}" is out of range (0–15)` }
    steps.push({
      string: Number(m[1]),
      fret,
      ...(m[3] ? { finger: Number(m[3]) } : {}),
    })
  }
  return { steps }
}

export function serializeSequence(steps: SequenceStep[]): string {
  return steps
    .map((s) => `${s.string}:${s.fret}${s.finger ? `:${s.finger}` : ''}`)
    .join(' ')
}
