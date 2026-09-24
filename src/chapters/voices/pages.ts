import * as THREE from 'three'
import { logoShapes } from '../../logo/logo'
import { TESTIMONIALS } from '../../content'
import { setPrintFont, type Stretch } from '../../print/type'

/*
 * The zine's pages, printed as INK DENSITIES into one canvas atlas
 * (R = pink, G = green, B = black; see src/print/ink.ts). Every page is
 * laid out in a 1000 × 1414 unit box (A5) and scaled to the atlas cell.
 *
 * Faces, in reading order (leaf k carries faces 2k and 2k + 1):
 *   0            cover
 *   2s + 1       spread s, left page  (back of leaf s)
 *   2s + 2       spread s, right page (front of leaf s + 1)
 *   17           back cover
 *
 * Spreads alternate: even spreads open on the PULL page (a giant pull-quote
 * phrase) facing the STORY page (doodle, full quote, byline); odd spreads
 * swap sides, like a real zine's layout rhythm.
 *
 * Inks: the canvas starts opaque black (= no ink). Opaque source-over fills
 * KNOCK OUT whatever is under them; 'lighter' OVERPRINTS (adds densities),
 * which the riso pass multiplies like real ink. Densities below 1 get
 * screened into halftone dots by the press.
 */

export const N = TESTIMONIALS.length
export const LEAVES = N + 1
export const FACES = LEAVES * 2
/** page height / width (A5) */
export const PAGE_ASPECT = 1.4142

/** verbatim phrases lifted from each testimonial for the pull page */
export const PULLS = [
  'At his core he is an artist.',
  'Record number sales.',
  'Looks awesome.',
  'Quick to respond.',
  'Knocked it out of the park.',
  'Met with rave reviews.',
  'On time, on budget.',
  'Something we are really proud of.',
]

const SANS = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif'
const MONO = '"DM Mono", ui-monospace, monospace'
const W = 1000
const H = 1414
const M = 72 // page margin

type Ch = 'p' | 'g' | 'k'
type C2D = CanvasRenderingContext2D

const col = (ch: Ch, d = 1) => {
  const v = Math.round(Math.max(0, Math.min(1, d)) * 255)
  return ch === 'p' ? `rgb(${v},0,0)` : ch === 'g' ? `rgb(0,${v},0)` : `rgb(0,0,${v})`
}
const pad2 = (n: number) => String(n).padStart(2, '0')

/** the face that shows each spread's left / right page */
export const leftFace = (s: number) => 2 * s + 1
export const rightFace = (s: number) => 2 * s + 2

/* ------------------------------------------------------------------ type */

/**
 * The x-scale the current font needs. Safari has no canvas fontStretch, so
 * condensed faces print full width there; setPrintFont measures that and
 * hands back a squeeze (1 wherever the browser condensed the face itself).
 * Every fillText goes through fillT and every measured width through tw.
 */
let SX = 1

function font(ctx: C2D, weight: number, size: number, fam: 'sans' | 'mono', stretch: Stretch = 'normal', track = 0) {
  SX = setPrintFont(ctx, weight, size, fam === 'sans' ? stretch : 'normal', fam === 'sans' ? SANS : MONO)
  const c = ctx as C2D & { letterSpacing?: string }
  if ('letterSpacing' in c) c.letterSpacing = `${(track * size).toFixed(2)}px`
}

/** fillText in the current font's x-scale (alignment still anchors at x) */
function fillT(ctx: C2D, s: string, x: number, y: number) {
  if (SX === 1) return ctx.fillText(s, x, y)
  const sx = SX
  keep(ctx, () => {
    ctx.scale(sx, 1)
    ctx.fillText(s, x / sx, y)
  })
}

/** printed width of `s` in the current font */
const tw = (ctx: C2D, s: string) => ctx.measureText(s).width * SX

function wrap(ctx: C2D, str: string, maxW: number): string[] {
  const words = str.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    const t = line ? `${line} ${w}` : w
    if (line && tw(ctx, t) > maxW) {
      lines.push(line)
      line = w
    } else line = t
  }
  if (line) lines.push(line)
  return lines
}

/**
 * Largest size (≤ max) at which `text` wraps into the box, then re-wrapped
 * to the narrowest measure that keeps the same line count (a balanced rag).
 */
function fit(
  ctx: C2D,
  text: string,
  setFont: (size: number) => void,
  boxW: number,
  boxH: number,
  lh: number,
  min: number,
  max: number,
  maxLines = 99,
) {
  const ok = (size: number, w: number) => {
    setFont(size)
    const lines = wrap(ctx, text, w)
    if (lines.length > maxLines || lines.length * size * lh > boxH) return null
    for (const l of lines) if (tw(ctx, l) > w) return null
    return lines
  }
  let lo = min
  let hi = max
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ok(mid, boxW)) lo = mid
    else hi = mid
  }
  const size = ok(hi, boxW) ? hi : lo
  let lines = ok(size, boxW) ?? (setFont(size), wrap(ctx, text, boxW))
  // balance: shrink the measure while the line count holds
  const n = lines.length
  if (n > 1) {
    let a = boxW * 0.45
    let b = boxW
    for (let i = 0; i < 12; i++) {
      const m = (a + b) / 2
      setFont(size)
      const l = wrap(ctx, text, m)
      if (l.length <= n && l.every(x => tw(ctx, x) <= m)) b = m
      else a = m
    }
    setFont(size)
    lines = wrap(ctx, text, b)
  }
  setFont(size)
  return { size, lines }
}

/* ---------------------------------------------------------------- inking */

/** run fn in its own canvas state; the stack stays balanced even if fn throws */
function keep(ctx: C2D, fn: () => void) {
  ctx.save()
  try {
    fn()
  } finally {
    ctx.restore()
  }
}

/** overprint: densities add (the press multiplies them like real ink) */
function over(ctx: C2D, fn: () => void) {
  keep(ctx, () => {
    ctx.globalCompositeOperation = 'lighter'
    fn()
  })
}

/**
 * One piece of a page's art. A piece that fails (a missing canvas API, a
 * font that never arrived) is left off; the rest of the page still prints.
 */
function part(label: string, fn: () => void) {
  try {
    fn()
  } catch (err) {
    console.warn(`[voices] ${label} skipped`, err)
  }
}

function stroke(ctx: C2D, path: Path2D, w = 7, d = 1) {
  over(ctx, () => {
    ctx.strokeStyle = col('k', d)
    ctx.lineWidth = w
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke(path)
  })
}

/** a tint fill, hand-registered a hair off its keyline */
function fill(ctx: C2D, path: Path2D, ch: Ch, d: number, dx = 11, dy = 9, rule: CanvasFillRule = 'nonzero') {
  over(ctx, () => {
    ctx.translate(dx, dy)
    ctx.fillStyle = col(ch, d)
    ctx.fill(path, rule)
  })
}

/** radial halftone "sun": density d at the centre fading to nothing */
function sun(ctx: C2D, x: number, y: number, r: number, ch: Ch, d: number) {
  over(ctx, () => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, col(ch, d))
    g.addColorStop(0.55, col(ch, d * 0.55))
    g.addColorStop(1, col(ch, 0))
    ctx.fillStyle = g
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.fill()
  })
}

function regMark(ctx: C2D, x: number, y: number, r = 15) {
  const p = new Path2D()
  p.arc(x, y, r, 0, Math.PI * 2)
  p.moveTo(x - r * 1.7, y)
  p.lineTo(x + r * 1.7, y)
  p.moveTo(x, y - r * 1.7)
  p.lineTo(x, y + r * 1.7)
  stroke(ctx, p, 2.6)
}

function markPath(cx: number, cy: number, size: number, rot = 0) {
  const p = new Path2D()
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  const tx = (x: number, y: number): [number, number] => [cx + (x * c - y * s) * size, cy - (x * s + y * c) * size]
  const ring = (pts: THREE.Vector2[]) => {
    pts.forEach((v, i) => {
      const [x, y] = tx(v.x, v.y)
      if (i) p.lineTo(x, y)
      else p.moveTo(x, y)
    })
    p.closePath()
  }
  for (const sh of logoShapes()) {
    ring(sh.getPoints(40))
    for (const h of sh.holes) ring(h.getPoints(40))
  }
  return p
}

function star(cx: number, cy: number, r: number, points = 5, inner = 0.45, rot = -Math.PI / 2) {
  const p = new Path2D()
  for (let i = 0; i < points * 2; i++) {
    const a = rot + (i * Math.PI) / points
    const rr = i % 2 ? r * inner : r
    const x = cx + Math.cos(a) * rr
    const y = cy + Math.sin(a) * rr
    if (i) p.lineTo(x, y)
    else p.moveTo(x, y)
  }
  p.closePath()
  return p
}

function sparkle(ctx: C2D, x: number, y: number, r: number) {
  const p = new Path2D()
  p.moveTo(x - r, y)
  p.lineTo(x + r, y)
  p.moveTo(x, y - r)
  p.lineTo(x, y + r)
  stroke(ctx, p, 6)
}

/** little motion / "shake" dashes around a doodle */
function dashes(ctx: C2D, lines: [number, number, number, number][], w = 7) {
  const p = new Path2D()
  for (const [a, b, c, d] of lines) {
    p.moveTo(a, b)
    p.lineTo(c, d)
  }
  stroke(ctx, p, w)
}

/** a rounded rectangle built from arcTo (no dependence on Path2D.roundRect) */
function roundRect(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D()
  const rr = Math.max(0, Math.min(r, w / 2, h / 2))
  p.moveTo(x + rr, y)
  p.arcTo(x + w, y, x + w, y + h, rr)
  p.arcTo(x + w, y + h, x, y + h, rr)
  p.arcTo(x, y + h, x, y, rr)
  p.arcTo(x, y, x + w, y, rr)
  p.closePath()
  return p
}

/* -------------------------------------------------------------- doodles */

/**
 * One doodle per voice, drawn inside a 1000 × ~560 box centred on (500, cy):
 * black keylines, tint fills slightly off register, a halftone sun behind.
 */
const DOODLES: ((ctx: C2D, cy: number) => void)[] = [
  // 0 · Fabbri Builders — "at his core he is an artist": the Hark mark, hand-inked
  (ctx, cy) => {
    sun(ctx, 520, cy, 290, 'p', 0.5)
    const m = markPath(500, cy, 400, -0.14)
    fill(ctx, m, 'g', 0.8, 14, 12, 'evenodd')
    stroke(ctx, m, 6)
    sparkle(ctx, 790, cy - 190, 30)
    sparkle(ctx, 220, cy + 170, 22)
    dashes(ctx, [
      [760, cy - 60, 830, cy - 90],
      [770, cy - 10, 850, cy - 20],
    ])
  },
  // 1 · Shriver's — "record number sales": a bar chart climbing off the page
  (ctx, cy) => {
    sun(ctx, 620, cy - 40, 300, 'g', 0.45)
    const base = cy + 200
    const hs = [110, 190, 280, 390]
    hs.forEach((h, i) => {
      const x = 200 + i * 150
      const r = roundRect(x, base - h, 104, h, 6)
      fill(ctx, r, i % 2 ? 'p' : 'g', i % 2 ? 0.7 : 0.85)
      stroke(ctx, r, 6)
    })
    const axis = new Path2D()
    axis.moveTo(150, base)
    axis.lineTo(860, base)
    stroke(ctx, axis, 7)
    const arrow = new Path2D()
    arrow.moveTo(180, base - 170)
    arrow.bezierCurveTo(380, base - 190, 520, base - 300, 790, base - 470)
    arrow.moveTo(790, base - 470)
    arrow.lineTo(712, base - 462)
    arrow.moveTo(790, base - 470)
    arrow.lineTo(768, base - 395)
    stroke(ctx, arrow, 9)
    sparkle(ctx, 850, base - 400, 26)
  },
  // 2 · CrossFit Off The Grid — "looks awesome": a loaded barbell
  (ctx, cy) => {
    sun(ctx, 500, cy, 300, 'g', 0.5)
    const bar = roundRect(130, cy - 11, 740, 22, 8)
    fill(ctx, bar, 'k', 0.35, 6, 5)
    stroke(ctx, bar, 6)
    for (const s of [-1, 1]) {
      const big = roundRect(500 + s * 270 - 34, cy - 150, 68, 300, 14)
      fill(ctx, big, 'p', 0.78)
      stroke(ctx, big, 6)
      const small = roundRect(500 + s * 195 - 24, cy - 105, 48, 210, 12)
      fill(ctx, small, 'g', 0.9)
      stroke(ctx, small, 6)
      const collar = roundRect(500 + s * 145 - 12, cy - 34, 24, 68, 6)
      stroke(ctx, collar, 6)
    }
    dashes(ctx, [
      [300, cy - 230, 330, cy - 190],
      [500, cy - 250, 500, cy - 205],
      [700, cy - 230, 670, cy - 190],
    ])
  },
  // 3 · Bellview Winery — "quick to respond": a speech bubble at speed
  (ctx, cy) => {
    sun(ctx, 560, cy, 290, 'p', 0.5)
    const b = roundRect(290, cy - 170, 520, 300, 70)
    const t = new Path2D()
    t.moveTo(380, cy + 118)
    t.lineTo(330, cy + 230)
    t.lineTo(470, cy + 128)
    fill(ctx, b, 'g', 0.85)
    fill(ctx, t, 'g', 0.85)
    const out = new Path2D()
    out.addPath(b)
    stroke(ctx, out, 7)
    stroke(ctx, t, 7)
    // "!!" set in the bubble
    over(ctx, () => {
      font(ctx, 800, 210, 'sans', 'condensed')
      ctx.fillStyle = col('k')
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      fillT(ctx, '!!', 550, cy + 75)
    })
    dashes(ctx, [
      [120, cy - 100, 240, cy - 100],
      [80, cy - 20, 240, cy - 20],
      [140, cy + 60, 240, cy + 60],
    ])
  },
  // 4 · PEG Glass — "knocked it out of the park": a baseball, gone
  (ctx, cy) => {
    sun(ctx, 560, cy - 30, 280, 'g', 0.55)
    const cx = 560
    const r = 175
    const ball = new Path2D()
    ball.arc(cx, cy, r, 0, Math.PI * 2)
    // shade crescent
    over(ctx, () => {
      ctx.clip(ball)
      ctx.fillStyle = col('p', 0.6)
      ctx.beginPath()
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
      ctx.arc(cx - 50, cy - 45, r * 0.92, 0, Math.PI * 2, true)
      ctx.fill()
    })
    stroke(ctx, ball, 7)
    // seams + stitches, clipped to the ball
    keep(ctx, () => {
      ctx.clip(ball)
      for (const side of [-1, 1]) {
        const sx = cx + side * r * 1.55
        const R = r * 1.08
        const a0 = side < 0 ? 0 : Math.PI
        const seam = new Path2D()
        seam.arc(sx, cy, R, a0 - 0.78, a0 + 0.78)
        stroke(ctx, seam, 5)
        const st = new Path2D()
        for (let i = -4; i <= 4; i++) {
          const a = a0 + i * 0.16
          const nx = Math.cos(a)
          const ny = Math.sin(a)
          const px = sx + nx * R
          const py = cy + ny * R
          // little V-stitches pointing along the seam
          st.moveTo(px - nx * 17 - ny * 9 * side, py - ny * 17 + nx * 9 * side)
          st.lineTo(px + nx * 17 - ny * 9 * side, py + ny * 17 + nx * 9 * side)
        }
        stroke(ctx, st, 4.5)
      }
    })
    dashes(ctx, [
      [130, cy + 190, 330, cy + 90],
      [110, cy + 90, 340, cy - 5],
      [180, cy + 280, 380, cy + 175],
    ])
    const pow = star(820, cy - 200, 78, 9, 0.55, 0.2)
    fill(ctx, pow, 'p', 0.85, 8, 7)
    stroke(ctx, pow, 5)
  },
  // 5 · Our Lady of Mercy Academy — "met with rave reviews": a burst of stars
  (ctx, cy) => {
    sun(ctx, 500, cy, 300, 'p', 0.45)
    const big = star(500, cy + 10, 200, 5, 0.46, -Math.PI / 2 + 0.12)
    fill(ctx, big, 'g', 0.85, 14, 12)
    stroke(ctx, big, 7)
    const a = star(230, cy - 150, 82, 5, 0.46, -Math.PI / 2 - 0.3)
    fill(ctx, a, 'p', 0.8)
    stroke(ctx, a, 6)
    const b = star(790, cy + 150, 70, 5, 0.46, -Math.PI / 2 + 0.4)
    fill(ctx, b, 'p', 0.8)
    stroke(ctx, b, 6)
    sparkle(ctx, 800, cy - 170, 28)
    sparkle(ctx, 210, cy + 170, 22)
  },
  // 6 · The Home Hero — "on time, on budget": a ringing alarm clock
  (ctx, cy) => {
    sun(ctx, 500, cy, 300, 'g', 0.45)
    const cx = 500
    const r = 165
    for (const s of [-1, 1]) {
      const bell = new Path2D()
      const bx = cx + s * 118
      const by = cy - 148
      const a = Math.atan2(by - cy, bx - cx)
      bell.arc(bx, by, 64, a - Math.PI / 2, a + Math.PI / 2)
      bell.closePath()
      fill(ctx, bell, 'p', 0.8)
      stroke(ctx, bell, 6)
      const leg = new Path2D()
      leg.moveTo(cx + s * 95, cy + 135)
      leg.lineTo(cx + s * 140, cy + 205)
      stroke(ctx, leg, 9)
    }
    const body = new Path2D()
    body.arc(cx, cy, r, 0, Math.PI * 2)
    fill(ctx, body, 'g', 0.85)
    // knock the face back to paper
    keep(ctx, () => {
      ctx.fillStyle = col('k', 0)
      ctx.beginPath()
      ctx.arc(cx, cy, r * 0.74, 0, Math.PI * 2)
      ctx.fill()
    })
    stroke(ctx, body, 7)
    const face = new Path2D()
    face.arc(cx, cy, r * 0.74, 0, Math.PI * 2)
    stroke(ctx, face, 4)
    const ticks = new Path2D()
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2
      const r0 = r * (i % 3 ? 0.62 : 0.55)
      ticks.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0)
      ticks.lineTo(cx + Math.cos(a) * r * 0.68, cy + Math.sin(a) * r * 0.68)
    }
    stroke(ctx, ticks, 4)
    const hands = new Path2D()
    hands.moveTo(cx, cy)
    hands.lineTo(cx, cy - r * 0.55)
    hands.moveTo(cx, cy)
    hands.lineTo(cx + r * 0.4, cy)
    stroke(ctx, hands, 9)
    dashes(ctx, [
      [cx - 250, cy - 40, cx - 205, cy - 60],
      [cx - 255, cy + 30, cx - 208, cy + 30],
      [cx + 250, cy - 40, cx + 205, cy - 60],
      [cx + 255, cy + 30, cx + 208, cy + 30],
    ])
  },
  // 7 · ProviderSoft — "something we are really proud of": a rosette
  (ctx, cy) => {
    sun(ctx, 500, cy - 20, 300, 'p', 0.45)
    const cx = 500
    const y = cy - 40
    for (const s of [-1, 1]) {
      const rib = new Path2D()
      rib.moveTo(cx + s * 40, y + 60)
      rib.lineTo(cx + s * 130, y + 290)
      rib.lineTo(cx + s * 88, y + 262)
      rib.lineTo(cx + s * 60, y + 312)
      rib.lineTo(cx - s * 20, y + 80)
      rib.closePath()
      fill(ctx, rib, 'g', 0.85)
      stroke(ctx, rib, 6)
    }
    const ros = new Path2D()
    const n = 18
    for (let i = 0; i <= n * 8; i++) {
      const a = (i / (n * 8)) * Math.PI * 2
      const rr = 170 + Math.cos(a * n) * 14
      const x = cx + Math.cos(a) * rr
      const yy = y + Math.sin(a) * rr
      if (i) ros.lineTo(x, yy)
      else ros.moveTo(x, yy)
    }
    ros.closePath()
    fill(ctx, ros, 'p', 0.8)
    keep(ctx, () => {
      ctx.fillStyle = col('k', 0)
      ctx.beginPath()
      ctx.arc(cx, y, 112, 0, Math.PI * 2)
      ctx.fill()
    })
    stroke(ctx, ros, 6)
    const inner = new Path2D()
    inner.arc(cx, y, 112, 0, Math.PI * 2)
    stroke(ctx, inner, 5)
    const m = markPath(cx, y, 150, 0)
    over(ctx, () => {
      ctx.fillStyle = col('k', 1)
      ctx.fill(m, 'evenodd')
    })
  },
]

/* ----------------------------------------------------------------- pages */

function slugRow(ctx: C2D, left: string, right: string) {
  over(ctx, () => {
    font(ctx, 500, 25, 'mono', 'normal', 0.12)
    ctx.fillStyle = col('k')
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = 'left'
    fillT(ctx, left.toUpperCase(), M, 92)
    ctx.textAlign = 'right'
    fillT(ctx, right.toUpperCase(), W - M, 92)
    ctx.fillRect(M, 116, W - 2 * M, 3)
  })
}

function folio(ctx: C2D, page: number, side: 'L' | 'R') {
  over(ctx, () => {
    ctx.fillStyle = col('k')
    ctx.fillRect(M, H - 118, W - 2 * M, 2)
    font(ctx, 800, 58, 'sans', 'condensed', -0.02)
    ctx.textBaseline = 'alphabetic'
    ctx.textAlign = side === 'L' ? 'left' : 'right'
    fillT(ctx, pad2(page), side === 'L' ? M : W - M, H - 50)
    font(ctx, 500, 21, 'mono', 'normal', 0.14)
    ctx.textAlign = side === 'L' ? 'right' : 'left'
    fillT(ctx, 'HARK ZINE · ISSUE 01 · VOICES', side === 'L' ? W - M : M, H - 60)
  })
}

function drawPull(ctx: C2D, s: number, side: 'L' | 'R', page: number) {
  const t = TESTIMONIALS[s]
  part('pull slug', () => slugRow(ctx, 'Voices', `No. ${pad2(s + 1)} / ${pad2(N)}`))

  // collage element behind the phrase (varies per voice); the top-right
  // corner stays clear for the HEARD stamp
  part('pull collage', () => {
    const v = s % 4
    if (v === 0) sun(ctx, 690, 860, 360, 'g', 0.62)
    else if (v === 1) {
      over(ctx, () => {
        ctx.translate(690, 830)
        ctx.rotate(0.16)
        ctx.fillStyle = col('g', 0.45)
        ctx.fillRect(-235, -235, 470, 470)
      })
    } else if (v === 2) {
      over(ctx, () => {
        ctx.fillStyle = col('p', 1)
        for (let i = 0; i < 10; i++) ctx.fillRect(470, 640 + i * 36, 460, 13)
      })
    } else {
      over(ctx, () => {
        ctx.fillStyle = col('g', 0.52)
        ctx.beginPath()
        ctx.arc(W - M, 840, 330, Math.PI * 0.5, Math.PI * 1.5)
        ctx.fill()
      })
    }
  })

  // the giant opening mark, overprinted in pink
  part('pull mark', () =>
    over(ctx, () => {
      font(ctx, 800, 1180, 'sans', 'normal')
      ctx.fillStyle = col('p')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      const m = ctx.measureText('\u201C')
      fillT(ctx, '\u201C', M - 8 + m.actualBoundingBoxLeft, 160 + m.actualBoundingBoxAscent)
    }),
  )

  // the pull phrase, set as a poster, bottom-aligned above the credit
  part('pull phrase', () => {
    const text = PULLS[s].toUpperCase()
    const top = 520
    const bottom = 1120
    const lh = 0.86
    const { size, lines } = fit(
      ctx,
      text,
      z => font(ctx, 800, z, 'sans', 'condensed', -0.015),
      W - 2 * M,
      bottom - top,
      lh,
      60,
      300,
      5,
    )
    const cap = ctx.measureText('H').actualBoundingBoxAscent
    const y0 = bottom - (lines.length - 1) * size * lh
    // a green marker swipe under the last line
    const last = lines[lines.length - 1]
    const lw = tw(ctx, last)
    over(ctx, () => {
      ctx.translate(M - 18, y0 + (lines.length - 1) * size * lh)
      ctx.rotate(-0.018)
      ctx.fillStyle = col('g', 1)
      ctx.fillRect(0, -cap - size * 0.08, lw + 44, cap + size * 0.2)
    })
    over(ctx, () => {
      ctx.fillStyle = col('k')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      lines.forEach((l, i) => fillT(ctx, l, M, y0 + i * size * lh))
    })
  })

  // credit
  part('pull credit', () =>
    over(ctx, () => {
      font(ctx, 500, 24, 'mono', 'normal', 0.1)
      ctx.fillStyle = col('k')
      ctx.textAlign = 'left'
      fillT(ctx, `— ${t.name}, ${t.company}`.toUpperCase(), M, 1196)
    }),
  )
  part('folio', () => folio(ctx, page, side))
}

function drawStory(ctx: C2D, s: number, side: 'L' | 'R', page: number) {
  const t = TESTIMONIALS[s]
  part('story slug', () => {
    slugRow(ctx, `Client voice ${pad2(s + 1)} / ${pad2(N)}`, '')
    regMark(ctx, W - M - 20, 82, 13)
  })

  part(`doodle ${s}`, () => keep(ctx, () => DOODLES[s](ctx, 400)))

  // the full quote
  part('story quote', () => {
    const top = 700
    const bottom = 1110
    const lh = 1.08
    const q = `“${t.quote}”`
    const { size, lines } = fit(
      ctx,
      q,
      z => font(ctx, 650, z, 'sans', 'semi-condensed', -0.012),
      W - 2 * M,
      bottom - top,
      lh,
      26,
      66,
    )
    const cap = ctx.measureText('H').actualBoundingBoxAscent
    over(ctx, () => {
      ctx.fillStyle = col('k')
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      lines.forEach((l, i) => fillT(ctx, l, M, top + cap + i * size * lh))
    })
  })

  // byline: name + a stamped company box
  part('story byline', () => {
    const by = 1196
    over(ctx, () => {
      font(ctx, 800, 50, 'sans', 'condensed', -0.01)
      ctx.fillStyle = col('k')
      ctx.textAlign = 'left'
      const name = `— ${t.name.toUpperCase()}`
      fillT(ctx, name, M, by)
      const nw = tw(ctx, name)
      font(ctx, 500, 25, 'mono', 'normal', 0.08)
      const co = t.company.toUpperCase()
      const cw = tw(ctx, co)
      const x = Math.min(W - M - cw - 24, M + nw + 26)
      const fitsBeside = x > M + nw + 10
      const bx = fitsBeside ? x : M
      const byy = fitsBeside ? by - 30 : by + 18
      ctx.fillStyle = col('p', 1)
      ctx.fillRect(bx + 5, byy + 4, cw + 24, 42)
      ctx.strokeStyle = col('k')
      ctx.lineWidth = 3
      ctx.strokeRect(bx, byy, cw + 24, 42)
      ctx.fillStyle = col('k')
      fillT(ctx, co, bx + 12, byy + 30)
    })
  })
  part('folio', () => folio(ctx, page, side))
}

/** a rounded box with a tail on its bottom edge, as one closed outline */
function bubblePath(x: number, y: number, w: number, h: number, r: number, t0: number, t1: number, tipX: number, tipY: number) {
  const p = new Path2D()
  p.moveTo(x + r, y)
  p.lineTo(x + w - r, y)
  p.arcTo(x + w, y, x + w, y + r, r)
  p.lineTo(x + w, y + h - r)
  p.arcTo(x + w, y + h, x + w - r, y + h, r)
  p.lineTo(t1, y + h)
  p.lineTo(tipX, tipY)
  p.lineTo(t0, y + h)
  p.lineTo(x + r, y + h)
  p.arcTo(x, y + h, x, y + h - r, r)
  p.lineTo(x, y + r)
  p.arcTo(x, y, x + r, y, r)
  p.closePath()
  return p
}

function drawCover(ctx: C2D) {
  const bleed = 26
  // solid green ground, with the paper margin a riso can't print into
  ctx.fillStyle = col('g', 1)
  ctx.fillRect(bleed, bleed, W - 2 * bleed, H - 2 * bleed)

  // masthead
  part('cover masthead', () =>
    over(ctx, () => {
      font(ctx, 500, 26, 'mono', 'normal', 0.14)
      ctx.fillStyle = col('k')
      ctx.textBaseline = 'alphabetic'
      ctx.textAlign = 'left'
      fillT(ctx, 'HARK ZINE', M, 100)
      ctx.textAlign = 'right'
      fillT(ctx, 'ISSUE 01 · VOICES', W - M, 100)
      ctx.fillRect(M, 124, W - 2 * M, 4)
    }),
  )

  part('cover title', () => {
    // title metrics: WE / LISTEN. / THEY / TALK.
    const lines = ['WE', 'LISTEN.', 'THEY', 'TALK.']
    const setF = (z: number) => font(ctx, 800, z, 'sans', 'condensed', -0.03)
    let size = 330
    setF(size)
    const widest = Math.max(...lines.map(l => tw(ctx, l)))
    size = Math.floor(size * Math.min(1, (W - 2 * M) / widest))
    setF(size)
    const lh = 0.84
    const cap = ctx.measureText('H').actualBoundingBoxAscent
    const y0 = 212 + cap
    const weW = tw(ctx, 'WE')

    // a pink starburst sticker in the space beside WE (under the type: black overprints it)
    part('cover sticker', () => {
      const cx = M + weW + (W - M - (M + weW)) / 2 + 10
      const cy = y0 - cap * 0.52
      const r = Math.min(165, (W - M - (M + weW)) / 2 - 6)
      const burst = star(cx, cy, r, 14, 0.8, 0.1)
      keep(ctx, () => {
        ctx.fillStyle = col('p', 1)
        ctx.fill(burst)
      })
      over(ctx, () => {
        ctx.translate(10, 9)
        ctx.strokeStyle = col('k')
        ctx.lineWidth = 6
        ctx.lineJoin = 'round'
        ctx.stroke(burst)
      })
      over(ctx, () => {
        ctx.translate(cx, cy)
        ctx.rotate(0.16)
        ctx.fillStyle = col('k')
        ctx.textAlign = 'center'
        ctx.textBaseline = 'alphabetic'
        font(ctx, 800, 142, 'sans', 'condensed', -0.02)
        fillT(ctx, '8', 0, 34)
        font(ctx, 500, 25, 'mono', 'normal', 0.12)
        fillT(ctx, 'VOICES', 0, 76)
      })
    })

    // WE / LISTEN. in black; THEY / TALK. knocked out to pink with a black drop
    keep(ctx, () => {
      setF(size)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      lines.forEach((l, i) => {
        const y = y0 + i * size * lh
        if (i < 2) {
          over(ctx, () => {
            ctx.fillStyle = col('k')
            fillT(ctx, l, M, y)
          })
        } else {
          over(ctx, () => {
            ctx.fillStyle = col('k')
            fillT(ctx, l, M + 12, y + 9)
          })
          ctx.fillStyle = col('p', 1)
          fillT(ctx, l, M, y)
        }
      })
    })

    // a speech-bubble keyline around THEY TALK.
    part('cover bubble', () => {
      const top = y0 + 2 * size * lh - cap - 40
      const bot = y0 + 3 * size * lh + 44
      const b = bubblePath(M - 30, top, W - 2 * M + 52, bot - top, 56, M + 110, M + 230, M + 40, Math.min(bot + 96, H - 148))
      stroke(ctx, b, 7)
    })
  })

  // footer: one slim line + the mark
  part('cover footer', () => {
    const fy = H - 78
    over(ctx, () => {
      ctx.fillStyle = col('k')
      ctx.fillRect(M, fy - 46, W - 2 * M, 4)
      font(ctx, 500, 24, 'mono', 'normal', 0.12)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'alphabetic'
      fillT(ctx, 'CLIENT VOICES, IN THEIR OWN WORDS', M, fy)
    })
    const m = markPath(W - M - 30, fy - 9, 60, 0)
    over(ctx, () => {
      ctx.fillStyle = col('k')
      ctx.fill(m, 'evenodd')
    })
    // registration marks in the paper margin
    regMark(ctx, W / 2, 13, 8)
    regMark(ctx, W / 2, H - 13, 8)
  })
}

function drawBack(ctx: C2D) {
  part('back mark', () => {
    sun(ctx, 500, 560, 420, 'g', 0.7)
    const m = markPath(500, 560, 460, 0.1)
    fill(ctx, m, 'p', 0.9, 16, 13, 'evenodd')
    stroke(ctx, m, 6)
  })
  part('back type', () =>
    over(ctx, () => {
      ctx.fillStyle = col('k')
      font(ctx, 800, 120, 'sans', 'condensed', -0.03)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      fillT(ctx, 'MAKE THE', W / 2, 1010)
      fillT(ctx, 'INTERNET LISTEN.', W / 2, 1112)
      font(ctx, 500, 24, 'mono', 'normal', 0.14)
      fillT(ctx, 'HARK.DIGITAL · ISSUE 01 · VOICES', W / 2, 1200)
      // a decorative printer's barcode
      let x = W / 2 - 150
      const r = [3, 1, 2, 1, 1, 3, 2, 1, 3, 1, 1, 2, 3, 1, 2, 2, 1, 3, 1, 2, 1, 1, 3, 2, 1, 2]
      r.forEach((w, i) => {
        if (i % 2 === 0) ctx.fillRect(x, 1250, w * 5, 80)
        x += w * 5 + 4
      })
    }),
  )
}

/* ----------------------------------------------------------------- atlas */

export interface PageAtlas {
  canvas: HTMLCanvasElement
  texture: THREE.CanvasTexture
  /** uv rect (u0, v0, uw, vh) of a face; v measured bottom-up (flipY) */
  rect(face: number, out: THREE.Vector4): THREE.Vector4
}

const COLS = 5
const ROWS = 4

/**
 * Print every face into one atlas. `pageW` is the cell width in pixels.
 * Yields between pages so the loader keeps breathing.
 */
export async function printPages(pageW: number, yieldFn: () => Promise<void>): Promise<PageAtlas> {
  const pw = Math.round(pageW)
  const ph = Math.round(pw * PAGE_ASPECT)
  const gap = 10
  const cw = pw + gap * 2
  const chh = ph + gap * 2
  const canvas = document.createElement('canvas')
  canvas.width = cw * COLS
  canvas.height = chh * ROWS
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const k = pw / W
  for (let f = 0; f < FACES; f++) {
    const cx = (f % COLS) * cw + gap
    const cy = Math.floor(f / COLS) * chh + gap
    ctx.save()
    ctx.translate(cx, cy)
    ctx.beginPath()
    ctx.rect(0, 0, pw, ph)
    ctx.clip()
    ctx.scale(k, k * (ph / pw / (H / W)))
    try {
      if (f === 0) drawCover(ctx)
      else if (f === FACES - 1) drawBack(ctx)
      else {
        const s = Math.floor((f - 1) / 2)
        const side: 'L' | 'R' = (f - 1) % 2 === 0 ? 'L' : 'R'
        const pull = (s % 2 === 0) === (side === 'L')
        if (pull) drawPull(ctx, s, side, f + 1)
        else drawStory(ctx, s, side, f + 1)
      }
    } catch (err) {
      // a page that fails prints as blank paper; the zine (and the chapter) still load
      console.warn('[voices] page print failed', f, err)
    }
    ctx.restore()
    if (f % 3 === 2) await yieldFn()
  }

  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.NoColorSpace
  texture.generateMipmaps = true
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.anisotropy = 8
  const AW = canvas.width
  const AH = canvas.height
  return {
    canvas,
    texture,
    rect(face, out) {
      const x = (face % COLS) * cw + gap
      const y = Math.floor(face / COLS) * chh + gap
      return out.set(x / AW, 1 - (y + ph) / AH, pw / AW, ph / AH)
    },
  }
}

/** Make sure the canvas has the real faces before we print with them. */
export async function loadPageFonts() {
  if (!document.fonts?.load) return
  const sample = 'AZaz09“”—·!'
  const loads = [
    document.fonts.load(`800 100px ${SANS}`, sample),
    document.fonts.load(`650 100px ${SANS}`, sample),
    document.fonts.load(`500 20px ${MONO}`, sample),
  ]
  await Promise.race([Promise.all(loads).catch(() => {}), new Promise(r => setTimeout(r, 2500))])
}

/**
 * The rubber stamp's impression: a pink "HEARD" block stamp with a double
 * border and a mono credit line, inked unevenly (speckle knocked back to
 * paper), baked a little rotated. Square canvas; the art sits inside.
 */
export function printStamp(size: number) {
  const c = document.createElement('canvas')
  c.width = c.height = size
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, size, size)
  const k = size / 1000
  // a stamp that fails to print leaves a clean page (black = no ink), never a broken chapter
  part('stamp', () =>
    keep(ctx, () => {
      ctx.translate(size / 2, size / 2)
      ctx.rotate(-0.17)
      ctx.scale(k, k)
      const ink = col('p', 1)
      ctx.strokeStyle = ink
      ctx.fillStyle = ink
      const bw = 820
      const bh = 470
      ctx.lineWidth = 26
      ctx.stroke(roundRect(-bw / 2, -bh / 2, bw, bh, 34))
      ctx.lineWidth = 8
      ctx.stroke(roundRect(-bw / 2 + 34, -bh / 2 + 34, bw - 68, bh - 68, 16))
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      font(ctx, 800, 270, 'sans', 'condensed', 0.01)
      fillT(ctx, 'HEARD', 0, 74)
      font(ctx, 500, 44, 'mono', 'normal', 0.14)
      fillT(ctx, 'HARK.DIGITAL', 0, -118)
      fillT(ctx, 'CLIENT VOICES', 0, 160)
    }),
  )
  // uneven rubber: speckle and a starved corner knocked back to paper
  part('stamp speckle', () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#000'
    let seed = 11
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 520; i++) {
      const r = (rnd() < 0.93 ? rnd() * 1.4 : rnd() * 4.5) * k * 4
      ctx.beginPath()
      ctx.arc(rnd() * size, rnd() * size, r, 0, Math.PI * 2)
      ctx.fill()
    }
  })
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.NoColorSpace
  tex.generateMipmaps = true
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.anisotropy = 8
  return tex
}

