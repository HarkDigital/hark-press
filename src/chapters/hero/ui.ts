import * as THREE from 'three'
import { BRAND, MICROCOPY } from '../../content'
import { Callout, el, rise, setRise } from '../../core/dom'
import { clamp } from '../../core/math'
import { INK_NAME, REG_MM } from './shared'

/** A 0..1 visibility triggered by scroll but run on time, so it always settles. */
class Gate {
  v = 0
  constructor(
    private inS = 0.35,
    private outS = 0.2,
  ) {}
  step(on: boolean, dt: number) {
    this.v = clamp(this.v + (on ? dt / this.inS : -dt / this.outS))
    return this.v * this.v * (3 - 2 * this.v)
  }
}

export interface PosterRect {
  x: number
  y: number
  w: number
  h: number
  /** title size in px */
  fs: number
  port: boolean
}

/**
 * The hero's paper: a job ticket taped to the mat (the colophon), the scroll
 * hint, the press readout (pass + register), a callout on a registration
 * target, and the poster copy that is laid into the pulled print.
 */
export class HeroUI {
  root: HTMLDivElement
  private ticket: HTMLElement
  private ticketText: HTMLElement
  private hint: HTMLElement
  private readout: HTMLElement
  private passNum: HTMLElement
  private passInk: HTMLElement
  private chips: HTMLElement[] = []
  private reg: HTMLElement
  private regState: HTMLElement
  private poster: HTMLElement
  private credit: HTMLElement
  private title: HTMLElement
  private ctas: HTMLElement
  callout: Callout
  private calloutGate = new Gate(0.3, 0.18)
  private probe: HTMLElement
  safe = { top: 96, bottom: 90, side: 24 }
  private last = { pass: '', ink: '', reg: '', chips: -1, rect: '', shift: '', state: '' }

  constructor(stage: HTMLElement) {
    this.root = el('div', 'hero-root', undefined, stage)
    this.probe = el('div', 'hero-safe-probe', undefined, this.root)
    this.measureSafe()
    window.addEventListener('resize', () => this.measureSafe())

    // --- job ticket (colophon) ---
    this.ticket = el('div', 'hero-ticket', undefined, this.root)
    el('span', 'hero-ticket__tape', undefined, this.ticket)
    const head = el('div', 'hero-ticket__head', undefined, this.ticket)
    el('p', 'hud-eyebrow', MICROCOPY.signalEyebrow, head)
    el('span', 'hero-ticket__no', 'Job 26-001', head)
    this.ticketText = rise(el('p', 'hero-ticket__text', undefined, this.ticket), BRAND.manifesto)
    const spec = el('dl', 'hero-ticket__spec', undefined, this.ticket)
    const row = (k: string, v: string) => {
      const d = el('div', '', undefined, spec)
      el('dt', '', k, d)
      return el('dd', '', v, d)
    }
    row('Client', BRAND.name)
    const inks = row('Inks', '')
    inks.innerHTML =
      '<i class="hero-swatch hero-swatch--p"></i><i class="hero-swatch hero-swatch--g"></i><i class="hero-swatch hero-swatch--k"></i><span>3 / C riso</span>'
    row('Stock', 'Newsprint 80#')
    row('Printed', BRAND.locale)

    // --- scroll hint ---
    this.hint = el('div', 'hero-hint', undefined, this.root)
    const arrow = el('span', 'hero-hint__arrow', undefined, this.hint)
    arrow.innerHTML =
      '<svg viewBox="0 0 16 22" aria-hidden="true"><path d="M8 1v18M2 13l6 7 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>'
    el('span', 'hero-hint__label', MICROCOPY.scrollHint, this.hint)

    // --- press readout ---
    this.readout = el('div', 'hero-readout', undefined, this.root)
    const r1 = el('div', 'hero-readout__row', undefined, this.readout)
    el('span', 'hero-readout__k', 'Pass', r1)
    this.passNum = el('b', 'hero-readout__v', '1 / 3', r1)
    this.passInk = el('span', 'hero-readout__ink', INK_NAME[0], r1)
    const chips = el('div', 'hero-readout__chips', undefined, r1)
    for (const c of ['k', 'g', 'p']) this.chips.push(el('i', `hero-chip hero-chip--${c}`, undefined, chips))
    const r2 = el('div', 'hero-readout__row hero-readout__row--reg', undefined, this.readout)
    el('span', 'hero-readout__k', 'Register', r2)
    this.reg = el('b', 'hero-readout__v hero-readout__reg', `${REG_MM.toFixed(1)} mm`, r2)
    el('span', 'hero-readout__to', '→ 0.0 mm', r2)
    this.regState = el('span', 'hero-readout__state', 'Adjusting', r2)

    // --- a callout on the top-right registration target ---
    this.callout = new Callout(this.root, { side: 'left', offset: { x: 56, y: -44 } })
    this.callout.root.classList.add('hero-callout')
    this.callout.label.textContent = 'Reg. target'

    // --- the poster copy, laid into the pulled print ---
    this.poster = el('div', 'hero-poster', undefined, this.root)
    el('span', 'hero-poster__tape', undefined, this.poster)
    this.credit = el('p', 'hero-poster__credit', `${BRAND.name} · ${BRAND.locale}`, this.poster)
    this.title = rise(el('h2', 'hud-title hero-title', undefined, this.poster), 'Make the <br>internet <br><em>listen.</em>')
    this.ctas = el('div', 'hero-ctas', undefined, this.poster)
    const work = el('button', 'hud-btn', 'See the work', this.ctas)
    work.type = 'button'
    work.addEventListener('click', () => window.__hark?.land('work'))
    const contact = el('a', 'hud-btn hud-btn--ghost', 'Start a project', this.ctas)
    contact.href = '#contact'
    contact.addEventListener('click', e => {
      e.preventDefault()
      window.__hark?.land('contact')
    })
  }

  /** The chrome's safe bands, measured once and on resize (never per frame). */
  measureSafe() {
    const r = this.probe.getBoundingClientRect()
    const host = this.root.getBoundingClientRect()
    if (host.height < 10) {
      requestAnimationFrame(() => this.measureSafe())
      return
    }
    this.safe.top = r.top - host.top
    this.safe.bottom = host.bottom - r.bottom
    this.safe.side = r.left - host.left
  }

  setPoster(rect: PosterRect) {
    const key = `${rect.x.toFixed(1)}|${rect.y.toFixed(1)}|${rect.w.toFixed(1)}|${rect.h.toFixed(1)}|${rect.fs.toFixed(1)}|${rect.port}`
    if (key === this.last.rect) return
    this.last.rect = key
    const s = this.poster.style
    s.setProperty('--px', `${rect.x.toFixed(1)}px`)
    s.setProperty('--py', `${rect.y.toFixed(1)}px`)
    s.setProperty('--pw', `${rect.w.toFixed(1)}px`)
    s.setProperty('--ph', `${rect.h.toFixed(1)}px`)
    s.setProperty('--fs', `${rect.fs.toFixed(1)}px`)
    this.poster.classList.toggle('is-port', rect.port)
  }

  update(p: {
    local: number
    intro: number
    pass: number
    done: number
    err: number
    posterOn: boolean
    shiftX: number
    shiftY: number
    calloutWorld: THREE.Vector3
    calloutOn: boolean
    camera: THREE.Camera
    w: number
    h: number
    dt: number
  }) {
    const { local } = p
    const intro = p.intro
    const ticketOn = intro > 0.35 && local < 0.085
    this.ticket.classList.toggle('is-in', ticketOn)
    setRise(this.ticketText, ticketOn)
    this.hint.classList.toggle('is-in', intro > 0.8 && local < 0.06)

    const readOn = local > 0.115 && local < 0.6
    this.readout.classList.toggle('is-in', readOn)
    if (readOn) {
      const pass = `${Math.min(3, p.pass + 1)} / 3`
      if (pass !== this.last.pass) this.passNum.textContent = this.last.pass = pass
      const ink = INK_NAME[Math.min(2, p.pass)]
      if (ink !== this.last.ink) this.passInk.textContent = this.last.ink = ink
      if (p.done !== this.last.chips) {
        this.last.chips = p.done
        this.chips.forEach((c, i) => c.classList.toggle('is-on', i < p.done))
      }
      const reg = `${(p.err * REG_MM).toFixed(1)} mm`
      if (reg !== this.last.reg) this.reg.textContent = this.last.reg = reg
      const state = p.err <= 0.001 ? 'In register' : p.done < 3 ? 'Proofing' : 'Adjusting'
      if (state !== this.last.state) {
        this.regState.textContent = this.last.state = state
        this.readout.classList.toggle('is-registered', p.err <= 0.001)
      }
    }

    // callout: only while its dot and label sit inside the safe area
    const v = this.calloutGate.step(p.calloutOn && this.inside(p.calloutWorld, p.camera, p.w, p.h), p.dt)
    this.callout.update(p.calloutWorld, p.camera, p.w, p.h, v)
    const cl = p.err <= 0.001 ? 'In register' : `Reg. target · Δ ${(p.err * REG_MM).toFixed(1)}`
    if (v > 0 && this.callout.label.textContent !== cl) this.callout.label.textContent = cl

    this.poster.classList.toggle('is-in', p.posterOn)
    setRise(this.title, p.posterOn)
    const shift = `${p.shiftX.toFixed(1)},${p.shiftY.toFixed(1)}`
    if (shift !== this.last.shift) {
      this.last.shift = shift
      this.poster.style.transform = p.shiftX || p.shiftY ? `translate3d(${p.shiftX.toFixed(1)}px, ${p.shiftY.toFixed(1)}px, 0)` : ''
    }
  }

  private inside(world: THREE.Vector3, camera: THREE.Camera, w: number, h: number) {
    _p.copy(world).project(camera)
    if (_p.z > 1 || !Number.isFinite(_p.x)) return false
    const x = (_p.x * 0.5 + 0.5) * w
    const y = (-_p.y * 0.5 + 0.5) * h
    const m = this.safe
    return y - 60 > m.top && y + 10 < h - m.bottom && x > m.side + 150 && x < w - m.side
  }
}

const _p = new THREE.Vector3()
