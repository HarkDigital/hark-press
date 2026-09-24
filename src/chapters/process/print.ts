import { logoOutlines } from '../../logo/logo'
import { F2_Y, FOLDS, HH, HW, WING, type Crease, type V2 } from './fold'

/*
 * Everything the press puts on paper for the Fold, drawn on 2D canvases whose
 * R/G/B channels are INK densities (pink / green / black), not colours.
 *
 *   front  the fold-up template: dashed creases (valley) and dash-dot
 *          (mountain), numbered badges, fold arrows, and each step's name
 *          printed on the panel that moves at that step
 *   back   airmail: striped border (so fold 1 reveals an envelope flap), the
 *          Hark livery along the fuselage strips, SUPPORT under the wings
 *   mat    a green self-healing cutting mat with a knocked-out grid, ruler,
 *          crop marks and registration targets around the sheet
 *   stamps the three stats, as rubber-stamp impressions for the wings
 */

export const PINK = 'rgb(255,0,0)'
export const GREEN = 'rgb(0,255,0)'
export const BLACK = 'rgb(0,0,255)'
const NONE = 'rgb(0,0,0)'
const tint = (ink: 'p' | 'g' | 'k', d: number) => {
  const v = Math.round(255 * d)
  return ink === 'p' ? `rgb(${v},0,0)` : ink === 'g' ? `rgb(0,${v},0)` : `rgb(0,0,${v})`
}

const SANS = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif'
const MONO = '"DM Mono", ui-monospace, monospace'

/** Make sure the webfonts are in before any canvas type is set. */
export async function loadPrintFonts() {
  if (!document.fonts?.load) return
  await Promise.all([
    document.fonts.load(`800 100px ${SANS}`, 'LISTEN PROTOTYPE BUILD SUPPORT 0123456789$+'),
    document.fonts.load(`500 40px ${MONO}`, 'HARK PRESS 0123456789'),
  ]).catch(() => {})
}

type Ctx = CanvasRenderingContext2D

function sheetCanvas(S: number) {
  const c = document.createElement('canvas')
  c.width = Math.round(2 * HW * S)
  c.height = Math.round(2 * HH * S)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = NONE
  ctx.fillRect(0, 0, c.width, c.height)
  // sheet units, y up
  ctx.setTransform(S, 0, 0, -S, HW * S, HH * S)
  return { c, ctx }
}

/**
 * Set type in sheet units: (x, y) anchor, angle (radians, CCW), cap size in
 * units. `fit` squeezes the line to a maximum length.
 */
function text(
  ctx: Ctx,
  S: number,
  str: string,
  x: number,
  y: number,
  angle: number,
  size: number,
  o: { font?: 'sans' | 'mono'; weight?: number; fill?: string; align?: CanvasTextAlign; base?: CanvasTextBaseline; fit?: number; track?: number; condensed?: boolean } = {},
) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.scale(1 / S, -1 / S)
  const px = size * S
  const fam = o.font === 'mono' ? MONO : SANS
  ctx.font = `${o.weight ?? (o.font === 'mono' ? 500 : 800)} ${px}px ${fam}`
  const c2 = ctx as Ctx & { fontStretch?: string; letterSpacing?: string }
  if (o.font !== 'mono' && o.condensed !== false && 'fontStretch' in c2) c2.fontStretch = 'condensed'
  if (o.track && 'letterSpacing' in c2) c2.letterSpacing = `${o.track * px}px`
  ctx.textAlign = o.align ?? 'center'
  ctx.textBaseline = o.base ?? 'middle'
  ctx.fillStyle = o.fill ?? BLACK
  if (o.fit) {
    const w = ctx.measureText(str).width
    const max = o.fit * S
    if (w > max) ctx.scale(max / w, 1)
  }
  ctx.fillText(str, 0, 0)
  ctx.restore()
}

function dashed(ctx: Ctx, a: V2, b: V2, width: number, dash: number[], color = BLACK) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.setLineDash(dash)
  ctx.lineCap = 'butt'
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.lineTo(b[0], b[1])
  ctx.stroke()
  ctx.restore()
}

function regMark(ctx: Ctx, x: number, y: number, r: number, color = BLACK, lw = 0.006) {
  ctx.save()
  ctx.strokeStyle = color
  ctx.lineWidth = lw
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.moveTo(x - r * 1.6, y)
  ctx.lineTo(x + r * 1.6, y)
  ctx.moveTo(x, y - r * 1.6)
  ctx.lineTo(x, y + r * 1.6)
  ctx.stroke()
  ctx.restore()
}

function badge(ctx: Ctx, S: number, x: number, y: number, r: number, n: string, fill: string) {
  ctx.save()
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = BLACK
  ctx.lineWidth = r * 0.14
  ctx.stroke()
  ctx.restore()
  ctx.save()
  ctx.globalCompositeOperation = 'lighter'
  text(ctx, S, n, x, y - r * 0.04, 0, r * 1.45, { fill: BLACK })
  ctx.restore()
}

/** A curved fold arrow from a to b, bulging to the left of a→b. */
function foldArrow(ctx: Ctx, a: V2, b: V2, bulge: number, lw: number, color = BLACK) {
  const mx = (a[0] + b[0]) / 2
  const my = (a[1] + b[1]) / 2
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const L = Math.hypot(dx, dy)
  const cx = mx - (dy / L) * bulge
  const cy = my + (dx / L) * bulge
  ctx.save()
  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = lw
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(a[0], a[1])
  ctx.quadraticCurveTo(cx, cy, b[0], b[1])
  ctx.stroke()
  // arrowhead along the curve's end tangent
  const tx = b[0] - cx
  const ty = b[1] - cy
  const tl = Math.hypot(tx, ty)
  const ux = tx / tl
  const uy = ty / tl
  const hs = lw * 4.2
  ctx.beginPath()
  ctx.moveTo(b[0] + ux * hs * 0.4, b[1] + uy * hs * 0.4)
  ctx.lineTo(b[0] - ux * hs - uy * hs * 0.62, b[1] - uy * hs + ux * hs * 0.62)
  ctx.lineTo(b[0] - ux * hs + uy * hs * 0.62, b[1] - uy * hs - ux * hs * 0.62)
  ctx.closePath()
  ctx.fill()
  // tail dot
  ctx.beginPath()
  ctx.arc(a[0], a[1], lw * 1.3, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
}

function border(ctx: Ctx, w: number) {
  ctx.save()
  ctx.strokeStyle = BLACK
  ctx.lineWidth = w
  ctx.strokeRect(-HW + w / 2, -HH + w / 2, 2 * HW - w, 2 * HH - w)
  ctx.restore()
}

/** Hark mark as a filled path, 1 unit tall, centred on (x, y). */
function mark(ctx: Ctx, x: number, y: number, size: number, angle: number, fill: string) {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(angle)
  ctx.scale(size, size)
  ctx.fillStyle = fill
  ctx.beginPath()
  for (const loop of logoOutlines()) {
    loop.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
  }
  ctx.fill('evenodd')
  ctx.restore()
}

// ------------------------------------------------------------------ FRONT

/** crease styles by fold index: [valley?, width scale] */
const MOUNTAIN = new Set([5, 6])

export function drawFront(creases: Crease[], S: number) {
  const { c, ctx } = sheetCanvas(S)
  const u = 1 / S
  const lw = Math.max(0.0075, 3.2 * u)

  // --- panel inks: a tint block per step so each moving panel reads at a glance
  // fold 1 corners: pink tint
  ctx.fillStyle = tint('p', 0.22)
  for (const sx of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(0, HH)
    ctx.lineTo(sx * HW, HH)
    ctx.lineTo(sx * HW, HH - HW)
    ctx.closePath()
    ctx.fill()
  }
  // fold 2 strips: green tint
  ctx.fillStyle = tint('g', 0.2)
  for (const sx of [-1, 1]) {
    ctx.beginPath()
    ctx.moveTo(0, HH)
    ctx.lineTo(sx * HW, HH - HW)
    ctx.lineTo(sx * HW, F2_Y)
    ctx.closePath()
    ctx.fill()
  }

  // --- step names on the panels that move
  ctx.globalCompositeOperation = 'lighter'
  // 1 LISTEN, along each corner's crease
  const c1 = 0.29
  text(ctx, S, 'LISTEN', -HW + c1 + 0.04, HH - c1 - 0.02, Math.PI / 4, 0.17, { fill: PINK, fit: 0.78 })
  text(ctx, S, 'LISTEN', HW - c1 - 0.04, HH - c1 - 0.02, -Math.PI / 4, 0.17, { fill: PINK, fit: 0.78 })
  // 2 PROTOTYPE, up the long edges
  text(ctx, S, 'PROTOTYPE', -HW + 0.13, -0.33, Math.PI / 2, 0.16, { fill: GREEN, fit: 1.08 })
  text(ctx, S, 'PROTOTYPE', HW - 0.13, -0.33, -Math.PI / 2, 0.16, { fill: GREEN, fit: 1.08 })
  // 3 BUILD, up the half that folds over (inside the fuselage once it's flown)
  text(ctx, S, 'BUILD', -0.15, -0.86, Math.PI / 2, 0.23, { fill: BLACK, fit: 0.72 })
  ctx.globalCompositeOperation = 'source-over'

  // --- creases (from the real pattern)
  const dash = [0.045, 0.028]
  const dashDot = [0.05, 0.022, 0.008, 0.022]
  for (const cr of creases) {
    const mountain = MOUNTAIN.has(cr.fold)
    ctx.globalCompositeOperation = 'lighter'
    dashed(ctx, cr.a, cr.b, lw, mountain ? dashDot : dash)
  }
  ctx.globalCompositeOperation = 'source-over'

  // --- fold arrows
  ctx.globalCompositeOperation = 'lighter'
  const aw = lw * 0.9
  foldArrow(ctx, [-0.86, 1.16], [-0.16, 0.5], -0.22, aw)
  foldArrow(ctx, [0.86, 1.16], [0.16, 0.5], 0.22, aw)
  foldArrow(ctx, [-0.9, -0.62], [-0.18, -0.2], 0.2, aw)
  foldArrow(ctx, [0.9, -0.62], [0.18, -0.2], -0.2, aw)
  foldArrow(ctx, [-0.62, 0.05], [0.42, 0.05], 0.26, aw)
  ctx.globalCompositeOperation = 'source-over'

  // --- numbered badges on the main crease of each fold
  const r = 0.066
  const onLine = (a: V2, b: V2, t: number): V2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
  badge(ctx, S, ...onLine([0, HH], [-HW, HH - HW], 0.5), r, '1', PINK)
  badge(ctx, S, ...onLine([0, HH], [HW, HH - HW], 0.5), r, '1', PINK)
  badge(ctx, S, ...onLine([0, HH], [-HW, F2_Y], 0.62), r, '2', GREEN)
  badge(ctx, S, ...onLine([0, HH], [HW, F2_Y], 0.62), r, '2', GREEN)
  badge(ctx, S, 0, -0.55, r, '3', PINK)
  badge(ctx, S, -WING, -0.62, r, '4', GREEN)
  badge(ctx, S, WING, -0.62, r, '4', GREEN)

  // --- slugs + marks (the print shop's own furniture)
  ctx.globalCompositeOperation = 'lighter'
  text(ctx, S, 'FOLD-UP No.06 · 4 FOLDS · 1 SHEET', 0.5, -1.2, 0, 0.042, { font: 'mono', align: 'center', fit: 0.9 })
  text(ctx, S, 'HARK PRESS', 0.5, -1.125, 0, 0.05, { font: 'mono', weight: 500, fit: 0.9, track: 0.18 })
  // colour bar
  const bars: [string, number][] = [
    ['p', 1],
    ['p', 0.5],
    ['g', 1],
    ['g', 0.5],
    ['k', 1],
    ['k', 0.5],
    ['k', 0.2],
  ]
  bars.forEach(([ink, d], i) => {
    ctx.fillStyle = tint(ink as 'p' | 'g' | 'k', d)
    ctx.fillRect(0.2 + i * 0.085, -1.03, 0.07, 0.07)
  })
  regMark(ctx, 0.88, -1.16, 0.028)
  regMark(ctx, -0.88, 0.1, 0.028)
  text(ctx, S, 'NOSE', 0, HH - 0.07, 0, 0.034, { font: 'mono', track: 0.2 })
  ctx.globalCompositeOperation = 'source-over'

  border(ctx, Math.max(0.008, 3.4 * u))
  return c
}

// ------------------------------------------------------------------ BACK

export function drawBack(S: number) {
  const { c, ctx } = sheetCanvas(S)
  const u = 1 / S

  // airmail border: diagonal stripes, pink / green, inside a band along every edge
  const band = 0.085
  ctx.save()
  ctx.beginPath()
  ctx.rect(-HW, -HH, 2 * HW, 2 * HH)
  ctx.rect(-HW + band, HH - band, 2 * (HW - band), -2 * (HH - band))
  ctx.clip('evenodd')
  const period = 0.14
  const sw = period * 0.32
  for (let k = -40; k < 40; k++) {
    const x0 = k * period
    ctx.fillStyle = k % 2 === 0 ? PINK : GREEN
    ctx.beginPath()
    ctx.moveTo(x0 - 3, -3)
    ctx.lineTo(x0 - 3 + sw, -3)
    ctx.lineTo(x0 + 3 + sw, 3)
    ctx.lineTo(x0 + 3, 3)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()

  ctx.globalCompositeOperation = 'lighter'
  // Fuselage livery, both strips (back view coordinates: xb = -x). On the
  // xb > 0 strip the type runs nose → tail with its cap toward the wing root;
  // mirrored on the other strip.
  for (const side of [1, -1]) {
    const xm = side * WING * 0.5
    const ang = side > 0 ? -Math.PI / 2 : Math.PI / 2
    // the mark near the nose end, livery type behind it
    const my = side > 0 ? 0.3 : 0.3
    mark(ctx, xm, my, 0.2, side > 0 ? -Math.PI / 2 : Math.PI / 2, PINK)
    text(ctx, S, 'HARK AIRMAIL', xm, -0.28, ang, 0.13, { fill: BLACK, fit: 0.84 })
    text(ctx, S, 'PAR AVION · No.06', xm + side * 0.085 * 0, -0.98, ang, 0.034, { font: 'mono', fit: 0.5, track: 0.14 })
  }

  // SUPPORT, under each wing (the panel that folds at step 4)
  text(ctx, S, 'SUPPORT', 0.58, -0.78, Math.PI / 2, 0.19, { fill: GREEN, fit: 0.78 })
  text(ctx, S, 'SUPPORT', -0.58, -0.78, -Math.PI / 2, 0.19, { fill: GREEN, fit: 0.78 })
  badge(ctx, S, 0.46, -0.2, 0.05, '4', PINK)
  badge(ctx, S, -0.46, -0.2, 0.05, '4', PINK)
  ctx.globalCompositeOperation = 'source-over'

  // wing creases, printed lightly on this side too (so the fold reads from above)
  const lw = Math.max(0.006, 2.6 * u)
  dashed(ctx, [WING, -HH], [WING, HH - WING / Math.tan(Math.PI / 8)], lw, [0.05, 0.022, 0.008, 0.022])
  dashed(ctx, [-WING, -HH], [-WING, HH - WING / Math.tan(Math.PI / 8)], lw, [0.05, 0.022, 0.008, 0.022])

  border(ctx, Math.max(0.008, 3.4 * u))
  return c
}

// ------------------------------------------------------------------ MAT

/** Mat extent in world units, centred on the sheet. */
export const MAT = { w: 7.2, h: 5.2 }

export function drawMat(S: number) {
  const c = document.createElement('canvas')
  c.width = Math.round(MAT.w * S)
  c.height = Math.round(MAT.h * S)
  const ctx = c.getContext('2d')!
  ctx.fillStyle = NONE
  ctx.fillRect(0, 0, c.width, c.height)
  // mat units, y up (y = world -z, i.e. toward the nose), origin at the centre
  ctx.setTransform(S, 0, 0, -S, (MAT.w / 2) * S, (MAT.h / 2) * S)
  const u = 1 / S
  const hw = MAT.w / 2
  const hh = MAT.h / 2
  const rr = 0.16

  const rounded = () => {
    ctx.beginPath()
    ctx.moveTo(-hw + rr, -hh)
    ctx.lineTo(hw - rr, -hh)
    ctx.quadraticCurveTo(hw, -hh, hw, -hh + rr)
    ctx.lineTo(hw, hh - rr)
    ctx.quadraticCurveTo(hw, hh, hw - rr, hh)
    ctx.lineTo(-hw + rr, hh)
    ctx.quadraticCurveTo(-hw, hh, -hw, hh - rr)
    ctx.lineTo(-hw, -hh + rr)
    ctx.quadraticCurveTo(-hw, -hh, -hw + rr, -hh)
    ctx.closePath()
  }
  rounded()
  ctx.fillStyle = tint('g', 0.62)
  ctx.fill()

  ctx.save()
  rounded()
  ctx.clip()
  // knocked-out grid (paper shows through the green)
  ctx.strokeStyle = NONE
  const step = 0.2
  for (let x = -hw + 0.3; x <= hw; x += step) {
    const major = Math.abs(Math.round((x - (-hw + 0.3)) / step) % 5) === 0
    ctx.lineWidth = major ? Math.max(0.012, 3.4 * u) : Math.max(0.005, 1.6 * u)
    ctx.beginPath()
    ctx.moveTo(x, -hh)
    ctx.lineTo(x, hh)
    ctx.stroke()
  }
  for (let y = hh - 0.3; y >= -hh; y -= step) {
    const major = Math.abs(Math.round((hh - 0.3 - y) / step) % 5) === 0
    ctx.lineWidth = major ? Math.max(0.012, 3.4 * u) : Math.max(0.005, 1.6 * u)
    ctx.beginPath()
    ctx.moveTo(-hw, y)
    ctx.lineTo(hw, y)
    ctx.stroke()
  }
  // 45° guide lines
  ctx.lineWidth = Math.max(0.006, 2 * u)
  ctx.setLineDash([0.06, 0.05])
  for (let k = -3; k <= 3; k++) {
    ctx.beginPath()
    ctx.moveTo(-hw + k * 2.2, -hh)
    ctx.lineTo(-hw + k * 2.2 + MAT.h, hh)
    ctx.stroke()
  }
  ctx.setLineDash([])
  // ruler numbers along the top and left
  ctx.globalCompositeOperation = 'lighter'
  let n = 0
  for (let x = -hw + 0.3; x <= hw - 0.2; x += step * 5) {
    text(ctx, S, String(n++), x + 0.035, hh - 0.14, 0, 0.075, { font: 'mono', align: 'left', fill: BLACK })
  }
  n = 0
  for (let y = hh - 0.3; y >= -hh + 0.2; y -= step * 5) {
    text(ctx, S, String(n++), -hw + 0.12, y - 0.07, 0, 0.075, { font: 'mono', align: 'left', fill: BLACK })
  }
  text(ctx, S, 'SELF-HEALING · HARK PRESS · CUT ON GREEN', hw - 0.2, -hh + 0.14, 0, 0.06, { font: 'mono', align: 'right', track: 0.12 })
  ctx.globalCompositeOperation = 'source-over'
  ctx.restore()

  // mat edge
  rounded()
  ctx.strokeStyle = BLACK
  ctx.lineWidth = Math.max(0.012, 3.5 * u)
  ctx.stroke()

  // crop marks + registration targets around where the sheet lies
  ctx.globalCompositeOperation = 'lighter'
  ctx.strokeStyle = BLACK
  ctx.lineWidth = Math.max(0.01, 3 * u)
  const off = 0.07
  const len = 0.24
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const x = sx * HW
      const y = sy * HH
      ctx.beginPath()
      ctx.moveTo(x + sx * off, y)
      ctx.lineTo(x + sx * (off + len), y)
      ctx.moveTo(x, y + sy * off)
      ctx.lineTo(x, y + sy * (off + len))
      ctx.stroke()
    }
  }
  regMark(ctx, 0, HH + 0.22, 0.05, BLACK, Math.max(0.009, 2.6 * u))
  regMark(ctx, 0, -HH - 0.22, 0.05, BLACK, Math.max(0.009, 2.6 * u))
  regMark(ctx, -HW - 0.22, 0, 0.05, BLACK, Math.max(0.009, 2.6 * u))
  regMark(ctx, HW + 0.22, 0, 0.05, BLACK, Math.max(0.009, 2.6 * u))
  text(ctx, S, 'TRIM 8.5 × 11 · JOB 06 · FOLD', -HW, -HH - 0.2, 0, 0.055, { font: 'mono', align: 'left', track: 0.1 })
  ctx.globalCompositeOperation = 'source-over'
  return c
}

// ------------------------------------------------------------------ STAMPS

/**
 * A rubber-stamp impression, reversed: a solid block of one ink with the
 * value knocked out to paper, a keyline and an index slug, a little worn.
 * Alpha is the stamp's footprint (paper inside the letters stays opaque).
 */
export function drawStamp(value: string, ink: string, idx: number, W = 640, H = 256) {
  const c = document.createElement('canvas')
  c.width = W
  c.height = H
  const ctx = c.getContext('2d')!
  ctx.clearRect(0, 0, W, H)
  const pad = 10
  const r = 22
  const block = () => {
    ctx.beginPath()
    ctx.moveTo(pad + r, pad)
    ctx.arcTo(W - pad, pad, W - pad, H - pad, r)
    ctx.arcTo(W - pad, H - pad, pad, H - pad, r)
    ctx.arcTo(pad, H - pad, pad, pad, r)
    ctx.arcTo(pad, pad, W - pad, pad, r)
    ctx.closePath()
  }
  block()
  ctx.fillStyle = ink
  ctx.fill()
  // knock out: keyline, value, slug
  ctx.strokeStyle = NONE
  ctx.lineWidth = 5
  ctx.strokeRect(pad + 16, pad + 16, W - 2 * pad - 32, H - 2 * pad - 32)
  ctx.fillStyle = NONE
  const px = H * 0.6
  ctx.font = `800 ${px}px ${SANS}`
  const c2 = ctx as Ctx & { fontStretch?: string }
  if ('fontStretch' in c2) c2.fontStretch = 'condensed'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'alphabetic'
  const label = value.toUpperCase()
  const w = ctx.measureText(label).width
  const max = W - 2 * (pad + 44)
  ctx.save()
  ctx.translate(W / 2, H / 2 + px * 0.35)
  if (w > max) ctx.scale(max / w, 1)
  ctx.fillText(label, 0, 0)
  ctx.restore()
  ctx.font = `500 ${H * 0.075}px ${MONO}`
  ctx.textAlign = 'left'
  ctx.fillText(`0${idx + 1}/03`, pad + 30, pad + 50)
  // wear: specks where the rubber didn't take ink
  let seed = 7 + idx * 131
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  ctx.save()
  block()
  ctx.clip()
  for (let i = 0; i < 320; i++) {
    const sz = 1 + rnd() * 3.4
    ctx.fillRect(rnd() * W, rnd() * H, sz, sz * (0.5 + rnd()))
  }
  // a dry edge along one side
  for (let i = 0; i < 160; i++) {
    const sz = 1 + rnd() * 5
    ctx.fillRect(W - pad - rnd() * rnd() * 70, rnd() * H, sz, sz)
  }
  ctx.restore()
  return c
}

export const FOLD_COUNT = FOLDS.length
