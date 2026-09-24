import * as THREE from 'three'
import { BRAND } from '../../content'
import { logoShapes } from '../../logo/logo'
import { rng } from '../../core/math'
import { setPrintFont, type Stretch } from '../../print/type'

/*
 * Canvas art for the airmail postcard. Everything is drawn as INK
 * DENSITIES (R = pink, G = green, B = black) with additive compositing on a
 * black ("no ink") ground, so overlapping inks overprint instead of
 * knocking each other out. Art is drawn in card units (300 × 200, the
 * card's 3 × 2 world units × 100) and scaled to the canvas.
 *
 *   sideA   message side, SCREENED layer: stripes, big type, stamp fill
 *   sideAc  message side, CRISP layer: rules, small type, perforations
 *   sideB   the outside of the dart (the picture side), screened
 *   postmark  the pink cancellation, placed over the stamp (POSTMARK_RECT)
 *   endStamp  "End of print run" rubber-stamp impression
 */

export const CARD_U = 300
export const CARD_V = 200
/** where the postmark canvas lands on the card, in card units (x, y, w, h; y down) */
export const POSTMARK_RECT = { x: 178, y: 12, w: 112, h: 62 }

const PINK = (d = 1) => `rgb(${Math.round(255 * d)},0,0)`
const GREEN = (d = 1) => `rgb(0,${Math.round(255 * d)},0)`
const BLACK = (d = 1) => `rgb(0,0,${Math.round(255 * d)})`

const SANS = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif'
const MONO = '"DM Mono", ui-monospace, monospace'

type Ctx = CanvasRenderingContext2D & { fontStretch?: string; letterSpacing?: string }

function canvas(w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d') as Ctx
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'lighter'
  return { c, ctx }
}

/**
 * Set a face. Returns the x-scale to draw it with: 1 wherever the browser
 * condenses for us, a measured squeeze where it cannot (Safari has no
 * canvas fontStretch), so condensed type keeps its width everywhere.
 */
function font(ctx: Ctx, weight: number, size: number, family: string, stretch: Stretch = 'normal') {
  const sx = setPrintFont(ctx, weight, size, stretch, family)
  // the helper's first (measuring) call restores ctx.font from its getter,
  // which drops the stretch keyword in Chrome; set it once more (a cache hit)
  if (stretch !== 'normal') setPrintFont(ctx, weight, size, stretch, family)
  return sx
}

/** fillText through a font() x-scale */
function fill(ctx: Ctx, text: string, x: number, y: number, sx: number) {
  if (sx === 1) {
    ctx.fillText(text, x, y)
    return
  }
  ctx.save()
  ctx.scale(sx, 1)
  ctx.fillText(text, x / sx, y)
  ctx.restore()
}

function spaced(ctx: Ctx, em: number) {
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${em}px`
}

/** the Hark mark as a canvas path (1 unit tall, centred, y down) */
function markPath(): Path2D {
  const p = new Path2D()
  for (const s of logoShapes()) {
    const pts = s.getPoints(40)
    pts.forEach((v, i) => (i ? p.lineTo(v.x, -v.y) : p.moveTo(v.x, -v.y)))
    p.closePath()
    for (const h of s.holes) {
      const hp = h.getPoints(40)
      hp.forEach((v, i) => (i ? p.lineTo(v.x, -v.y) : p.moveTo(v.x, -v.y)))
      p.closePath()
    }
  }
  return p
}

/** airmail border: diagonal pink / green bands, clipped to a frame */
function airmailBorder(ctx: Ctx, inset: number, band: number, d = 1) {
  ctx.save()
  ctx.beginPath()
  ctx.rect(inset, inset, CARD_U - inset * 2, CARD_V - inset * 2)
  ctx.rect(inset + band, inset + band, CARD_U - (inset + band) * 2, CARD_V - (inset + band) * 2)
  ctx.clip('evenodd')
  const period = 17
  const w = 6.2
  for (let i = -20, k = 0; i < CARD_U + CARD_V; i += period / 2, k++) {
    ctx.fillStyle = k % 2 ? GREEN(0.92 * d) : PINK(0.92 * d)
    ctx.beginPath()
    ctx.moveTo(i, -2)
    ctx.lineTo(i + w, -2)
    ctx.lineTo(i + w - CARD_V - 4, CARD_V + 2)
    ctx.lineTo(i - CARD_V - 4, CARD_V + 2)
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
}

/** a perforated stamp outline (scalloped edge) */
function perforated(x: number, y: number, w: number, h: number, r: number) {
  const p = new Path2D()
  const nx = Math.max(3, Math.round(w / (r * 3.2)))
  const ny = Math.max(3, Math.round(h / (r * 3.2)))
  const sx = w / nx
  const sy = h / ny
  p.moveTo(x, y)
  for (let i = 0; i < nx; i++) {
    const cx = x + sx * (i + 0.5)
    p.lineTo(cx - r, y)
    p.arc(cx, y, r, Math.PI, 0, true)
  }
  p.lineTo(x + w, y)
  for (let i = 0; i < ny; i++) {
    const cy = y + sy * (i + 0.5)
    p.lineTo(x + w, cy - r)
    p.arc(x + w, cy, r, -Math.PI / 2, Math.PI / 2, true)
  }
  p.lineTo(x + w, y + h)
  for (let i = nx - 1; i >= 0; i--) {
    const cx = x + sx * (i + 0.5)
    p.lineTo(cx + r, y + h)
    p.arc(cx, y + h, r, 0, Math.PI, true)
  }
  p.lineTo(x, y + h)
  for (let i = ny - 1; i >= 0; i--) {
    const cy = y + sy * (i + 0.5)
    p.lineTo(x, cy + r)
    p.arc(x, cy, r, Math.PI / 2, -Math.PI / 2, true)
  }
  p.closePath()
  return p
}

/** typewriter: each glyph with a hair of baseline jitter and uneven ink */
function typed(ctx: Ctx, text: string, x: number, y: number, size: number, rand: () => number, d = 1) {
  font(ctx, 500, size, MONO)
  spaced(ctx, 0)
  const adv = size * 0.6
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === ' ') continue
    ctx.fillStyle = BLACK(d * (0.78 + rand() * 0.22))
    ctx.fillText(ch, x + i * adv + (rand() - 0.5) * size * 0.04, y + (rand() - 0.5) * size * 0.07)
  }
  return text.length * adv
}

/** fit a string to a width by font size */
function fitSize(ctx: Ctx, text: string, weight: number, family: string, stretch: Stretch, maxW: number, maxSize: number) {
  const sx = font(ctx, weight, 100, family, stretch)
  const w = ctx.measureText(text).width * sx || 1
  return Math.min(maxSize, (100 * maxW) / w)
}

export interface CardArt {
  sideA: THREE.CanvasTexture
  sideAc: THREE.CanvasTexture
  sideB: THREE.CanvasTexture
  postmark: THREE.CanvasTexture
  endStamp: THREE.CanvasTexture
  endAspect: number
}

function tex(c: HTMLCanvasElement, aniso: number) {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.NoColorSpace
  t.anisotropy = aniso
  t.generateMipmaps = true
  t.minFilter = THREE.LinearMipmapLinearFilter
  return t
}

export async function loadCardFonts() {
  if (!document.fonts?.load) return
  await Promise.all([
    document.fonts.load(`800 100px ${SANS}`),
    document.fonts.load(`700 100px ${SANS}`),
    document.fonts.load(`500 40px ${MONO}`),
    document.fonts.load(`400 40px ${MONO}`),
  ]).catch(() => {})
}

export function drawCardArt(mobile: boolean, aniso: number): CardArt {
  const W = mobile ? 1500 : 2100
  const H = Math.round((W * CARD_V) / CARD_U)
  const k = W / CARD_U
  const rand = rng(2026)

  // ---------------------------------------------------------------- side A, screened
  const A = canvas(W, H)
  const a = A.ctx
  a.scale(k, k)
  airmailBorder(a, 0, 8.5)

  // big greeting: SAY / HELLO. (pink ghost a hair off the black; HELLO. in green)
  const msgX = 18
  const msgW = 124
  const hello = 'HELLO.'
  const size = fitSize(a, hello, 800, SANS, 'condensed', msgW, 60)
  const helloX = font(a, 800, size, SANS, 'condensed')
  spaced(a, -size * 0.02)
  a.textBaseline = 'alphabetic'
  const l1 = 30 + size * 0.74
  const l2 = l1 + size * 0.84
  const ghost = size * 0.035
  a.fillStyle = PINK(0.85)
  fill(a, 'SAY', msgX + ghost, l1 + ghost * 0.6, helloX)
  a.fillStyle = BLACK(0.92)
  fill(a, hello, msgX + ghost, l2 + ghost * 0.6, helloX)
  // the top drum knocks out the ghost beneath it, like the DOM headline
  a.globalCompositeOperation = 'source-over'
  a.fillStyle = BLACK(1)
  fill(a, 'SAY', msgX, l1, helloX)
  a.fillStyle = GREEN(1)
  fill(a, hello, msgX, l2, helloX)
  a.globalCompositeOperation = 'lighter'

  // the stamp: green field with the mark knocked out, a hard ink shadow behind
  const st = { x: 244, y: 17, w: 38, h: 46 }
  const perf = perforated(st.x, st.y, st.w, st.h, 1.25)
  a.save()
  a.translate(2.2, 2.2)
  a.fillStyle = BLACK(0.34)
  a.fill(perf)
  a.restore()
  a.save()
  const inner = new Path2D()
  inner.rect(st.x + 3, st.y + 3, st.w - 6, st.h - 6)
  const mk = markPath()
  const mark = new Path2D()
  const ms = 20
  mark.addPath(mk, new DOMMatrix().translate(st.x + st.w / 2, st.y + st.h / 2 - 3).scale(ms, ms))
  inner.addPath(mark)
  a.fillStyle = GREEN(0.95)
  a.fill(inner, 'evenodd')
  a.restore()

  // airmail label (the classic blue sticker, in green here)
  a.fillStyle = GREEN(0.9)
  a.fillRect(160, 20, 62, 17)

  // ---------------------------------------------------------------- side A, crisp
  const C = canvas(W, H)
  const c = C.ctx
  c.scale(k, k)
  // stamp perforation outline + stamp slugs
  c.strokeStyle = BLACK(0.9)
  c.lineWidth = 0.45
  c.stroke(perf)
  font(c, 500, 4.4, MONO)
  spaced(c, 0.35)
  c.fillStyle = BLACK(1)
  c.textAlign = 'center'
  c.fillText('HARK · 2026', st.x + st.w / 2, st.y + st.h - 5.4)
  c.textAlign = 'left'

  // label text
  font(c, 500, 4.6, MONO)
  spaced(c, 0.5)
  c.fillStyle = BLACK(1)
  c.fillText('BY AIR MAIL', 164, 27.4)
  font(c, 400, 4.2, MONO)
  c.fillText('PAR AVION', 164, 33.6)

  // divider + header
  c.fillStyle = BLACK(0.85)
  c.fillRect(151, 46, 0.5, 136)
  font(c, 500, 4.4, MONO)
  spaced(c, 1.1)
  c.fillText('POST CARD', 18, 22)
  c.textAlign = 'right'
  c.fillText('No. 07 / 07', 142, 22)
  c.textAlign = 'left'

  // message rules with a typed first line
  const rulesY = [138, 152, 166]
  c.fillStyle = BLACK(0.5)
  for (const y of rulesY) {
    for (let x = 18; x < 142; x += 2.4) c.fillRect(x, y, 1.2, 0.35)
  }
  typed(c, 'Tell us what you are building,', 19, rulesY[0] - 2.2, 6.2, rand, 0.95)
  typed(c, 'fixing, or dreaming up.', 19, rulesY[1] - 2.2, 6.2, rand, 0.95)
  font(c, 500, 4.4, MONO)
  spaced(c, 0.9)
  c.fillStyle = BLACK(0.95)
  c.fillText(BRAND.tagline.toUpperCase(), 18, 181)

  // address block: "To" + ruled lines + the typed address
  const ax = 160
  const aw = 124
  const lines = [112, 132, 150, 168]
  font(c, 500, 4.4, MONO)
  spaced(c, 1.1)
  c.fillStyle = BLACK(1)
  c.fillText('TO', ax, 96)
  c.fillStyle = BLACK(0.8)
  for (const y of lines) c.fillRect(ax, y, aw, 0.45)
  // the address itself, largest on line 1
  const emailSize = Math.min(10.5, aw / (BRAND.email.length * 0.6))
  typed(c, BRAND.email, ax + 0.5, lines[0] - 2.4, emailSize, rand, 1)
  typed(c, BRAND.name, ax + 0.5, lines[1] - 2.2, 6.6, rand, 0.95)
  const [city, world, est] = BRAND.locale.split(' · ')
  typed(c, `${city} · ${world}`, ax + 0.5, lines[2] - 2.2, 6.6, rand, 0.95)
  typed(c, est ?? '', ax + 0.5, lines[3] - 2.2, 6.6, rand, 0.95)

  // registration marks + crop ticks in the stripe corners (print-shop slugs)
  const reg = (x: number, y: number, r: number) => {
    c.beginPath()
    c.arc(x, y, r, 0, Math.PI * 2)
    c.moveTo(x - r * 1.6, y)
    c.lineTo(x + r * 1.6, y)
    c.moveTo(x, y - r * 1.6)
    c.lineTo(x, y + r * 1.6)
    c.lineWidth = 0.4
    c.strokeStyle = BLACK(0.9)
    c.stroke()
  }
  reg(146, 22 - 1.5, 1.8)

  // ---------------------------------------------------------------- side B (outside of the dart)
  const BW = mobile ? 900 : 1200
  const BH = Math.round((BW * CARD_V) / CARD_U)
  const B = canvas(BW, BH)
  const b = B.ctx
  b.scale(BW / CARD_U, BW / CARD_U)
  airmailBorder(b, 0, 8.5)
  // big "PAR AVION" set across, pink, with the mark in green
  const pa = 'PAR AVION'
  const ps = fitSize(b, pa, 800, SANS, 'condensed', 250, 80)
  const paX = font(b, 800, ps, SANS, 'condensed')
  spaced(b, -ps * 0.02)
  b.fillStyle = PINK(0.9)
  b.textAlign = 'center'
  fill(b, pa, CARD_U / 2, CARD_V / 2 + ps * 0.34, paX)
  b.save()
  b.fillStyle = GREEN(0.85)
  b.translate(CARD_U / 2, CARD_V / 2 - 2)
  b.scale(118, 118)
  b.fill(markPath(), 'evenodd')
  b.restore()
  font(b, 500, 6, MONO)
  spaced(b, 2)
  b.fillStyle = BLACK(0.95)
  b.fillText('HARK · PRESS · AIRMAIL', CARD_U / 2, 30)
  b.fillText(BRAND.locale.toUpperCase(), CARD_U / 2, CARD_V - 24)

  // ---------------------------------------------------------------- postmark (pink)
  const PK = mobile ? 5 : 6
  const P = canvas(Math.round(POSTMARK_RECT.w * PK), Math.round(POSTMARK_RECT.h * PK))
  const p = P.ctx
  p.scale(PK, PK)
  p.strokeStyle = PINK(1)
  p.fillStyle = PINK(1)
  const cx = 30
  const cy = POSTMARK_RECT.h / 2
  const R = 22
  p.lineWidth = 1.5
  p.beginPath()
  p.arc(cx, cy, R, 0, Math.PI * 2)
  p.stroke()
  p.lineWidth = 0.8
  p.beginPath()
  p.arc(cx, cy, R - 8.4, 0, Math.PI * 2)
  p.stroke()
  // ring text
  const ring = 'PHILADELPHIA · 2026 · PHILADELPHIA · 2026 · '
  font(p, 500, 5.2, MONO)
  spaced(p, 0)
  p.textAlign = 'center'
  p.textBaseline = 'middle'
  const rr = R - 4.3
  const n = ring.length
  for (let i = 0; i < n; i++) {
    const t = -Math.PI / 2 + (i / n) * Math.PI * 2
    p.save()
    p.translate(cx + Math.cos(t) * rr, cy + Math.sin(t) * rr)
    p.rotate(t + Math.PI / 2)
    p.fillText(ring[i], 0, 0)
    p.restore()
  }
  // centre: a registration mark and the run
  fill(p, 'HARK', cx, cy - 3.2, font(p, 800, 7.4, SANS, 'condensed'))
  font(p, 500, 4, MONO)
  p.fillText('07·07', cx, cy + 4.2)
  // wavy cancellation lines across the stamp
  p.lineWidth = 1.35
  for (let j = 0; j < 6; j++) {
    const y = 9 + j * 8.8
    p.beginPath()
    for (let x = cx + R + 3; x <= POSTMARK_RECT.w - 1; x += 0.8) {
      const yy = y + Math.sin((x - cx) * 0.24 + j * 0.3) * 2.2
      if (x === cx + R + 3) p.moveTo(x, yy)
      else p.lineTo(x, yy)
    }
    p.stroke()
  }

  // ---------------------------------------------------------------- end-of-run stamp (pink)
  const EW = mobile ? 720 : 960
  const EH = Math.round(EW * 0.34)
  const E = canvas(EW, EH)
  const e = E.ctx
  const ek = EW / 300
  e.scale(ek, ek)
  const eh = EH / ek
  e.strokeStyle = PINK(1)
  e.fillStyle = PINK(1)
  e.lineWidth = 4
  e.strokeRect(4, 4, 292, eh - 8)
  e.lineWidth = 1.4
  e.strokeRect(11, 11, 278, eh - 22)
  const endTxt = 'END OF PRINT RUN'
  const es = fitSize(e, endTxt, 800, SANS, 'condensed', 250, 60)
  const endX = font(e, 800, es, SANS, 'condensed')
  spaced(e, es * 0.01)
  e.textAlign = 'center'
  e.textBaseline = 'alphabetic'
  fill(e, endTxt, 150, eh * 0.5 + es * 0.3, endX)
  font(e, 500, 8.5, MONO)
  spaced(e, 3)
  e.fillText('RUN 07 / 07  ·  HARK PRESS  ·  2026', 150, eh - 19)

  return {
    sideA: tex(A.c, aniso),
    sideAc: tex(C.c, aniso),
    sideB: tex(B.c, aniso),
    postmark: tex(P.c, aniso),
    endStamp: tex(E.c, aniso),
    endAspect: EW / EH,
  }
}
