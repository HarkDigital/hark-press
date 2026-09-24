import type { Frame } from '../core/types'
import type { EngineState } from '../core/Engine'

/*
 * Print-shop foley. WebAudio only, no files, no music: the room a riso
 * duplicator lives in.
 *
 *   room     a warm low room tone (brown noise under 240 Hz that breathes),
 *            a faint mains hum from the strip lights, a whisper of air
 *   drum     the duplicator's rhythmic thrum: every revolution a soft drum
 *            "whump", the feed roller's "chk" grabbing a sheet and a short
 *            paper slide, with a lighter roller tick on the off-beat. The
 *            press idles slow and quiet, and runs faster and louder with
 *            scroll velocity (scheduled ahead on the audio clock)
 *   cut()    a sheet of paper: crinkly rustle, an air swish, the sheet
 *            landing on the tray and the roller clack
 *   blip()   a light fingertip tap (nav hover)
 *   stamp()  a rubber-stamp thunk: impact, then the peel as it lifts
 *   fold()   a crease being run down a fold
 *   tone()   a pure sine a chapter may ask for (or via 'hark:tone' events)
 *
 * Chapters can trigger foley without touching the chrome:
 *   window.dispatchEvent(new CustomEvent('hark:sfx', { detail: { kind: 'stamp', level: 0.8 } }))
 * kinds: 'stamp' | 'tap' | 'rustle' | 'fold' (a no-op while sound is off).
 *
 * Off by default. Sound only ever starts from a user gesture: the toggle's
 * own click / tap / Enter / Space. A remembered "on" (localStorage) waits for
 * the first real activation (a pointer press or tap, or Enter / Space on a
 * control; never Tab, Shift or scrolling keys). Faded out and suspended while
 * the tab is hidden. On iOS the session is switched to "playback" so the
 * silent switch does not swallow it.
 */

export const STORE_KEY = 'hark-press:audio'

/** The remembered choice: true (on), false (off), or null when never set. */
export function storedAudio(): boolean | null {
  try {
    const v = localStorage.getItem(STORE_KEY)
    return v === '1' ? true : v === '0' ? false : null
  } catch {
    return null
  }
}

/** keys that activate a focused control; everything else (Tab, Shift, arrows, PageDown…) is navigation */
const ACTIVATE_KEYS = new Set(['Enter', ' ', 'Spacebar'])
const CONTROL = 'a[href], button, [role="button"], [role="switch"], summary, input, select, textarea'
const MASTER_LEVEL = 0.62
const TONE_MAX = 0.08
/** a chapter that stops sending 'hark:tone' without a level 0 gets released after this */
const TONE_STALE_MS = 280
/** drum revolutions per second: idling → running flat out */
const IDLE_RATE = 0.55
const RUN_RATE = 2.3
const LOOKAHEAD = 0.14

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

type SfxKind = 'stamp' | 'tap' | 'rustle' | 'fold'

function noiseBuffer(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  }
  return buf
}

/** Brownian (red) noise: the warm rumble of a room with machines in it. Loop-safe. */
function brownBuffer(ctx: AudioContext, seconds: number) {
  const len = Math.floor(ctx.sampleRate * seconds)
  const buf = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c)
    let last = 0
    for (let i = 0; i < len; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02
      d[i] = last * 3.5
    }
    // crossfade the tail into the head so the loop never clicks
    const fade = Math.min(4096, len >> 3)
    for (let i = 0; i < fade; i++) {
      const t = i / fade
      d[i] = d[i] * t + d[len - fade + i] * (1 - t)
    }
  }
  return buf
}

/**
 * iOS routes Web Audio through the "ambient" session, which the ring/silent
 * switch mutes. Safari 16.4+ lets a page opt into "playback"; hand it back to
 * "auto" when muted. Feature-detected; a no-op elsewhere.
 */
function setAudioSession(type: 'playback' | 'auto') {
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session && session.type !== type) session.type = type
  } catch {
    /* unsupported */
  }
}

export class Sound {
  enabled = false
  onChange: ((enabled: boolean) => void)[] = []

  private ctx: AudioContext | null = null
  private master!: GainNode
  private analyser!: AnalyserNode
  private scope: Float32Array<ArrayBuffer> = new Float32Array(512)
  /** foley bus (everything but the room) */
  private fx!: GainNode
  private room!: GainNode
  private white!: AudioBuffer
  private toneOsc!: OscillatorNode
  private toneGain!: GainNode

  // the drum: a lookahead scheduler on the audio clock
  private speed = 0
  private nextBeat = 0
  private beatN = 0
  private beats: number[] = []
  private schedTimer = 0

  private lastCut = 0
  private lastBlip = 0
  private lastStamp = 0
  private suspendTimer = 0
  private hidden = typeof document !== 'undefined' && document.hidden
  /** a remembered "on" preference waiting for the first user gesture */
  private armed = false
  private gestureBound = false

  // requested pure tone (kept even while muted so it applies the moment sound starts)
  private toneHz = 432
  private toneLevel = 0
  private toneAt = 0
  private toneSent = { hz: 0, level: -1 }

  constructor() {
    this.armed = storedAudio() === true
    if (this.armed) this.waitForGesture()
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden
      this.applyRunning()
    })
    // an explicit on/off from elsewhere (must itself come from a gesture)
    window.addEventListener('hark:audio', e => {
      const d = (e as CustomEvent<{ on?: boolean }>).detail
      if (d && typeof d.on === 'boolean') this.set(d.on)
    })
    window.addEventListener('hark:tone', e => {
      const d = (e as CustomEvent<{ hz?: number; level?: number }>).detail
      if (d && typeof d.hz === 'number') this.tone(d.hz, d.level ?? 0)
    })
    window.addEventListener('hark:sfx', e => {
      const d = (e as CustomEvent<{ kind?: SfxKind; level?: number }>).detail
      if (d?.kind) this.sfx(d.kind, d.level ?? 1)
    })
  }

  /** Flip sound on/off. Call from a user gesture (click / key). */
  toggle() {
    this.armed = false
    this.setEnabled(!this.enabled)
    this.persist(this.enabled)
  }

  /** Set sound on/off and remember the choice (even when it is unchanged). */
  set(on: boolean) {
    this.armed = false
    this.setEnabled(on)
    this.persist(on)
  }

  /** Release any requested tone at once (e.g. while the scene is covered and chapters stop updating). */
  hush() {
    this.speed = 0
    if (this.toneLevel === 0) return
    this.toneLevel = 0
    this.applyTone()
  }

  /** Current output level 0..1. 0 while muted. */
  meter() {
    if (!this.live()) return 0
    this.analyser.getFloatTimeDomainData(this.scope)
    let s = 0
    for (let i = 0; i < this.scope.length; i++) s += this.scope[i] * this.scope[i]
    const rms = Math.sqrt(s / this.scope.length)
    const db = 20 * Math.log10(rms + 1e-9)
    return clamp01((db + 56) / 40)
  }

  /**
   * The drum's heartbeat for the chrome: 0..1, jumping to 1 on each
   * revolution the listener actually hears and decaying after. `which`
   * 0..2 reads the pink / green / black drum (each fires a little later).
   */
  pulse(which = 0) {
    const ctx = this.live()
    if (!ctx) return 0
    const now = ctx.currentTime - which * 0.07
    let last = -1
    for (const b of this.beats) if (b <= now && b > last) last = b
    if (last < 0) return 0
    return Math.exp(-(now - last) * 7)
  }

  /** A light fingertip tap (nav hover). No-op while sound is off. */
  blip(pitch = 0) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastBlip < 0.05) return
    this.lastBlip = now
    const p = Math.abs(pitch) % 5
    this.noiseHit(ctx, now, { type: 'lowpass', f: 2200 + p * 180, q: 0.8, level: 0.045, attack: 0.001, decay: 0.014 })
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.frequency.setValueAtTime(240 + p * 22, now)
    o.frequency.exponentialRampToValueAtTime(110, now + 0.045)
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.04, now + 0.002)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.07)
    o.connect(g)
    g.connect(this.fx)
    o.start(now)
    o.stop(now + 0.08)
  }

  /** A rubber stamp hitting the sheet, then peeling off (nav clicks). */
  stamp(level = 1) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (now - this.lastStamp < 0.08) return
    this.lastStamp = now
    const a = clamp01(level)
    // the thunk: a felt-backed body under a rubber face
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.type = 'sine'
    o.frequency.setValueAtTime(150, now)
    o.frequency.exponentialRampToValueAtTime(52, now + 0.11)
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.32 * a, now + 0.004)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.26)
    o.connect(g)
    g.connect(this.fx)
    o.start(now)
    o.stop(now + 0.3)
    // the impact on the paper
    this.noiseHit(ctx, now, { type: 'lowpass', f: 1100, q: 0.7, level: 0.16 * a, attack: 0.001, decay: 0.035 })
    // and the peel as it lifts
    this.noiseHit(ctx, now + 0.15, { type: 'bandpass', f: 2600, q: 1.6, level: 0.05 * a, attack: 0.004, decay: 0.03 })
  }

  /** A crease run down a fold. */
  fold(level = 1) {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const a = clamp01(level)
    const src = this.noiseSource(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.3
    bp.frequency.setValueAtTime(3400, now)
    bp.frequency.exponentialRampToValueAtTime(1300, now + 0.16)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    g.gain.linearRampToValueAtTime(0.09 * a, now + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.19)
    src.connect(bp)
    bp.connect(g)
    g.connect(this.fx)
    src.start(now, Math.random() * 2)
    src.stop(now + 0.22)
    this.noiseHit(ctx, now + 0.17, { type: 'bandpass', f: 1800, q: 2, level: 0.05 * a, attack: 0.001, decay: 0.02 })
  }

  /** A chapter may request a pure tone; level 0..1, 0 releases it. */
  tone(hzIn: number, level: number) {
    if (!Number.isFinite(hzIn) || !Number.isFinite(level)) return
    this.toneHz = Math.min(6000, Math.max(20, hzIn))
    this.toneLevel = clamp01(level)
    this.toneAt = performance.now()
    this.applyTone()
  }

  /** called every frame */
  update(frame: Frame, _state: EngineState) {
    // a chapter that went quiet without saying so gets released
    if (this.toneLevel > 0 && performance.now() - this.toneAt > TONE_STALE_MS) {
      this.toneLevel = 0
      this.applyTone()
    }
    // the press runs as fast as the reader pulls paper through it
    const want = clamp01(Math.abs(frame.velocity) / 2.2)
    const k = 1 - Math.exp(-(want > this.speed ? 5 : 1.6) * frame.dt)
    this.speed += (want - this.speed) * k
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    // the room opens up a touch while the press runs
    this.room.gain.setTargetAtTime(0.9 + this.speed * 0.25, now, 0.4)
  }

  /** called when the story cuts from chapter `from` to `to`: a sheet feeds through */
  cut(from: number, to: number) {
    void from
    void to
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    const since = now - this.lastCut
    if (since < 0.25) return
    this.lastCut = now
    this.rustle(ctx, now, since < 1.2 ? 0.55 : 1)
  }

  sfx(kind: SfxKind, level = 1) {
    if (kind === 'stamp') this.stamp(level)
    else if (kind === 'tap') this.blip(Math.round(level * 4))
    else if (kind === 'fold') this.fold(level)
    else if (kind === 'rustle') {
      const ctx = this.live()
      if (ctx) this.rustle(ctx, ctx.currentTime, clamp01(level))
    }
  }

  // ------------------------------------------------------------------ internals

  /** The running context, or null when sound is off / suspended / hidden. */
  private live() {
    const ctx = this.ctx
    if (!ctx || !this.enabled || this.hidden || ctx.state !== 'running') return null
    return ctx
  }

  private noiseSource(ctx: AudioContext) {
    const src = ctx.createBufferSource()
    src.buffer = this.white
    return src
  }

  /** a short filtered noise burst */
  private noiseHit(
    ctx: AudioContext,
    t: number,
    o: { type: BiquadFilterType; f: number; q: number; level: number; attack: number; decay: number; pan?: number },
  ) {
    const src = this.noiseSource(ctx)
    const f = ctx.createBiquadFilter()
    f.type = o.type
    f.frequency.value = o.f
    f.Q.value = o.q
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(o.level, t + o.attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.attack + o.decay)
    src.connect(f)
    f.connect(g)
    if (o.pan) {
      const p = ctx.createStereoPanner()
      p.pan.value = o.pan
      g.connect(p)
      p.connect(this.fx)
    } else g.connect(this.fx)
    src.start(t, Math.random() * 2)
    src.stop(t + o.attack + o.decay + 0.02)
  }

  /** One revolution of the drum at audio time t, amplitude a (0..1). */
  private drumBeat(ctx: AudioContext, t: number, a: number, period: number) {
    // the drum: a soft, round whump
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 380
    o.type = 'triangle'
    o.frequency.setValueAtTime(74, t)
    o.frequency.exponentialRampToValueAtTime(43, t + 0.17)
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.2 * a, t + 0.012)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34)
    o.connect(lp)
    lp.connect(g)
    g.connect(this.fx)
    o.start(t)
    o.stop(t + 0.36)
    // the knock of the drum clamp: the part small laptop and phone speakers can play
    const kn = ctx.createOscillator()
    const kg = ctx.createGain()
    kn.type = 'sine'
    kn.frequency.setValueAtTime(215, t)
    kn.frequency.exponentialRampToValueAtTime(128, t + 0.05)
    kg.gain.setValueAtTime(0, t)
    kg.gain.linearRampToValueAtTime(0.075 * a, t + 0.003)
    kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.09)
    kn.connect(kg)
    kg.connect(this.fx)
    kn.start(t)
    kn.stop(t + 0.1)
    // the feed roller grabs a sheet
    const pan = (this.beatN % 2 ? 1 : -1) * 0.18
    this.noiseHit(ctx, t + 0.045, { type: 'bandpass', f: 1900, q: 1, level: 0.055 * a, attack: 0.002, decay: 0.04, pan })
    // the sheet slides across the drum
    this.noiseHit(ctx, t + 0.03, { type: 'highpass', f: 2600, q: 0.5, level: 0.022 * a, attack: 0.05, decay: 0.16, pan: -pan })
    // a lighter roller tick on the off-beat
    this.noiseHit(ctx, t + period * 0.5, { type: 'bandpass', f: 3300, q: 2.6, level: 0.018 * a, attack: 0.001, decay: 0.018 })
    this.beatN++
  }

  /** keep the drum's revolutions scheduled a little ahead on the audio clock */
  private schedule = () => {
    const ctx = this.live()
    if (!ctx) return
    const now = ctx.currentTime
    if (this.nextBeat < now) this.nextBeat = now + 0.06
    while (this.nextBeat < now + LOOKAHEAD) {
      const s = this.speed
      const rate = IDLE_RATE + (RUN_RATE - IDLE_RATE) * s
      const period = 1 / rate
      const a = 0.26 + 0.74 * s
      this.drumBeat(ctx, this.nextBeat, a, period)
      this.beats.push(this.nextBeat)
      this.nextBeat += period
    }
    // forget beats nobody can still be hearing
    while (this.beats.length && this.beats[0] < now - 2) this.beats.shift()
  }

  /** a sheet of newsprint: rustle, swish, lands on the tray, the roller clacks */
  private rustle(ctx: AudioContext, now: number, level: number) {
    // crinkle: a noise band sweeping up, gated by a burst of tiny crackles
    const src = this.noiseSource(ctx)
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 1.1
    bp.frequency.setValueAtTime(1500, now)
    bp.frequency.exponentialRampToValueAtTime(4600, now + 0.34)
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, now)
    let t = now + 0.005
    for (let i = 0; i < 11; i++) {
      const peak = (0.05 + Math.random() * 0.09) * level
      g.gain.linearRampToValueAtTime(peak, t + 0.004)
      g.gain.exponentialRampToValueAtTime(0.004, t + 0.004 + 0.012 + Math.random() * 0.02)
      t += 0.022 + Math.random() * 0.024
    }
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05)
    src.connect(bp)
    bp.connect(g)
    g.connect(this.fx)
    src.start(now, Math.random() * 2)
    src.stop(t + 0.08)

    // air swish as the sheet travels
    const air = this.noiseSource(ctx)
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 1100
    const ag = ctx.createGain()
    ag.gain.setValueAtTime(0, now)
    ag.gain.linearRampToValueAtTime(0.05 * level, now + 0.13)
    ag.gain.exponentialRampToValueAtTime(0.0001, now + 0.42)
    const pan = ctx.createStereoPanner()
    pan.pan.setValueAtTime(-0.4, now)
    pan.pan.linearRampToValueAtTime(0.4, now + 0.4)
    air.connect(hp)
    hp.connect(ag)
    ag.connect(pan)
    pan.connect(this.fx)
    air.start(now, Math.random() * 2)
    air.stop(now + 0.45)

    // it lands on the tray…
    const land = now + 0.3
    const o = ctx.createOscillator()
    const og = ctx.createGain()
    o.frequency.setValueAtTime(105, land)
    o.frequency.exponentialRampToValueAtTime(50, land + 0.2)
    og.gain.setValueAtTime(0, land)
    og.gain.linearRampToValueAtTime(0.13 * level, land + 0.01)
    og.gain.exponentialRampToValueAtTime(0.0001, land + 0.3)
    o.connect(og)
    og.connect(this.fx)
    o.start(land)
    o.stop(land + 0.32)
    // …and the roller clacks back
    this.noiseHit(ctx, land + 0.02, { type: 'bandpass', f: 1500, q: 1.4, level: 0.06 * level, attack: 0.001, decay: 0.028 })
  }

  private applyTone() {
    const ctx = this.live()
    if (!ctx) return
    const lv = this.toneLevel * TONE_MAX
    const s = this.toneSent
    if (Math.abs(s.hz - this.toneHz) < 0.05 && Math.abs(s.level - lv) < 0.0005) return
    const now = ctx.currentTime
    this.toneOsc.frequency.setTargetAtTime(this.toneHz, now, 0.035)
    this.toneGain.gain.setTargetAtTime(lv, now, lv > s.level ? 0.07 : 0.16)
    s.hz = this.toneHz
    s.level = lv
  }

  private setEnabled(on: boolean) {
    if (on === this.enabled) return
    this.enabled = on
    setAudioSession(on ? 'playback' : 'auto')
    if (on) this.ensureGraph()
    this.applyRunning()
    for (const fn of this.onChange) fn(on)
  }

  private persist(on: boolean) {
    try {
      localStorage.setItem(STORE_KEY, on ? '1' : '0')
    } catch {
      /* storage blocked: the choice lasts for this visit */
    }
  }

  /** Resume + fade in, or fade out + suspend, based on enabled/hidden. */
  private applyRunning() {
    const ctx = this.ctx
    if (!ctx) return
    clearTimeout(this.suspendTimer)
    window.clearInterval(this.schedTimer)
    const now = ctx.currentTime
    if (this.enabled && !this.hidden) {
      ctx
        .resume()
        .then(() => {
          if (!this.enabled || this.hidden) return
          if (ctx.state !== 'running') return this.waitForGesture()
          const t = ctx.currentTime
          this.master.gain.cancelScheduledValues(t)
          this.master.gain.setValueAtTime(this.master.gain.value, t)
          this.master.gain.setTargetAtTime(MASTER_LEVEL, t, 0.35)
          this.toneSent.level = -1
          this.applyTone()
          this.nextBeat = t + 0.25
          window.clearInterval(this.schedTimer)
          this.schedTimer = window.setInterval(this.schedule, 30)
          this.schedule()
        })
        .catch(() => this.waitForGesture())
    } else {
      this.master.gain.cancelScheduledValues(now)
      this.master.gain.setValueAtTime(this.master.gain.value, now)
      this.master.gain.setTargetAtTime(0, now, this.hidden ? 0.05 : 0.18)
      this.beats.length = 0
      this.suspendTimer = window.setTimeout(
        () => {
          if (!this.enabled || this.hidden) ctx.suspend().catch(() => {})
        },
        this.hidden ? 300 : 1200,
      )
    }
  }

  /** Start audio on the first real gesture (remembered preference / blocked resume). */
  private waitForGesture() {
    if (this.gestureBound) return
    this.gestureBound = true
    const events = ['pointerdown', 'click', 'touchend', 'keydown'] as const
    const handler = (e: Event) => {
      // keyboard: only Enter / Space aimed at a control counts as "play"; Tab,
      // Shift+Tab, arrows, PageDown and Space-to-scroll are just moving around
      if (e instanceof KeyboardEvent) {
        if (!ACTIVATE_KEYS.has(e.key) || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
        if (!(e.target as Element | null)?.closest?.(CONTROL)) return
      }
      for (const ev of events) window.removeEventListener(ev, handler, true)
      this.gestureBound = false
      const onToggle = (e.target as Element | null)?.closest?.('[data-sound-toggle]')
      if (this.armed) {
        this.armed = false
        // the toggle's own click decides for itself
        if (!onToggle) this.setEnabled(true)
      } else if (this.enabled) this.applyRunning()
    }
    for (const ev of events) window.addEventListener(ev, handler, true)
  }

  private ensureGraph() {
    if (this.ctx) return
    const AC =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!AC) return
    const ctx = new AC({ latencyHint: 'interactive' })
    this.ctx = ctx
    const now = ctx.currentTime
    this.white = noiseBuffer(ctx, 3)

    // master → high-pass → glue compression → analyser → out
    this.master = ctx.createGain()
    this.master.gain.value = 0
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 28
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -16
    comp.knee.value = 14
    comp.ratio.value = 3
    comp.attack.value = 0.006
    comp.release.value = 0.25
    this.analyser = ctx.createAnalyser()
    this.analyser.fftSize = 512
    this.master.connect(hp)
    hp.connect(comp)
    comp.connect(this.analyser)
    this.analyser.connect(ctx.destination)

    // foley bus with a touch of small-room slap (a short feedback delay, darkened)
    this.fx = ctx.createGain()
    this.fx.connect(this.master)
    const slap = ctx.createDelay(0.2)
    slap.delayTime.value = 0.043
    const fb = ctx.createGain()
    fb.gain.value = 0.22
    const dark = ctx.createBiquadFilter()
    dark.type = 'lowpass'
    dark.frequency.value = 1800
    const wet = ctx.createGain()
    wet.gain.value = 0.3
    this.fx.connect(slap)
    slap.connect(dark)
    dark.connect(fb)
    fb.connect(slap)
    dark.connect(wet)
    wet.connect(this.master)

    // the room: warm low rumble that breathes, strip-light hum, a whisper of air
    this.room = ctx.createGain()
    this.room.gain.value = 0.9
    this.room.connect(this.master)
    const rumble = ctx.createBufferSource()
    rumble.buffer = brownBuffer(ctx, 5)
    rumble.loop = true
    const rumbleLP = ctx.createBiquadFilter()
    rumbleLP.type = 'lowpass'
    rumbleLP.frequency.value = 240
    rumbleLP.Q.value = 0.3
    const rumbleGain = ctx.createGain()
    rumbleGain.gain.value = 0.11
    const breath = ctx.createOscillator()
    breath.frequency.value = 0.08
    const breathDepth = ctx.createGain()
    breathDepth.gain.value = 0.025
    breath.connect(breathDepth)
    breathDepth.connect(rumbleGain.gain)
    rumble.connect(rumbleLP)
    rumbleLP.connect(rumbleGain)
    rumbleGain.connect(this.room)
    rumble.start(now)
    breath.start(now)

    for (const [f, lv] of [
      [60, 0.0045],
      [120, 0.0028],
      [180, 0.0009],
    ] as const) {
      const o = ctx.createOscillator()
      o.frequency.value = f
      const g = ctx.createGain()
      g.gain.value = lv
      o.connect(g)
      g.connect(this.room)
      o.start(now)
    }

    const air = ctx.createBufferSource()
    air.buffer = this.white
    air.loop = true
    const airBP = ctx.createBiquadFilter()
    airBP.type = 'bandpass'
    airBP.frequency.value = 900
    airBP.Q.value = 0.4
    const airGain = ctx.createGain()
    airGain.gain.value = 0.0035
    air.connect(airBP)
    airBP.connect(airGain)
    airGain.connect(this.room)
    air.start(now)

    // requested pure tone
    this.toneOsc = ctx.createOscillator()
    this.toneOsc.type = 'sine'
    this.toneOsc.frequency.value = this.toneHz
    this.toneGain = ctx.createGain()
    this.toneGain.gain.value = 0
    this.toneOsc.connect(this.toneGain)
    this.toneGain.connect(this.master)
    this.toneOsc.start(now)
  }
}
