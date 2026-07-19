import { openInput, listInputs, type GuitarInput } from './audio/input'
import { PitchEventTracker } from './audio/tracker'
import { calibrate } from './audio/calibration'
import { fretPositions, midiName } from './notes'
import {
  FRET_POOLS,
  STRING_NAMES,
  parseSequence,
  serializeSequence,
  type DrillConfig,
  type DrillKind,
  type SequenceStep,
} from './drills'
import { DrillSession, type SessionSummary, type TargetResult } from './trainer'
import { renderTab, renderSequencePreview, FINGER_COLORS, FINGER_NAMES } from './ui/tabView'
import * as store from './store'

const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!

// ---------- shared audio input ----------

let input: GuitarInput | null = null
let tracker: PitchEventTracker | null = null

function currentDevice(): { id: string; label: string } | null {
  const t = input?.stream.getAudioTracks()[0]
  if (!t) return null
  return { id: t.getSettings().deviceId ?? '', label: t.label }
}

/**
 * Opens the saved preferred device (e.g. the MOMIX) by default, falling
 * back to the system default if it's unavailable. Explicit `deviceId`
 * selections become the new saved preference.
 */
async function ensureInput(deviceId?: string) {
  if (input && !deviceId) return { input, tracker: tracker! }
  const want = deviceId ?? store.getPreferredDevice()?.id
  tracker?.stop()
  input?.stop()
  input = null
  tracker = null
  try {
    input = await openInput(want)
  } catch (err) {
    if (!want) throw err
    input = await openInput() // preferred device gone — fall back to default
  }
  tracker = new PitchEventTracker(input)
  tracker.start()
  if (deviceId) {
    const d = currentDevice()
    if (d) store.setPreferredDevice(d.id, d.label)
  }
  updateInputStatus()
  return { input, tracker }
}

const inputStatus = $('#input-status')

function updateInputStatus() {
  const d = currentDevice()
  if (d) {
    const offset = store.getLatencyOffset(d.id)
    const cal =
      offset !== null ? `calibrated ${(offset * 1000).toFixed(0)} ms ✓` : 'NOT calibrated ✗'
    inputStatus.textContent = `input: ${d.label || 'default'} · ${cal}`
  } else {
    const saved = store.getPreferredDevice()
    inputStatus.textContent = saved ? `saved input: ${saved.label}` : ''
  }
}

// ---------- screens ----------

function show(id: string) {
  document.querySelectorAll<HTMLElement>('.screen').forEach((s) => {
    s.classList.toggle('active', s.id === id)
  })
}

// ---------- home / settings ----------

const kindPicker = $('#kind-picker')
const stringSelect = $<HTMLSelectElement>('#string-select')
const poolSelect = $<HTMLSelectElement>('#pool-select')
const patternInput = $<HTMLInputElement>('#pattern-input')
const bpmInput = $<HTMLInputElement>('#bpm-input')
const bptSelect = $<HTMLSelectElement>('#bpt-select')
const audioCheck = $<HTMLInputElement>('#audio-check')
const homeStatus = $('#home-status')

let kind: DrillKind = 'random'

for (const [num, name] of Object.entries(STRING_NAMES).reverse()) {
  const opt = document.createElement('option')
  opt.value = num
  opt.textContent = `${num} — ${name}`
  stringSelect.append(opt)
}
stringSelect.value = '6'

for (const name of Object.keys(FRET_POOLS)) {
  const opt = document.createElement('option')
  opt.value = name
  opt.textContent = name
  poolSelect.append(opt)
}

function setKind(k: DrillKind) {
  kind = k
  kindPicker.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('selected', b.dataset.kind === k)
  })
  $('#row-pattern').hidden = k !== 'pattern'
  $('#row-seq').hidden = k !== 'sequence'
  $('#row-pool').hidden = k === 'pattern' || k === 'sequence'
  $('#row-string').hidden = k === 'multi' || k === 'sequence'
}

kindPicker.addEventListener('click', (e) => {
  const k = (e.target as HTMLElement).dataset.kind as DrillKind | undefined
  if (k) setKind(k)
})

const seqSelect = $<HTMLSelectElement>('#seq-select')

function populateSeqSelects(selected?: string) {
  const names = Object.keys(store.getSequences()).sort()
  for (const sel of [seqSelect, $<HTMLSelectElement>('#seq-load')]) {
    const keep = selected ?? sel.value
    sel.innerHTML = ''
    if (names.length === 0) {
      const opt = document.createElement('option')
      opt.value = ''
      opt.textContent = '— none saved —'
      sel.append(opt)
      continue
    }
    for (const name of names) {
      const opt = document.createElement('option')
      opt.value = name
      opt.textContent = name
      opt.selected = name === keep
      sel.append(opt)
    }
  }
}

function loadSettings() {
  const s = store.getSettings()
  if (s.kind) setKind(s.kind)
  if (s.string) stringSelect.value = String(s.string)
  if (s.poolName && FRET_POOLS[s.poolName]) poolSelect.value = s.poolName
  if (s.pattern?.length) patternInput.value = s.pattern.join(' ')
  if (s.startBpm) bpmInput.value = String(s.startBpm)
  if (s.beatsPerTarget) bptSelect.value = String(s.beatsPerTarget)
  if (s.audioPrompts !== undefined) audioCheck.checked = s.audioPrompts
  populateSeqSelects(s.seqName)
}

function readConfig(): DrillConfig | null {
  const pattern = patternInput.value
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 15)
  if (kind === 'pattern' && pattern.length < 2) {
    homeStatus.textContent = 'Pattern needs at least 2 frets, e.g. "3 7 10 7"'
    return null
  }
  const sequence = store.getSequences()[seqSelect.value] ?? []
  if (kind === 'sequence' && sequence.length < 2) {
    homeStatus.textContent = 'Pick a saved sequence (or create one with Edit)'
    return null
  }
  const cfg: DrillConfig = {
    kind,
    string: Number(stringSelect.value),
    fretPool: FRET_POOLS[poolSelect.value],
    pattern,
    sequence,
    startBpm: Math.min(200, Math.max(40, Number(bpmInput.value) || 60)),
    beatsPerTarget: Number(bptSelect.value),
    audioPrompts: audioCheck.checked,
  }
  const { sequence: _seq, ...settings } = cfg
  store.saveSettings({ ...settings, poolName: poolSelect.value, seqName: seqSelect.value })
  return cfg
}

// ---------- drill screen ----------

const drillBpm = $('#drill-bpm')
const drillScore = $('#drill-score')
const beatDot = $('#beat-dot')
const drillCard = $('#drill-card')
const tabCanvas = $<HTMLCanvasElement>('#tab-canvas')
const drillFeedback = $('#drill-feedback')
const drillHearing = $('#drill-hearing')

let session: DrillSession | null = null
let lastConfig: DrillConfig | null = null
let drillRaf = 0

function fmtMs(ms: number): string {
  return `${ms >= 0 ? '+' : '−'}${Math.abs(ms).toFixed(0)} ms`
}

function drillFrame() {
  if (session) renderTab(tabCanvas, session)
  if (tracker) {
    const { midi, cents } = tracker.live
    drillHearing.textContent =
      midi === null
        ? 'hearing: —'
        : `hearing: ${midiName(midi)} ${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`
  }
  drillRaf = requestAnimationFrame(drillFrame)
}

async function startDrill(cfg: DrillConfig) {
  homeStatus.textContent = ''
  let audio: { input: GuitarInput; tracker: PitchEventTracker }
  try {
    audio = await ensureInput()
  } catch {
    homeStatus.textContent = 'Could not open audio input — check permissions'
    return
  }
  const dev = currentDevice()
  const offset = dev ? store.getLatencyOffset(dev.id) : null
  if (offset === null) {
    homeStatus.textContent = `Calibrate latency for ${dev?.label || 'this input'} first — scoring needs it`
    return
  }

  lastConfig = cfg
  const drillLegend = $('#drill-legend')
  drillLegend.hidden = !(cfg.kind === 'sequence' && cfg.sequence.some((s) => s.finger))
  if (!drillLegend.hidden) fillLegend(drillLegend)
  drillFeedback.textContent = ''
  drillFeedback.className = 'drill-feedback'
  drillScore.textContent = '–'
  drillBpm.textContent = `${cfg.startBpm} bpm`
  show('screen-drill')
  cancelAnimationFrame(drillRaf)
  drillRaf = requestAnimationFrame(drillFrame)

  const ctx = audio.input.ctx
  const uiAt = (time: number, fn: () => void) =>
    setTimeout(fn, Math.max(0, (time - ctx.currentTime) * 1000))

  session = new DrillSession(audio.input, audio.tracker, cfg, offset, {
    onBeat(kind, time) {
      uiAt(time, () => {
        beatDot.className = ''
        void beatDot.offsetWidth // restart CSS animation
        beatDot.className = kind === 'land' ? 'pulse-land' : 'pulse-prep'
        if (kind === 'count') {
          drillFeedback.className = 'drill-feedback'
          drillFeedback.textContent = 'count-in — play each note as it crosses the line'
        }
      })
    },
    onResolve(r, state) {
      drillBpm.textContent = `${state.bpm} bpm`
      drillScore.textContent = `${state.hits}/${state.total} · streak ${state.streak}`
      const good = r.status === 'hit'
      drillFeedback.className = `drill-feedback ${good ? 'good' : 'bad'}`
      const want = midiName(r.target.midi)
      if (good) {
        drillFeedback.textContent = `✓ ${want} ${fmtMs(r.errorMs!)}`
      } else if (r.status === 'wrong') {
        drillFeedback.textContent = `✗ heard ${midiName(r.heard!.midi)} ${fmtMs(r.heard!.errorMs)} — wanted ${want}`
      } else if (r.heard) {
        drillFeedback.textContent = `✗ heard ${midiName(r.heard.midi)} ${fmtMs(r.heard.errorMs)} — off window`
      } else {
        drillFeedback.textContent = `✗ heard nothing — wanted ${want}`
      }
      drillCard.classList.remove('flash-hit', 'flash-miss')
      void drillCard.offsetWidth
      drillCard.classList.add(good ? 'flash-hit' : 'flash-miss')
    },
    onTempoChange(bpm, dir) {
      drillBpm.textContent = `${dir === 'up' ? '▲' : '▼'} ${bpm} bpm`
    },
  })
  session.start()
}

$('#drill-start').addEventListener('click', () => {
  const cfg = readConfig()
  if (cfg) void startDrill(cfg)
})

$('#drill-stop').addEventListener('click', () => {
  if (!session) return
  cancelAnimationFrame(drillRaf)
  const results = session.results
  const summary = session.stop()
  session = null
  store.saveSession(summary)
  renderSummary(summary, results)
  show('screen-summary')
})

// ---------- sequence editor ----------

const seqLoad = $<HTMLSelectElement>('#seq-load')
const seqName = $<HTMLInputElement>('#seq-name')
const seqText = $<HTMLTextAreaElement>('#seq-text')
const seqPreview = $<HTMLCanvasElement>('#seq-preview')
const seqStatus = $('#seq-status')

function fillLegend(el: HTMLElement) {
  el.innerHTML = Object.entries(FINGER_NAMES)
    .map(
      ([n, name]) =>
        `<span class="chip"><i style="background:${FINGER_COLORS[Number(n)]}"></i>${n} ${name}</span>`,
    )
    .join('')
}

function currentSteps(): SequenceStep[] | null {
  const parsed = parseSequence(seqText.value)
  if ('error' in parsed) {
    seqStatus.textContent = seqText.value.trim() ? parsed.error : ''
    renderSequencePreview(seqPreview, [])
    return null
  }
  seqStatus.textContent = `${parsed.steps.length} notes`
  renderSequencePreview(seqPreview, parsed.steps)
  return parsed.steps
}

function loadSequenceIntoEditor(name: string) {
  const steps = store.getSequences()[name]
  if (!steps) return
  seqName.value = name
  seqText.value = serializeSequence(steps)
  currentSteps()
}

$('#nav-seq-editor').addEventListener('click', () => {
  populateSeqSelects()
  if (seqSelect.value) loadSequenceIntoEditor(seqSelect.value)
  else currentSteps()
  show('screen-seqedit')
})

seqLoad.addEventListener('change', () => loadSequenceIntoEditor(seqLoad.value))
seqText.addEventListener('input', () => void currentSteps())

$('#seq-save').addEventListener('click', () => {
  const name = seqName.value.trim()
  if (!name) {
    seqStatus.textContent = 'Give the sequence a name first'
    return
  }
  const steps = currentSteps()
  if (!steps || steps.length < 2) {
    seqStatus.textContent = 'Need at least 2 valid notes to save'
    return
  }
  store.saveSequence(name, steps)
  populateSeqSelects(name)
  seqStatus.textContent = `Saved "${name}" (${steps.length} notes)`
})

$('#seq-delete').addEventListener('click', () => {
  const name = seqName.value.trim()
  if (!name || !store.getSequences()[name]) {
    seqStatus.textContent = 'Nothing to delete'
    return
  }
  store.deleteSequence(name)
  populateSeqSelects()
  seqStatus.textContent = `Deleted "${name}"`
})

$('#seq-back').addEventListener('click', () => {
  populateSeqSelects()
  show('screen-home')
})

// ---------- summary ----------

function renderSummary(s: SessionSummary, results: TargetResult[] = []) {
  $('#summary-headline').textContent = s.totalTargets
    ? `${Math.round(s.accuracy * 100)}% — ${s.hits}/${s.totalTargets} on time`
    : 'No targets played'
  $('#summary-stats').innerHTML = [
    `wrong note <b>${s.wrong}</b>`,
    `missed <b>${s.missed}</b>`,
    `tempo <b>${s.startBpm} → ${s.endBpm}</b>`,
    `peak <b>${s.maxBpm} bpm</b>`,
    s.avgAbsErrorMs !== null ? `avg timing <b>±${s.avgAbsErrorMs.toFixed(0)} ms</b>` : '',
  ]
    .filter(Boolean)
    .map((t) => `<span>${t}</span>`)
    .join('')

  const frets = Object.entries(s.perFret).sort(([a], [b]) => Number(a) - Number(b))
  $('#summary-frets').innerHTML = frets
    .map(([fret, { hits, total }]) => {
      const pct = total ? Math.round((hits / total) * 100) : 0
      return `<div class="fret-bar"><span>fret ${fret}</span><div class="bar"><div style="width:${pct}%"></div></div><span>${hits}/${total}</span></div>`
    })
    .join('')

  $('#summary-detail').innerHTML = results
    .filter((r) => r.status !== 'pending')
    .map((r) => {
      const want = `s${r.target.string} f${r.target.fret} (${midiName(r.target.midi)})`
      if (r.status === 'hit') {
        return `<span class="good">✓ ${want} — ${fmtMs(r.errorMs!)}</span>`
      }
      const heard = r.heard
        ? `heard ${midiName(r.heard.midi)} ${fmtMs(r.heard.errorMs)}`
        : 'heard nothing'
      const label = r.status === 'wrong' ? 'wrong' : 'miss'
      return `<span class="bad">✗ ${want} — ${label}: ${heard}</span>`
    })
    .join('')
}

$('#summary-again').addEventListener('click', () => {
  if (lastConfig) void startDrill(lastConfig)
})
$('#summary-home').addEventListener('click', () => show('screen-home'))

// ---------- tuner ----------

const noteName = $('#note-name')
const noteOctave = $('#note-octave')
const centsBar = $('#cents-bar')
const freqReadout = $('#freq-readout')
const positionsEl = $('#positions')
const levelMeter = $<HTMLProgressElement>('#level-meter')
const deviceSelect = $<HTMLSelectElement>('#device-select')

let tunerRaf = 0

function tunerFrame() {
  if (!tracker) return
  const { level, freq, midi, cents } = tracker.live
  levelMeter.value = Math.min(1, level * 20)
  if (midi === null || freq === null) {
    noteName.textContent = '–'
    noteOctave.textContent = ''
    freqReadout.textContent = '– Hz'
    positionsEl.textContent = ''
    centsBar.style.width = '0'
  } else {
    const name = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][
      ((midi % 12) + 12) % 12
    ]
    noteName.textContent = name
    noteOctave.textContent = String(Math.floor(midi / 12) - 1)
    freqReadout.textContent = `${freq.toFixed(1)} Hz  ${cents >= 0 ? '+' : ''}${cents.toFixed(0)}¢`
    positionsEl.textContent = fretPositions(midi)
      .map((p) => `s${p.string}·f${p.fret}`)
      .join('   ')
    const pct = Math.max(-50, Math.min(50, cents))
    centsBar.style.background = Math.abs(pct) < 10 ? 'var(--accent)' : 'var(--accent-off)'
    centsBar.style.left = pct >= 0 ? '50%' : `${50 + pct}%`
    centsBar.style.width = `${Math.abs(pct)}%`
  }
  tunerRaf = requestAnimationFrame(tunerFrame)
}

async function populateDevices() {
  const devices = await listInputs()
  const current = input?.stream.getAudioTracks()[0]?.getSettings().deviceId
  deviceSelect.innerHTML = ''
  for (const d of devices) {
    const opt = document.createElement('option')
    opt.value = d.deviceId
    opt.textContent = d.label || `Input ${deviceSelect.length + 1}`
    opt.selected = d.deviceId === current
    deviceSelect.append(opt)
  }
}

$('#nav-tuner').addEventListener('click', async () => {
  try {
    await ensureInput()
  } catch {
    homeStatus.textContent = 'Could not open audio input — check permissions'
    return
  }
  await populateDevices()
  show('screen-tuner')
  tunerRaf = requestAnimationFrame(tunerFrame)
})

$('#tuner-back').addEventListener('click', () => {
  cancelAnimationFrame(tunerRaf)
  show('screen-home')
})

deviceSelect.addEventListener('change', async () => {
  await ensureInput(deviceSelect.value)
  await populateDevices()
})

navigator.mediaDevices.addEventListener('devicechange', () => {
  if (input) void populateDevices()
})

// ---------- calibration ----------

const calStatus = $('#cal-status')

$('#nav-calibrate').addEventListener('click', async () => {
  try {
    await ensureInput()
  } catch {
    homeStatus.textContent = 'Could not open audio input — check permissions'
    return
  }
  const dev = currentDevice()
  const existing = dev ? store.getLatencyOffset(dev.id) : null
  const name = dev?.label || 'current input'
  calStatus.textContent =
    existing !== null
      ? `${name}: ${(existing * 1000).toFixed(0)} ms offset saved`
      : `${name}: not calibrated yet`
  show('screen-calibrate')
})

$('#cal-start').addEventListener('click', async () => {
  if (!input || !tracker) return
  const btn = $<HTMLButtonElement>('#cal-start')
  btn.disabled = true
  try {
    const result = await calibrate(input, tracker, 80, (n, total) => {
      calStatus.textContent = `Click ${n} / ${total} — play on the click`
    })
    const dev = currentDevice()
    store.setLatencyOffset(dev?.id ?? '', result.offset)
    calStatus.textContent = `Done: ${(result.offset * 1000).toFixed(0)} ms offset (${result.samples} samples) — saved for ${dev?.label || 'this input'}`
    updateInputStatus()
  } catch (err) {
    calStatus.textContent = err instanceof Error ? err.message : String(err)
  }
  btn.disabled = false
})

$('#cal-back').addEventListener('click', () => show('screen-home'))

// ---------- init ----------

loadSettings()
fillLegend($('#seq-legend'))
updateInputStatus()
{
  const saved = store.getPreferredDevice()
  if (!saved || store.getLatencyOffset(saved.id) === null) {
    homeStatus.textContent =
      'First time: pick your input in "Tuner check", then run "Calibrate latency"'
  }
}
