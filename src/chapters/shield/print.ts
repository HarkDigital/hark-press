import * as THREE from 'three'
import { BRAND } from '../../content'
import { logoShapes } from '../../logo/logo'
import { rng } from '../../core/math'

/*
 * Print art for the Shredder, drawn on 2D canvases as INK DENSITIES
 * (R = pink, G = green, B = black; see src/print/ink.ts). Channels are
 * combined with 'lighter' so inks overprint instead of replacing each other.
 *
 * The page is split in two plates:
 *   screen — flat fills the press screens into halftone dots (hero block, images)
 *   crisp  — type, rules and marks printed contone so they stay sharp
 */

/** page trim in world units (portrait, ~US letter) */
export const PAGE_W = 3.0
export const PAGE_H = 3.9

export const SANS = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif'
export const MONO = '"DM Mono", ui-monospace, monospace'

type C2D = CanvasRenderingContext2D

const ink = (p: number, g: number, k: number) =>
  `rgb(${Math.round(p * 255)},${Math.round(g * 255)},${Math.round(k * 255)})`
const K = (d = 1) => ink(0, 0, d)
const P = (d = 1) => ink(d, 0, 0)
const G = (d = 1) => ink(0, d, 0)

export async function loadPrintFonts() {
  if (!document.fonts?.load) return
  try {
    await Promise.all([
      document.fonts.load(`800 100px ${SANS}`),
      document.fonts.load(`800 condensed 100px ${SANS}`),
      document.fonts.load(`500 20px ${MONO}`),
    ])
  } catch {
    /* fall back to whatever is available */
  }
}

let condensedOK: boolean | null = null
/** Poster type: Bricolage, heavy and condensed (real wdth axis, or a squeeze fallback). */
function poster(ctx: C2D, text: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left', weight = 800) {
  if (condensedOK === null) {
    ctx.font = `${weight} 100px ${SANS}`
    const a = ctx.measureText('HACKED BREATHE').width
    ctx.font = `${weight} condensed 100px ${SANS}`
    const b = ctx.measureText('HACKED BREATHE').width
    condensedOK = b < a * 0.95
  }
  ctx.save()
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  if (condensedOK) {
    ctx.font = `${weight} condensed ${size}px ${SANS}`
    ctx.fillText(text, x, y)
  } else {
    ctx.font = `${weight} ${size}px ${SANS}`
    ctx.translate(x, y)
    ctx.scale(0.8, 1)
    ctx.fillText(text, 0, 0)
  }
  ctx.restore()
}

function posterWidth(ctx: C2D, text: string, size: number, weight = 800) {
  ctx.save()
  ctx.font = condensedOK ? `${weight} condensed ${size}px ${SANS}` : `${weight} ${size}px ${SANS}`
  const w = ctx.measureText(text).width * (condensedOK ? 1 : 0.8)
  ctx.restore()
  return w
}

function mono(ctx: C2D, text: string, x: number, y: number, size: number, align: CanvasTextAlign = 'left', track = 0.08) {
  ctx.save()
  ctx.font = `500 ${size}px ${MONO}`
  ctx.textAlign = align
  ctx.textBaseline = 'alphabetic'
  if ('letterSpacing' in ctx) (ctx as C2D & { letterSpacing: string }).letterSpacing = `${(size * track).toFixed(1)}px`
  ctx.fillText(text, x, y)
  ctx.restore()
}

function rrect(ctx: C2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** The Hark mark, `h` px tall, centred on (cx, cy). */
function mark(ctx: C2D, cx: number, cy: number, h: number) {
  ctx.save()
  ctx.translate(cx, cy)
  ctx.scale(h, -h)
  for (const s of logoShapes()) {
    ctx.beginPath()
    const pts = s.getPoints(40)
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
    ctx.closePath()
    for (const hole of s.holes) {
      const hp = hole.getPoints(24)
      hp.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)))
      ctx.closePath()
    }
    ctx.fill('evenodd')
  }
  ctx.restore()
}

/** crop mark pair at a trim corner (sx, sy = outward directions) */
function cropMark(ctx: C2D, x: number, y: number, sx: number, sy: number, len: number, gap: number) {
  ctx.beginPath()
  ctx.moveTo(x + sx * gap, y)
  ctx.lineTo(x + sx * (gap + len), y)
  ctx.moveTo(x, y + sy * gap)
  ctx.lineTo(x, y + sy * (gap + len))
  ctx.stroke()
}

function regMark(ctx: C2D, x: number, y: number, r: number) {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.moveTo(x - r * 1.6, y)
  ctx.lineTo(x + r * 1.6, y)
  ctx.moveTo(x, y - r * 1.6)
  ctx.lineTo(x, y + r * 1.6)
  ctx.stroke()
}

function makeCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.globalCompositeOperation = 'lighter'
  return { c, ctx }
}

export function canvasTexture(c: HTMLCanvasElement, aniso = 8) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  // canvas pixels are premultiplied: keep them so antialiased edges carry partial ink
  t.premultiplyAlpha = true
  t.anisotropy = aniso
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  t.needsUpdate = true
  return t
}

/**
 * The page: Hark's own homepage, printed as a proof — browser bar, nav with
 * the mark, a pink hero with the tagline, work cards, copy, footer, plus the
 * print shop's crop marks, registration targets and a colour bar.
 */
export function drawPage(width: number) {
  const height = Math.round((width * PAGE_H) / PAGE_W)
  const u = width / 1000 // design units: 1000 across
  const scr = makeCanvas(width, height)
  const crs = makeCanvas(width, height)
  const S = scr.ctx
  const C = crs.ctx
  S.scale(u, u)
  C.scale(u, u)
  const H = height / u // ≈1300

  const trim = { x: 34, y: 34, w: 1000 - 68, h: H - 68 }

  // ---- print-shop furniture (margins)
  C.strokeStyle = K(1)
  C.lineWidth = 2
  const cm = 22
  cropMark(C, trim.x, trim.y, -1, -1, cm, 6)
  cropMark(C, trim.x + trim.w, trim.y, 1, -1, cm, 6)
  cropMark(C, trim.x, trim.y + trim.h, -1, 1, cm, 6)
  cropMark(C, trim.x + trim.w, trim.y + trim.h, 1, 1, cm, 6)
  C.lineWidth = 1.6
  regMark(C, 500, 17, 7)
  regMark(C, 500, H - 17, 7)
  C.fillStyle = K(0.9)
  mono(C, 'HARK.DIGITAL — PROOF 05/07', trim.x, 24, 13)
  mono(C, 'RUN 01 · 3 DRUMS', trim.x + trim.w, 24, 13, 'right')
  // colour bar (screened steps + solid)
  const bars: [number, number, number][] = [
    [1, 0, 0], [0.6, 0, 0], [0.3, 0, 0],
    [0, 1, 0], [0, 0.6, 0], [0, 0.3, 0],
    [0, 0, 1], [0, 0, 0.6], [0, 0, 0.3],
  ]
  bars.forEach((b, i) => {
    S.fillStyle = ink(...b)
    S.fillRect(trim.x + 8 + i * 30, H - 27, 26, 18)
  })
  C.fillStyle = K(0.9)
  mono(C, 'OK TO PRINT? [ ]', trim.x + trim.w, H - 13, 13, 'right')

  // ---- the "screen" of the site, inside the trim
  const L = trim.x + 40
  const R = trim.x + trim.w - 40
  const Wc = R - L

  // browser bar
  C.strokeStyle = K(1)
  C.lineWidth = 3
  rrect(C, L, 70, Wc, 50, 12)
  C.stroke()
  C.lineWidth = 2.5
  for (let i = 0; i < 3; i++) {
    C.beginPath()
    C.arc(L + 26 + i * 24, 95, 7, 0, Math.PI * 2)
    C.stroke()
  }
  rrect(C, L + 120, 80, Wc - 240, 30, 15)
  C.lineWidth = 2
  C.stroke()
  C.fillStyle = K(1)
  mono(C, 'https://hark.digital', L + 120 + (Wc - 240) / 2, 101, 17, 'center', 0.04)
  // lock glyph
  C.strokeStyle = K(1)
  C.lineWidth = 2
  C.strokeRect(L + 138, 92, 12, 10)
  C.beginPath()
  C.arc(L + 144, 92, 4.5, Math.PI, 0)
  C.stroke()

  // nav
  C.fillStyle = K(1)
  mark(C, L + 24, 170, 44)
  poster(C, 'HARK', L + 58, 184, 40)
  mono(C, 'WORK   SERVICES   VOICES', L + 330, 178, 15)
  S.fillStyle = G(1)
  rrect(S, R - 190, 150, 190, 40, 20)
  S.fill()
  C.fillStyle = K(1)
  mono(C, 'START A PROJECT', R - 95, 176, 14, 'center', 0.06)

  // hero: a pink block that fades down into dots
  const hy = 218
  const hh = 430
  const grad = S.createLinearGradient(0, hy, 0, hy + hh)
  grad.addColorStop(0, P(0.95))
  grad.addColorStop(0.55, P(0.8))
  grad.addColorStop(1, P(0.42))
  S.fillStyle = grad
  S.fillRect(L, hy, Wc, hh)
  // tagline, three lines of poster type
  C.fillStyle = K(1)
  const words = BRAND.tagline.toUpperCase().replace(/\.$/, '.').split(' ') // MAKE THE INTERNET LISTEN.
  const lines = [`${words[0]} ${words[1]}`, words[2], words.slice(3).join(' ')]
  let size = 150
  const maxW = Wc - 70
  for (const ln of lines) size = Math.min(size, (150 * maxW) / Math.max(1, posterWidth(C, ln, 150)))
  lines.forEach((ln, i) => poster(C, ln, L + 34, hy + 34 + size * 0.78 * (i + 1) + i * 4, size))
  // green sticker, overprinting the pink
  S.fillStyle = G(1)
  S.beginPath()
  S.arc(R - 86, hy + hh - 84, 58, 0, Math.PI * 2)
  S.fill()
  C.fillStyle = K(1)
  C.save()
  C.translate(R - 86, hy + hh - 84)
  C.rotate(-0.22)
  mono(C, 'EST.', 0, -8, 15, 'center')
  poster(C, '2016', 0, 26, 40, 'center')
  C.restore()

  // selected work
  const wy = hy + hh + 50
  C.fillStyle = K(1)
  mono(C, 'SELECTED WORK', L, wy, 15)
  mono(C, '15 SITES →', R, wy, 15, 'right')
  C.fillStyle = K(0.9)
  C.fillRect(L, wy + 12, Wc, 2)
  const cw = (Wc - 40) / 3
  const cy = wy + 34
  const chh = 190
  const rand = rng(11)
  for (let i = 0; i < 3; i++) {
    const x = L + i * (cw + 20)
    // halftone "photo": a green gradient with a black shape in it
    const g2 = S.createLinearGradient(x, cy, x + cw, cy + chh)
    g2.addColorStop(0, K(0.62))
    g2.addColorStop(1, K(0.14))
    S.fillStyle = g2
    S.fillRect(x, cy, cw, chh)
    S.fillStyle = i === 1 ? K(0.9) : P(0.9)
    S.beginPath()
    if (i === 0) S.arc(x + cw * 0.62, cy + chh * 0.55, chh * 0.3, 0, Math.PI * 2)
    else if (i === 1) S.rect(x + cw * 0.18, cy + chh * 0.3, cw * 0.5, chh * 0.5)
    else {
      S.moveTo(x + cw * 0.15, cy + chh * 0.85)
      S.lineTo(x + cw * 0.5, cy + chh * 0.2)
      S.lineTo(x + cw * 0.85, cy + chh * 0.85)
    }
    S.fill()
    C.strokeStyle = K(1)
    C.lineWidth = 2
    C.strokeRect(x, cy, cw, chh)
    C.fillStyle = K(1)
    C.fillRect(x, cy + chh + 18, cw * (0.55 + rand() * 0.3), 10)
    C.fillStyle = K(0.45)
    C.fillRect(x, cy + chh + 38, cw * (0.7 + rand() * 0.25), 7)
    C.fillRect(x, cy + chh + 52, cw * (0.4 + rand() * 0.3), 7)
  }

  // copy block: a headline bar and body lines
  const ty = cy + chh + 100
  C.fillStyle = K(1)
  poster(C, 'SOFTWARE · WEB · SECURITY', L, ty + 30, 38)
  C.fillStyle = K(0.42)
  for (let i = 0; i < 5; i++) {
    const lw = i === 4 ? 0.46 : 0.9 + rand() * 0.1
    C.fillRect(L, ty + 56 + i * 20, (Wc * 0.62) * lw, 7)
  }
  S.fillStyle = K(0.55)
  S.fillRect(L + Wc * 0.68, ty + 50, Wc * 0.32, 96)
  C.fillStyle = K(1)
  C.fillRect(L + Wc * 0.68, ty + 50, 4, 96)

  // footer: black band, knocked-out type
  const fy = trim.y + trim.h - 110
  S.fillStyle = K(0.92)
  S.fillRect(trim.x, fy, trim.w, 110)
  S.globalCompositeOperation = 'destination-out'
  S.fillStyle = '#000'
  mark(S, L + 22, fy + 55, 40)
  poster(S, 'MAKE THE INTERNET LISTEN.', L + 58, fy + 68, 36)
  mono(S, 'MIKE@HARK.DIGITAL', R, fy + 62, 15, 'right')
  S.globalCompositeOperation = 'lighter'

  // hairline border of the "screen"
  C.strokeStyle = K(0.35)
  C.lineWidth = 1.5
  C.strokeRect(trim.x, trim.y, trim.w, trim.h)

  return { screen: scr.c, crisp: crs.c }
}

/** Rubber-stamp masks are drawn in white; the shader picks the ink. */
function stampCanvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  return { c, ctx }
}

/** worn-rubber voids: knock out specks and a few scuffs */
function wear(ctx: C2D, w: number, h: number, seed: number, amount = 1) {
  const r = rng(seed)
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  for (let i = 0; i < 260 * amount; i++) {
    const s = 0.6 + r() * r() * 5
    ctx.globalAlpha = 0.35 + r() * 0.65
    ctx.beginPath()
    ctx.arc(r() * w, r() * h, s, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 0.5
  for (let i = 0; i < 7 * amount; i++) {
    ctx.save()
    ctx.translate(r() * w, r() * h)
    ctx.rotate((r() - 0.5) * 0.6)
    ctx.fillRect(-w * 0.12 * r(), -1.5, w * 0.25 * r(), 3)
    ctx.restore()
  }
  ctx.restore()
}

export const BREACH_ASPECT = 2.4

/** Pink "BREACH" stamp (rectangular, double rule). */
export function drawBreachStamp() {
  const w = 720
  const h = Math.round(w / BREACH_ASPECT)
  const { c, ctx } = stampCanvas(w, h)
  ctx.lineWidth = 16
  rrect(ctx, 12, 12, w - 24, h - 24, 14)
  ctx.stroke()
  ctx.lineWidth = 4
  rrect(ctx, 34, 34, w - 68, h - 68, 6)
  ctx.stroke()
  mono(ctx, 'SECURITY INCIDENT', w / 2, 76, 26, 'center', 0.2)
  poster(ctx, 'BREACH', w / 2, h - 58, 150, 'center')
  wear(ctx, w, h, 5)
  return c
}

/** Green round seal: RESTORED across a band, the aftercare around the ring. */
export function drawSeal() {
  const s = 900
  const { c, ctx } = stampCanvas(s, s)
  const cx = s / 2
  const R = s / 2 - 14
  ctx.lineWidth = 22
  ctx.beginPath()
  ctx.arc(cx, cx, R - 11, 0, Math.PI * 2)
  ctx.stroke()
  ctx.lineWidth = 6
  ctx.beginPath()
  ctx.arc(cx, cx, R * 0.7, 0, Math.PI * 2)
  ctx.stroke()
  // ring text
  const ring = 'CLEANED · HARDENED · MONITORED · BACKED UP · '
  ctx.font = `500 44px ${MONO}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const rr = R * 0.85
  const chars = [...ring]
  const step = (Math.PI * 2) / chars.length
  chars.forEach((ch, i) => {
    const a = -Math.PI / 2 + i * step
    ctx.save()
    ctx.translate(cx + Math.cos(a) * rr, cx + Math.sin(a) * rr)
    ctx.rotate(a + Math.PI / 2)
    ctx.fillText(ch, 0, 0)
    ctx.restore()
  })
  // the word sits in a clear band that breaks the rings, between two rules
  const bw = s * 0.99
  const bh = 206
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.fillRect(cx - bw / 2, cx - bh / 2, bw, bh)
  ctx.restore()
  ctx.fillRect(cx - bw / 2, cx - bh / 2, bw, 14)
  ctx.fillRect(cx - bw / 2, cx + bh / 2 - 14, bw, 14)
  poster(ctx, 'RESTORED', cx, cx + 64, 178, 'center')
  poster(ctx, '24/7', cx, cx - 150, 96, 'center')
  mono(ctx, 'HARK.DIGITAL', cx, cx + 178, 34, 'center', 0.16)
  wear(ctx, s, s, 9, 1.4)
  return c
}

/**
 * The shredder's top plate: black body, pink hazard stripes along the feed
 * edge, knocked-out poster type. Returned as one screened canvas.
 */
export function drawHeadTop(wu: number, du: number) {
  const pxu = 300
  const w = Math.round(wu * pxu)
  const h = Math.round(du * pxu)
  const { c, ctx } = makeCanvas(w, h)
  ctx.fillStyle = K(0.86)
  ctx.fillRect(0, 0, w, h)
  // hazard stripes at the feed mouth (top edge = far side)
  const sh = h * 0.2
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, w, sh)
  ctx.clip()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, sh)
  ctx.globalCompositeOperation = 'lighter'
  for (let x = -sh * 2; x < w + sh; x += sh * 1.6) {
    ctx.fillStyle = P(1)
    ctx.beginPath()
    ctx.moveTo(x, sh)
    ctx.lineTo(x + sh * 0.8, 0)
    ctx.lineTo(x + sh * 1.6, 0)
    ctx.lineTo(x + sh * 0.8, sh)
    ctx.fill()
    ctx.fillStyle = K(0.86)
    ctx.beginPath()
    ctx.moveTo(x + sh * 0.8, sh)
    ctx.lineTo(x + sh * 1.6, 0)
    ctx.lineTo(x + sh * 2.4, 0)
    ctx.lineTo(x + sh * 1.6, sh)
    ctx.fill()
  }
  ctx.restore()
  // knocked-out type
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  poster(ctx, 'SHREDDER', h * 0.16, h * 0.86, h * 0.62)
  mono(ctx, 'STRIP-CUT · 24 BLADES', w - h * 0.62, h * 0.5, h * 0.1, 'right', 0.14)
  mono(ctx, 'ONE SHEET AT A TIME', w - h * 0.62, h * 0.66, h * 0.1, 'right', 0.14)
  // lamp bezel
  ctx.lineWidth = h * 0.035
  ctx.strokeStyle = '#000'
  ctx.beginPath()
  ctx.arc(w - h * 0.33, h * 0.58, h * 0.17, 0, Math.PI * 2)
  ctx.stroke()
  ctx.restore()
  return { canvas: c, lamp: { u: (w - h * 0.33) / w, v: 0.58 } }
}

/** The shredder's front: the exit mouth with a row of pink cutter teeth. */
export function drawHeadFront(wu: number, hu: number, blades: number) {
  const pxu = 300
  const w = Math.round(wu * pxu)
  const h = Math.round(hu * pxu)
  const { c, ctx } = makeCanvas(w, h)
  ctx.fillStyle = K(0.93)
  ctx.fillRect(0, 0, w, h)
  const my = h * 0.74
  const mh = h * 0.16
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  ctx.fillRect(w * 0.08, my, w * 0.84, mh)
  ctx.restore()
  // teeth
  ctx.fillStyle = P(1)
  const n = blades
  const tw = (w * 0.84) / n
  for (let i = 0; i < n; i++) {
    const x = w * 0.08 + i * tw
    ctx.beginPath()
    ctx.moveTo(x, my)
    ctx.lineTo(x + tw, my)
    ctx.lineTo(x + tw * 0.5, my + mh * 0.7)
    ctx.fill()
  }
  // vents
  ctx.save()
  ctx.globalCompositeOperation = 'destination-out'
  ctx.fillStyle = '#000'
  for (let i = 0; i < 9; i++) ctx.fillRect(w * 0.08 + i * h * 0.12, h * 0.24, h * 0.05, h * 0.3)
  ctx.restore()
  return c
}
