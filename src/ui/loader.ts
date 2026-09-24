import { BRAND } from '../content'
import { CONCEPT_TAG, MARK_PATHS, MARK_VIEWBOX, WORDMARK, markSvg } from './mark'
import { mountRotateGate } from './rotate'
import { holdInert, releaseInert } from './inert'

/*
 * Boot screen: a print job on newsprint.
 *
 * Crop marks and registration targets draw in at the edges of the sheet, a
 * job ticket sits top right, and the Hark mark prints in three passes, one
 * drum at a time, each out of register: the pink drum lays a halftone tint,
 * the green drum the diamond, the black drum the loops. Each pass is inked
 * top to bottom behind a roller as progress rises, a colour bar prints its
 * patches, and a big 000→100 counter ticks over. Everything on the sheet
 * moves "on twos" (12 fps), like stop-motion; at 100 the three passes snap
 * into register with a small overshoot and the sheet takes the impression.
 *
 * Then the site's own chapter cut plays: green halftone dots swell out from
 * the mark until the sheet is solid ink, the loader is lifted away under it,
 * and the dots recede to reveal the press. Reduced motion: no jitter, no
 * flood, a plain fade.
 *
 * While the loader is up everything behind it is inert. It never looks
 * frozen: a stalled load keeps a slow creep and, after a while, says so.
 *
 * API: createLoader(root, { skip }) -> { progress(0..1), finish(): Promise<void> }
 * finish() resolves as the flood starts to recede (so the chrome's reveal
 * overlaps it), and the node removes itself once the sheet is clear.
 */

const MIN_DISPLAY = 1.2 // seconds before the counter may reach 100
const SLOW_AFTER = 10 // seconds without finish() before the status admits a slow load
const TWOS = 1000 / 12 // stop-motion frame (ms)
const FLOOD_IN = 480
const FLOOD_OUT = 620
/** the printed green of the flood: signal green multiplied on newsprint (sampled from the riso pass) */
const FLOOD = 'rgb(88, 206, 125)'
/** the flood's key screen: a fine black dot at 45°, as the riso pass prints it at a cut */
const KEY = 'rgb(27, 27, 31)'

const DRUMS = [
  { k: 'p', name: 'Fluorescent pink' },
  { k: 'g', name: 'Signal green' },
  { k: 'k', name: 'Black' },
] as const

/** out-of-register start (em of a 1/10-mark unit) and the registered rest pose for each pass */
const MISREG = {
  p: { x0: -0.95, y0: 0.62, r0: -3.2, x1: 0.16, y1: 0.12 },
  g: { x0: 0.8, y0: -0.58, r0: 4.1, x1: 0, y1: 0 },
  k: { x0: -0.3, y0: 0.26, r0: -1.1, x1: 0, y1: 0 },
}

/** colour-bar patches: ink + tint */
const PATCHES: [string, number][] = [
  ['p', 1],
  ['p', 0.6],
  ['p', 0.3],
  ['g', 1],
  ['g', 0.6],
  ['g', 0.3],
  ['k', 1],
  ['k', 0.6],
  ['k', 0.3],
  ['p', 1],
  ['g', 1],
  ['k', 1],
]

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)
/** a snappy damped spring 0 → 1 with a small overshoot (stop-motion snap) */
const snap = (t: number) => (t <= 0 ? 0 : 1 - Math.exp(-7.5 * t) * Math.cos(15 * t))

/** a 45° screen of small black dots (7.9px cells, 18% density) as a canvas pattern */
function keyPattern(ctx: CanvasRenderingContext2D, dpr: number) {
  const size = Math.max(4, Math.round(7.9 * dpr))
  const c = document.createElement('canvas')
  c.width = c.height = size
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = KEY
  g.beginPath()
  g.arc(size / 2, size / 2, 2.4 * dpr, 0, Math.PI * 2)
  g.fill()
  const pat = ctx.createPattern(c, 'repeat')
  pat?.setTransform(new DOMMatrix().rotate(45).scale(1 / dpr))
  return pat
}

/** A registration target ⊕ as SVG (drawn in with a dash). */
const regTarget = (cls: string) =>
  `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="7" pathLength="1"/><path d="M12 0V24M0 12H24" pathLength="1"/></svg>`

export function createLoader(root: HTMLElement, { skip = false } = {}) {
  // phones held sideways get the rotate card from the very first frame
  mountRotateGate()
  if (skip) {
    root.remove()
    return { progress() {}, finish: () => Promise.resolve() }
  }

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
  const loops = MARK_PATHS.loops.map(d => `<path d="${d}"/>`).join('')
  const diamond = `<path d="${MARK_PATHS.diamond}"/>`

  root.innerHTML = `
  <div class="ld" data-phase="boot">
    <p class="sr-only" role="status">Loading ${BRAND.name}</p>
    <div class="ld-marks" aria-hidden="true">
      <i class="ld-crop ld-crop--tl"></i><i class="ld-crop ld-crop--tr"></i><i class="ld-crop ld-crop--bl"></i><i class="ld-crop ld-crop--br"></i>
      ${regTarget('ld-reg ld-reg--t')}${regTarget('ld-reg ld-reg--b')}${regTarget('ld-reg ld-reg--l')}${regTarget('ld-reg ld-reg--r')}
    </div>
    <div class="ld-brand" aria-hidden="true"><span class="ld-brand-mark">${markSvg('ld-brand-svg')}</span><span class="ld-brand-text"><span class="ld-word">${WORDMARK}</span><span class="ld-sub">${CONCEPT_TAG}</span></span></div>
    <p class="ld-ticket" aria-hidden="true"><span>Job HRK-2026</span><b>·</b><span>3 drums</span><b>·</b><span>80gsm newsprint</span></p>

    <div class="ld-center" aria-hidden="true">
      <div class="ld-print">
        <svg class="ld-pass ld-pass--p" viewBox="${MARK_VIEWBOX}" focusable="false">
          <defs><pattern id="ld-screen" width="46" height="46" patternUnits="userSpaceOnUse" patternTransform="rotate(75)"><circle cx="23" cy="23" r="15.5"/></pattern></defs>
          <g fill="url(#ld-screen)">${loops}${diamond}</g>
        </svg>
        <svg class="ld-pass ld-pass--g" viewBox="${MARK_VIEWBOX}" focusable="false">${diamond}</svg>
        <svg class="ld-pass ld-pass--k" viewBox="${MARK_VIEWBOX}" focusable="false">${loops}</svg>
        <i class="ld-roller"><i></i></i>
      </div>
      <div class="ld-bar">
        ${regTarget('ld-bar-reg')}
        <span class="ld-patches">${PATCHES.map(([c, t]) => `<i class="ld-patch ld-patch--${c}" style="--t:${t === 1 ? 1.25 : t}"></i>`).join('')}</span>
        ${regTarget('ld-bar-reg')}
      </div>
      <p class="ld-drums">${DRUMS.map((d, i) => `<span class="ld-drum ld-drum--${d.k}" data-d="${i}"><i></i>${d.k === 'k' ? 'Black' : d.k === 'p' ? 'Pink' : 'Green'}</span>`).join('')}</p>
    </div>

    <p class="ld-status" aria-hidden="true"><span class="ld-status-k">Drum 1/3</span><span class="ld-status-v">Fluorescent pink</span></p>
    <p class="ld-count" aria-hidden="true"><span class="ld-count-n">000</span><span class="ld-count-u">%</span></p>
  </div>
  <canvas class="ld-flood" aria-hidden="true"></canvas>`

  const wrap = root.querySelector<HTMLElement>('.ld')!
  const num = root.querySelector<HTMLElement>('.ld-count-n')!
  const print = root.querySelector<HTMLElement>('.ld-print')!
  const passes = (['p', 'g', 'k'] as const).map(k => ({ k, el: root.querySelector<SVGSVGElement>(`.ld-pass--${k}`)! }))
  const roller = root.querySelector<HTMLElement>('.ld-roller')!
  const patches = [...root.querySelectorAll<HTMLElement>('.ld-patch')]
  const drums = [...root.querySelectorAll<HTMLElement>('.ld-drum')]
  const statusK = root.querySelector<HTMLElement>('.ld-status-k')!
  const statusV = root.querySelector<HTMLElement>('.ld-status-v')!
  const canvas = root.querySelector<HTMLCanvasElement>('.ld-flood')!
  const live = root.querySelector<HTMLElement>('[role="status"]')!

  // nothing behind the loader is reachable while it is up
  holdInert('loader', [
    ...['chrome', 'stages', 'track'].map(id => document.getElementById(id)),
    document.querySelector<HTMLElement>('.skip-link'),
  ])

  const t0 = performance.now()
  let target = 0
  let shown = 0
  let finishing = false
  let registerAt = -1
  let slow = false
  let raf = 0
  let lastTwo = -1
  let last = t0
  let status = ''
  let printed = -1

  const setStatus = (k: string, v: string) => {
    const s = `${k}|${v}`
    if (s === status) return
    status = s
    statusK.textContent = k
    statusV.textContent = v
  }

  /** draw one stop-motion frame of the sheet */
  const drawTwo = (now: number, two: number) => {
    const pct = Math.min(100, Math.floor(shown * 100 + 1e-4))
    const s = String(pct).padStart(3, '0')
    if (num.textContent !== s) num.textContent = s

    // the three passes: each inks top → bottom over its third of the job
    const snapT = registerAt < 0 ? 0 : (now - registerAt) / 1000
    const reg = registerAt < 0 ? 0 : snap(snapT)
    let rollerAt = -1
    let rollerInk = ''
    passes.forEach(({ k, el }, i) => {
      const w = clamp01(shown * 3 - i)
      el.style.setProperty('--w', w.toFixed(3))
      if (w > 0 && w < 1 && rollerAt < 0) {
        rollerAt = w
        rollerInk = k
      }
      const m = MISREG[k]
      // a sheet on the drum is never perfectly still: it "boils" on twos
      const j = reduced || registerAt >= 0 ? 0 : 0.045
      const jx = j ? (Math.sin(two * 2.7 + i * 1.9) * 0.5 + Math.sin(two * 5.3 + i) * 0.5) * j : 0
      const jy = j ? (Math.cos(two * 3.1 + i * 2.3) * 0.5 + Math.sin(two * 4.1 + i * 0.7) * 0.5) * j : 0
      const x = m.x0 + (m.x1 - m.x0) * reg + jx
      const y = m.y0 + (m.y1 - m.y0) * reg + jy
      const r = m.r0 * (1 - reg)
      el.style.transform = `translate(${x.toFixed(3)}em, ${y.toFixed(3)}em) rotate(${r.toFixed(2)}deg)`
    })
    if (rollerAt >= 0) {
      roller.style.setProperty('--y', rollerAt.toFixed(3))
      roller.dataset.ink = rollerInk
      roller.classList.add('is-on')
    } else roller.classList.remove('is-on')

    // the colour bar prints a patch per twelfth of the job
    const n = Math.min(patches.length, Math.floor(shown * patches.length + 1e-4))
    if (n !== printed) {
      for (let i = 0; i < patches.length; i++) patches[i].classList.toggle('is-on', i < n)
      printed = n
    }

    // which drum is running
    const d = Math.min(2, Math.floor(shown * 3))
    drums.forEach((el, i) => {
      el.classList.toggle('is-on', i === d && shown < 1)
      el.classList.toggle('is-done', shown * 3 >= i + 1)
    })
    if (registerAt >= 0) setStatus('In register', 'Run 01 / 07')
    else if (slow) setStatus('Still inking', 'Slow line, hang on')
    else setStatus(`Drum ${d + 1}/3`, DRUMS[d].name)
  }

  const tick = (now: number) => {
    const dt = Math.min(0.05, (now - last) / 1000)
    last = now
    const elapsed = (now - t0) / 1000
    // the time cap keeps the count readable even when loading is instant
    const cap = finishing ? 1 : Math.min(0.97, elapsed / MIN_DISPLAY)
    // a stalled load keeps a slow creep so the sheet never looks frozen
    const creep = Math.min(0.9, shown + dt * 0.02)
    const goal = Math.min(cap, Math.max(target, finishing ? 1 : creep))
    const k = 1 - Math.exp(-(finishing ? 10 : 5) * dt)
    shown += (goal - shown) * k
    if (finishing && goal - shown < 0.004) shown = 1
    if (!finishing && !slow && elapsed > SLOW_AFTER) slow = true

    // stop-motion: the sheet only redraws on twos
    const two = Math.floor((now - t0) / TWOS)
    if (two !== lastTwo || reduced) {
      lastTwo = two
      drawTwo(now, two)
    }
    raf = requestAnimationFrame(tick)
  }
  raf = requestAnimationFrame(tick)
  drawTwo(t0, 0)

  // ----------------------------------------------------------------- the flood

  /**
   * The site's chapter cut, in 2D: signal-green dots on a 15° screen swell
   * out from `origin` until the sheet is solid, or (dir 'out') shrink from
   * the centre outward to uncover what is underneath.
   */
  const flood = (dir: 'in' | 'out', ms: number, ox: number, oy: number) =>
    new Promise<void>(resolve => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return resolve()
      const w = window.innerWidth
      const h = window.innerHeight
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // the same screen as the riso pass at a cut: 5.5px cells swollen by 60%
      const cell = 8.8
      const rFull = cell * 0.74
      const a = (15 * Math.PI) / 180
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const maxD = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy))
      // grid points of the rotated screen that land on the viewport
      const span = Math.ceil(Math.hypot(w, h) / cell / 2) + 2
      const cx = w / 2
      const cy = h / 2
      const xs: number[] = []
      const ys: number[] = []
      const ds: number[] = []
      for (let j = -span; j <= span; j++) {
        for (let i = -span; i <= span; i++) {
          const x = cx + (i * ca - j * sa) * cell
          const y = cy + (i * sa + j * ca) * cell
          if (x < -cell || y < -cell || x > w + cell || y > h + cell) continue
          xs.push(x)
          ys.push(y)
          ds.push(Math.hypot(x - ox, y - oy) / maxD)
        }
      }
      // the key drum's fine black screen, printed only where the green has landed
      const key = keyPattern(ctx, dpr)
      const band = 0.5
      const start = performance.now()
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / ms)
        // in: accelerate into the solid sheet; out: burst open, settle
        const e = dir === 'in' ? t * t * (3 - 2 * t) : 1 - (1 - t) * (1 - t) * (1 - t)
        const front = e * (1 + band)
        ctx.clearRect(0, 0, w, h)
        ctx.fillStyle = FLOOD
        if ((dir === 'in' && front - 1 >= band) || (dir === 'out' && front <= 0)) {
          ctx.fillRect(0, 0, w, h)
        } else {
          ctx.beginPath()
          for (let p = 0; p < xs.length; p++) {
            const v = clamp01((front - ds[p]) / band)
            const cover = dir === 'in' ? v : 1 - v
            if (cover <= 0.02) continue
            // grow by area, like a halftone dot gaining density
            const r = rFull * Math.sqrt(cover)
            ctx.moveTo(xs[p] + r, ys[p])
            ctx.arc(xs[p], ys[p], r, 0, Math.PI * 2)
          }
          ctx.fill()
        }
        if (key) {
          ctx.globalCompositeOperation = 'source-atop'
          ctx.globalAlpha = 0.9 * (dir === 'in' ? e : 1 - e * 0.6)
          ctx.fillStyle = key
          ctx.fillRect(0, 0, w, h)
          ctx.globalAlpha = 1
          ctx.globalCompositeOperation = 'source-over'
        }
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })

  let done: Promise<void> | null = null

  return {
    progress(p: number) {
      if (Number.isFinite(p)) target = Math.max(target, clamp01(p))
    },
    finish(): Promise<void> {
      if (done) return done
      done = (async () => {
        const elapsed = (performance.now() - t0) / 1000
        if (elapsed < MIN_DISPLAY) await wait((MIN_DISPLAY - elapsed) * 1000)
        finishing = true
        target = 1
        // let the counter land on 100
        const land = performance.now()
        while (shown < 1 && performance.now() - land < 900) await wait(30)
        shown = 1

        // snap into register and take the impression
        registerAt = performance.now()
        wrap.dataset.phase = 'register'
        drawTwo(registerAt, lastTwo + 1)
        await wait(reduced ? 120 : 640)

        const r = print.getBoundingClientRect()
        const ox = r.left + r.width / 2
        const oy = r.top + r.height / 2
        if (reduced) {
          // no flood: a plain crossfade (WAAPI, so the global reduced-motion
          // transition kill in base.css cannot turn it into a hard cut)
          releaseInert('loader')
          root.style.pointerEvents = 'none'
          live.textContent = ''
          const fade = wrap.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: 'ease', fill: 'forwards' })
          fade.finished
            .catch(() => {})
            .then(() => {
              cancelAnimationFrame(raf)
              root.remove()
            })
          await wait(160)
          return
        }

        // ink flood: the whole sheet goes to solid green…
        wrap.dataset.phase = 'flood'
        await flood('in', FLOOD_IN, ox, oy)
        // …the loader sheet is lifted away under it…
        cancelAnimationFrame(raf)
        wrap.style.visibility = 'hidden'
        releaseInert('loader')
        root.style.pointerEvents = 'none'
        live.textContent = ''
        // …and the dots recede to reveal the press
        flood('out', FLOOD_OUT, window.innerWidth / 2, window.innerHeight / 2).then(() => root.remove())
        await wait(FLOOD_OUT * 0.3)
      })()
      return done
    },
  }
}
