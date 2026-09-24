import { el, rise, setRise } from '../../core/dom'
import { PROCESS, STATS } from '../../content'

/*
 * The Fold's HUD: the chapter headline, an instruction card per fold (step
 * number, the step's name and text, a fold-diagram slug) with a four-up
 * tracker, and the stats "printed on the wings" once the plane is done.
 */

/** The three stats the wings carry, in wing order. */
export const WING_STATS = ['10 years', '$1M+', '15'].map(v => STATS.find(s => s.value === v)!).filter(Boolean)

/** How each step is folded — decorative diagram slugs. */
const HOW = ['Valley · corners to centre', 'Valley · edges to centre', 'Valley · fold in half', 'Mountain · wings down']

export interface HudState {
  head: boolean
  /** active step (-1 none) */
  step: number
  /** folds completed (0..4) */
  done: number
  steps: boolean
  stats: boolean[]
  statsOn: boolean
}

export class FoldHud {
  root: HTMLElement
  private head: HTMLElement
  private eyebrow: HTMLElement
  private title: HTMLElement
  private strips: HTMLElement[] = []
  private stepsBox: HTMLElement
  private chips: HTMLElement[] = []
  private cards: { card: HTMLElement; title: HTMLElement; body: HTMLElement }[] = []
  private statsBox: HTMLElement
  private statsEyebrow: HTMLElement
  private statItems: { row: HTMLElement; v: HTMLElement }[] = []
  private last = ''

  constructor(stage: HTMLElement) {
    this.root = el('div', 'pf', undefined, stage)

    const head = (this.head = el('div', 'pf-head', undefined, this.root))
    this.eyebrow = el('p', 'hud-eyebrow pf-eyebrow', 'How we work', head)
    // the headline, set on two strips of paper pasted onto the mat
    this.title = el('h2', 'hud-h2 pf-title', undefined, head)
    this.strips = [
      rise(el('span', 'pf-strip pf-strip--1', undefined, this.title), 'We listen first.'),
      rise(el('span', 'pf-strip pf-strip--2', undefined, this.title), '<em>Then we build.</em>'),
    ]

    // ---- instruction cards
    this.stepsBox = el('div', 'pf-steps', undefined, this.root)
    const track = el('ol', 'pf-track', undefined, this.stepsBox)
    PROCESS.forEach((p, i) => {
      const chip = el('li', 'pf-chip', undefined, track)
      el('span', 'pf-chip-n', String(i + 1), chip)
      el('span', 'pf-chip-t', p.title, chip)
      this.chips.push(chip)
    })
    const deck = el('div', 'pf-deck', undefined, this.stepsBox)
    PROCESS.forEach((p, i) => {
      const card = el('div', 'pf-card', undefined, deck)
      const slug = el('p', 'hud-label pf-slug', undefined, card)
      el('span', 'pf-slug-n', `Fold ${i + 1} / 4`, slug)
      el('span', 'pf-slug-how', HOW[i], slug)
      const title = rise(el('h3', 'pf-name', undefined, card), p.title)
      const body = rise(el('p', 'hud-body pf-body', undefined, card), p.text)
      this.cards.push({ card, title, body })
    })

    // ---- stats, printed on the wings
    this.statsBox = el('div', 'pf-stats', undefined, this.root)
    this.statsEyebrow = el('p', 'hud-eyebrow pf-stats-eyebrow', 'Printed on the wings', this.statsBox)
    const list = el('ol', 'pf-stat-list', undefined, this.statsBox)
    WING_STATS.forEach((s, i) => {
      const row = el('li', `pf-stat pf-stat--${i}`, undefined, list)
      el('span', 'pf-stat-i', `0${i + 1}`, row)
      const slot = el('div', 'pf-stat-slot', undefined, row)
      const v = rise(el('p', 'pf-stat-v', undefined, slot), s.value)
      el('p', 'pf-stat-l', s.label, row)
      this.statItems.push({ row, v })
    })
  }

  /**
   * The free screen band (px) where the 3D subject should sit while the
   * cards show, and while the stats show. Measured from the real layout.
   */
  layout(W: number, H: number) {
    const portrait = W / Math.max(1, H) < 0.8 || W < 768
    const cs = getComputedStyle(this.root)
    const px = (v: string, fb: number) => {
      const n = parseFloat(v)
      return Number.isFinite(n) ? n : fb
    }
    // resolve the safe-area tokens through a probe
    const probe = this.probe ?? (this.probe = el('div', 'pf-probe', undefined, this.root))
    const pcs = getComputedStyle(probe)
    const gutter = px(pcs.paddingLeft, 24)
    const safeTop = px(pcs.top, 90)
    const safeBottom = px(pcs.bottom, 80)
    void cs
    const headR = this.head.getBoundingClientRect()
    let textRight = headR.left
    for (const st of this.strips) textRight = Math.max(textRight, st.getBoundingClientRect().right)
    const steps = this.stepsBox.getBoundingClientRect()
    const stats = this.statsBox.getBoundingClientRect()
    const short = portrait && H < 720
    if (portrait) {
      const top = headR.bottom + 14
      return {
        portrait,
        short,
        steps: { l: gutter * 0.5, r: W - gutter * 0.5, t: top, b: Math.max(top + 120, steps.top - 14) },
        stats: {
          l: gutter * 0.5,
          r: W - gutter * 0.5,
          t: short ? safeTop - 10 : top,
          b: Math.max((short ? safeTop : top) + 120, stats.top - 14),
        },
      }
    }
    const colR = Math.max(steps.right, textRight, gutter + 260)
    const l = Math.min(W * 0.62, colR + 28)
    return {
      portrait,
      short,
      steps: { l, r: W - gutter, t: safeTop - 24, b: H - safeBottom + 30 },
      stats: { l: Math.min(W * 0.62, Math.max(stats.right, textRight) + 28), r: W - gutter, t: safeTop - 24, b: H - safeBottom + 30 },
    }
  }

  private probe: HTMLElement | null = null

  /** Elements whose size changes should re-run layout(). */
  measured(): HTMLElement[] {
    return [this.head, this.stepsBox, this.statsBox]
  }

  update(o: HudState) {
    const key = `${+o.head}${o.step}${o.done}${+o.steps}${o.stats.map(Number).join('')}${+o.statsOn}`
    if (key === this.last) return
    this.last = key
    for (const st of this.strips) setRise(st, o.head)
    this.head.classList.toggle('is-in', o.head)
    this.eyebrow.classList.toggle('is-in', o.head)
    this.stepsBox.classList.toggle('is-in', o.steps)
    this.chips.forEach((c, i) => {
      c.classList.toggle('is-active', o.steps && o.step === i)
      c.classList.toggle('is-done', i < o.done)
    })
    this.cards.forEach((c, i) => {
      const on = o.steps && o.step === i
      c.card.classList.toggle('is-in', on)
      setRise(c.title, on)
      setRise(c.body, on)
    })
    this.statsBox.classList.toggle('is-in', o.statsOn)
    this.statsEyebrow.classList.toggle('is-in', o.statsOn)
    // a manifest: the card and its labels arrive together, each value is
    // stamped in when its stamp hits the wing
    this.statItems.forEach((s, i) => {
      s.row.classList.toggle('is-in', o.statsOn)
      s.row.classList.toggle('is-stamped', o.stats[i])
      setRise(s.v, o.stats[i])
    })
  }
}
