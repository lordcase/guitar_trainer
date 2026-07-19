const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

export interface Note {
  midi: number
  name: string
  octave: number
  /** Deviation from the tempered pitch, in cents (-50..+50) */
  cents: number
}

export function freqToNote(freq: number): Note {
  const midiFloat = 69 + 12 * Math.log2(freq / 440)
  const midi = Math.round(midiFloat)
  return {
    midi,
    name: NOTE_NAMES[((midi % 12) + 12) % 12],
    octave: Math.floor(midi / 12) - 1,
    cents: (midiFloat - midi) * 100,
  }
}

/** "A2", "D#3", … */
export function midiName(midi: number): string {
  return `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`
}

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12)
}

/** Standard tuning, string 6 (low E) to string 1 (high E). */
export const OPEN_STRING_MIDI = [40, 45, 50, 55, 59, 64]

export interface FretPosition {
  /** 6 = low E … 1 = high E */
  string: number
  fret: number
}

/** All places a pitch lives on the neck (frets 0..15). */
export function fretPositions(midi: number, maxFret = 15): FretPosition[] {
  const out: FretPosition[] = []
  OPEN_STRING_MIDI.forEach((open, i) => {
    const fret = midi - open
    if (fret >= 0 && fret <= maxFret) out.push({ string: 6 - i, fret })
  })
  return out
}
