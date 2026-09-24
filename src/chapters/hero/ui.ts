import { BRAND, MICROCOPY } from '../../content'
import { el, rise, setRise } from '../../core/dom'
import { INK_NAME, T } from './shared'

export interface PosterRect {
  x: number
  y: number
  w: number
  h: number
  port: boolean
}

/** Glue the year to 'est.' and each '·' to the word before it, so a credit line only breaks after a separator. */
const glue = (s: string) => s.replace(/est\.\s+(\d{4})/i, 'est.\u00a0$1').replace(/\s+·/g, '\u00a0·')

/**
 * The hero's paper: a job ticket taped to the mat (the colophon), the scroll
 * hint, a slim press readout (which pass, which ink), and the poster's
 * credit line and buttons, laid onto the pulled print. The headline itself
 * is PRINTED on the sheet (see art.ts), so the DOM never doubles it.
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
  private poster: HTMLElement
  private probe: HTMLElement
  safe = { top: 96, bottom: 90, side: 24 }
  private last = { pass: '', ink: '', chips: -1, rect: '', shift: '' }

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
    row('Stock', '80gsm newsprint')
    row('Printed', glue(BRAND.locale))

    // --- scroll hint ---
    this.hint = el('div', 'hero-hint', undefined, this.root)
    const arrow = el('span', 'hero-hint__arrow', undefined, this.hint)
    arrow.innerHTML =
      '<svg viewBox="0 0 16 22" aria-hidden="true"><path d="M8 1v18M2 13l6 7 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>'
    el('span', 'hero-hint__label', MICROCOPY.scrollHint, this.hint)

    // --- press readout: pass + ink ---
    this.readout = el('div', 'hero-readout', undefined, this.root)
    const r1 = el('div', 'hero-readout__row', undefined, this.readout)
    el('span', 'hero-readout__k', 'Pass', r1)
    this.passNum = el('b', 'hero-readout__v', '1 / 3', r1)
    this.passInk = el('span', 'hero-readout__ink', INK_NAME[0], r1)
    const chips = el('div', 'hero-readout__chips', undefined, r1)
    for (const c of ['k', 'g', 'p']) this.chips.push(el('i', `hero-chip hero-chip--${c}`, undefined, chips))

    // --- the poster's credit and buttons, laid into the pulled print ---
    this.poster = el('div', 'hero-poster', undefined, this.root)
    el('span', 'hero-poster__tape', undefined, this.poster)
    el('p', 'hero-poster__credit', glue(`${BRAND.name} · ${BRAND.locale}`), this.poster)
    const ctas = el('div', 'hero-ctas', undefined, this.poster)
    const work = el('button', 'hud-btn', 'See the work', ctas)
    work.type = 'button'
    work.addEventListener('click', () => window.__hark?.land('work'))
    const contact = el('a', 'hud-btn hud-btn--ghost', 'Start a project', ctas)
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
    const key = `${rect.x.toFixed(1)}|${rect.y.toFixed(1)}|${rect.w.toFixed(1)}|${rect.h.toFixed(1)}|${rect.port}`
    if (key === this.last.rect) return
    this.last.rect = key
    const s = this.poster.style
    s.setProperty('--px', `${rect.x.toFixed(1)}px`)
    s.setProperty('--py', `${rect.y.toFixed(1)}px`)
    s.setProperty('--pw', `${rect.w.toFixed(1)}px`)
    s.setProperty('--ph', `${rect.h.toFixed(1)}px`)
    this.poster.classList.toggle('is-port', rect.port)
  }

  update(p: { local: number; intro: number; pass: number; done: number; port: boolean; posterOn: boolean; shiftX: number; shiftY: number }) {
    const { local, intro } = p
    if (this.root.classList.contains('is-port') !== p.port) this.root.classList.toggle('is-port', p.port)
    // in portrait the ticket sits over the sheet, so it steps aside as the key block sets off
    const ticketOn = intro > 0.35 && local < (p.port ? T.ticketPort : T.ticketB)
    this.ticket.classList.toggle('is-in', ticketOn)
    setRise(this.ticketText, ticketOn)
    this.hint.classList.toggle('is-in', intro > 0.8 && local < T.hintB)

    const readOn = local > T.readA && local < T.readB
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
    }

    this.poster.classList.toggle('is-in', p.posterOn)
    const shift = `${p.shiftX.toFixed(1)},${p.shiftY.toFixed(1)}`
    if (shift !== this.last.shift) {
      this.last.shift = shift
      this.poster.style.transform = p.shiftX || p.shiftY ? `translate3d(${p.shiftX.toFixed(1)}px, ${p.shiftY.toFixed(1)}px, 0)` : ''
    }
  }
}
