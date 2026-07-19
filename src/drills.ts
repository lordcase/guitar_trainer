import { OPEN_STRING_MIDI } from './notes'

export type DrillKind = 'random' | 'pattern' | 'multi'

export interface DrillConfig {
  kind: DrillKind
  /** 6 = low E … 1 = high E (single-string drills) */
  string: number
  fretPool: number[]
  /** For kind 'pattern', e.g. [3, 7, 10, 7] */
  pattern: number[]
  startBpm: number
  beatsPerTarget: number
  /** Eyes-closed mode: spoken targets + sound feedback */
  audioPrompts: boolean
}

export interface Target {
  string: number
  fret: number
  midi: number
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
  return cfg.kind === 'multi' ? `string ${t.string}, ${fret}` : fret
}
