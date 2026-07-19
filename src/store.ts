import type { DrillConfig, SequenceStep } from './drills'
import type { SessionSummary } from './trainer'

const KEYS = {
  offsetLegacy: 'gt-latency-offset',
  offsets: 'gt-latency-offsets',
  device: 'gt-input-device',
  settings: 'gt-settings',
  sessions: 'gt-sessions',
  sequences: 'gt-sequences',
}

export function getSequences(): Record<string, SequenceStep[]> {
  try {
    return JSON.parse(localStorage.getItem(KEYS.sequences) ?? '{}')
  } catch {
    return {}
  }
}

export function saveSequence(name: string, steps: SequenceStep[]) {
  const all = getSequences()
  all[name] = steps
  localStorage.setItem(KEYS.sequences, JSON.stringify(all))
}

export function deleteSequence(name: string) {
  const all = getSequences()
  delete all[name]
  localStorage.setItem(KEYS.sequences, JSON.stringify(all))
}

export interface PreferredDevice {
  id: string
  label: string
}

export function getPreferredDevice(): PreferredDevice | null {
  try {
    return JSON.parse(localStorage.getItem(KEYS.device) ?? 'null')
  } catch {
    return null
  }
}

export function setPreferredDevice(id: string, label: string) {
  localStorage.setItem(KEYS.device, JSON.stringify({ id, label }))
}

function offsetMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEYS.offsets) ?? '{}')
  } catch {
    return {}
  }
}

/** Latency offset for a specific input device, seconds. */
export function getLatencyOffset(deviceId: string): number | null {
  const map = offsetMap()
  if (deviceId in map) return map[deviceId]
  // Fall back to the pre-per-device value so old calibrations keep working.
  const legacy = localStorage.getItem(KEYS.offsetLegacy)
  return legacy === null ? null : Number(legacy)
}

export function setLatencyOffset(deviceId: string, seconds: number) {
  const map = offsetMap()
  map[deviceId] = seconds
  localStorage.setItem(KEYS.offsets, JSON.stringify(map))
}

type StoredSettings = Partial<DrillConfig> & { poolName?: string; seqName?: string }

export function getSettings(): StoredSettings {
  try {
    return JSON.parse(localStorage.getItem(KEYS.settings) ?? '{}')
  } catch {
    return {}
  }
}

export function saveSettings(s: StoredSettings) {
  localStorage.setItem(KEYS.settings, JSON.stringify(s))
}

export function saveSession(s: SessionSummary) {
  const all = getSessions()
  all.push(s)
  localStorage.setItem(KEYS.sessions, JSON.stringify(all.slice(-200)))
}

export function getSessions(): SessionSummary[] {
  try {
    return JSON.parse(localStorage.getItem(KEYS.sessions) ?? '[]')
  } catch {
    return []
  }
}
