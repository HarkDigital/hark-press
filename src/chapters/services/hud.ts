import { el, rise, setRise } from '../../core/dom'
import { BRAND, SECTIONS, SERVICES } from '../../content'
import { SET_WORDS, inkOf } from './timeline'

/*
 * DOM for the Type Case. Scroll decides WHAT is on screen (which proof is
 * on top of the pile, whether the intro / finale is up); CSS decides HOW it
 * arrives (a proof slip stamps down onto the last one), so wherever the
 * scroll rests the copy is settled and exact.
 *
 *   intro    eyebrow + "Eleven ways to be heard."
 *   pile     one proof slip per service: SERVICE 07 / 11 · title · blurb · tags
 *   keys     01–11, the case's index (jump to a service)
 *   finale   "Make the internet listen."
 *
 * The camera frames the bench into the space this HUD leaves free, so
 * metrics() reports the live layout (re-measured only when it changes).
 */

const pad = (n: number) => String(n).padStart(2, '0')
/** the second drum prints the last word of the title in green */
const titleHtml = (t: string) => {
  const i = t.lastIndexOf(' ')
  return i < 0 ? `<em>${t}</em>` : `${t.slice(0, i)} <em>${t.slice(i + 1)}</em>`
}
const setOn = (node: HTMLElement, on: boolean, cls = 'is-on') => {
  if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on)
}
const INK_NAME = ['Signal green', 'Fluoro pink']

export interface HudMetrics {
  /** right edge of the copy column (desktop) */
  colRight: number
  /** top of the column / sheet */
  colTop: number
  /** the wider intro / finale poster: right edge (desktop) and top (phones) */
  introRight: number
  introTop: number
  /** top of the finale caption (it sits under the bench) */
  finTop: number
  /** the chrome's safe insets, px */
  safeTop: number
  safeBottom: number
  /** phone / portrait layout (bottom sheet) */
  tall: boolean
}

export interface HudState {
  introOn: boolean
  /** -1 none, 0..10 the proof on top of the pile */
  shown: number
  /** 0 off, 1 eyebrow (HARK being set), 2 eyebrow + tagline (proof pulled) */
  finale: number
  /** index lit on the 01–11 strip (-1 none) */
  key: number
}

export class Hud {
  private intro: HTMLElement
  private introTitle: HTMLElement
  private col: HTMLElement
  private pile: HTMLElement
  private slips: { root: HTMLElement; title: HTMLElement }[] = []
  private keys: HTMLButtonElement[] = []
  private keyRow: HTMLElement
  private finale: HTMLElement
  private finaleTitle: HTMLElement
  private probe: HTMLElement
  private lastShown = -2
  private dirty = true
  private m: HudMetrics = { colRight: 0, colTop: 0, introRight: 0, introTop: 0, finTop: 0, safeTop: 0, safeBottom: 0, tall: false }

  constructor(
    private stage: HTMLElement,
    jump: (k: number) => void,
  ) {
    /* intro */
    this.intro = el('div', 'svc-intro', undefined, stage)
    el('p', 'hud-eyebrow svc-intro-eyebrow', `${SECTIONS.services.eyebrow} · 01—${pad(SERVICES.length)}`, this.intro)
    this.introTitle = rise(el('h2', 'hud-title svc-intro-title', undefined, this.intro), 'Eleven ways to be <em>heard.</em>')
    el('p', 'hud-label svc-intro-slug', 'Set by hand · proofed in two drums', this.intro)

    /* the column: proof pile + index keys */
    this.col = el('div', 'svc-col', undefined, stage)
    this.keyRow = el('div', 'svc-keys', undefined, this.col)
    SERVICES.forEach((s, k) => {
      const b = el('button', 'svc-key', s.num, this.keyRow)
      b.type = 'button'
      b.title = s.title
      b.setAttribute('aria-label', `Service ${s.num}: ${s.title}`)
      b.addEventListener('click', () => jump(k))
      this.keys.push(b)
    })
    this.pile = el('div', 'svc-pile', undefined, this.col)
    SERVICES.forEach((s, k) => {
      const root = el('article', 'svc-slip', undefined, this.pile)
      // every proof lands a little askew, like a real pile
      const rot = [-1.6, 1.1, -0.7, 1.7, -1.2, 0.8, -1.9, 1.3, -0.9, 1.5, -1.4][k]
      root.style.setProperty('--rot', `${rot}deg`)
      root.style.setProperty('--dx', `${((k * 37) % 11) - 5}px`)
      const slug = el('div', 'svc-slug', undefined, root)
      el('span', 'svc-no', `Service ${s.num} / ${pad(SERVICES.length)}`, slug)
      el('span', 'svc-stamp', 'Proof', slug)
      const title = rise(el('h3', 'hud-h2 svc-title', undefined, root), titleHtml(s.title))
      el('p', 'hud-body svc-blurb', s.blurb, root)
      const tags = el('ul', 'hud-tags svc-tags', undefined, root)
      for (const t of s.tags) el('li', 'hud-tag', t, tags)
      const foot = el('div', 'svc-foot', undefined, root)
      const ink = inkOf(k)
      el('span', 'hud-label', `Set: ${SET_WORDS[k]} · ${INK_NAME[ink]}`, foot)
      const bar = el('span', 'svc-bar', undefined, foot)
      bar.setAttribute('aria-hidden', 'true')
      for (const c of ['p', 'g', 'k']) el('i', `svc-bar-${c}`, undefined, bar)
      for (const c of ['tl', 'tr', 'bl', 'br']) el('i', `svc-crop svc-crop--${c}`, undefined, root).setAttribute('aria-hidden', 'true')
      this.slips.push({ root, title })
    })

    /* finale */
    this.finale = el('div', 'svc-finale', undefined, stage)
    el('p', 'hud-eyebrow', `Final proof · ${BRAND.short}`, this.finale)
    this.finaleTitle = rise(el('h2', 'hud-title svc-finale-title', undefined, this.finale), 'Make the internet <em>listen.</em>')

    /* layout probe for the safe band */
    this.probe = el('div', 'svc-probe', undefined, stage)
    this.probe.setAttribute('aria-hidden', 'true')
    const ro = new ResizeObserver(() => (this.dirty = true))
    for (const n of [stage, this.col, this.pile, this.probe, this.intro, this.finale]) ro.observe(n)
  }

  /** Where the copy sits right now, so the bench can be framed into the space left over. */
  metrics(): HudMetrics {
    if (this.dirty) {
      this.dirty = false
      const m = this.m
      const w = this.stage.offsetWidth
      const h = this.stage.offsetHeight
      m.tall = w < 768 || w / Math.max(1, h) < 0.8
      // offset* ignore transforms, so stamping copy never moves the frame
      m.colRight = this.col.offsetLeft + this.col.offsetWidth
      m.colTop = this.col.offsetTop
      m.introRight = this.intro.offsetLeft + this.intro.offsetWidth
      m.introTop = this.intro.offsetTop
      m.finTop = this.finale.offsetTop
      m.safeTop = this.probe.offsetTop
      m.safeBottom = h - (this.probe.offsetTop + this.probe.offsetHeight)
      if (!h) this.dirty = true
    }
    return this.m
  }

  update(s: HudState) {
    setOn(this.intro, s.introOn)
    setRise(this.introTitle, s.introOn)

    setOn(this.col, s.shown >= 0 && !s.finale)
    if (s.shown !== this.lastShown) {
      this.lastShown = s.shown
      this.slips.forEach((it, k) => {
        setOn(it.root, k === s.shown)
        setOn(it.root, k === s.shown - 1, 'is-under')
        setRise(it.title, k === s.shown)
      })
    }
    this.keys.forEach((b, k) => setOn(b, k === s.key))

    setOn(this.finale, s.finale > 0)
    setRise(this.finaleTitle, s.finale > 1)
  }
}
