import { BRAND, type WorkItem } from '../../content'
import { MARK_SVG } from '../../logo/svgSource'
import { rng } from '../../core/math'
import { setPrintFont } from '../../print/type'

/*
 * PASTE-UP print design, drawn on 2D canvas as INK DENSITIES (see
 * src/print/ink.ts): R = pink, G = green, B = black, 0 = bare paper.
 *
 *   'lighter'  adds ink (a second drum overprints the first)
 *   'multiply' with rgb(0,0,0) knocks every drum back to paper
 *
 * Every poster is an untrimmed PROOF: the design sits inside a trim box with
 * crop marks, registration targets, a colour bar and a job slug in the
 * margin, so the wall reads as a print shop's run pasted straight up.
 * Screenshots are NOT drawn into the featured posters: the poster shader
 * samples them separately and overprints them through a 3-ink separation,
 * so type can overprint the image like a real riso pass.
 */

export const FONT = '"Bricolage Grotesque Variable", "Bricolage Grotesque", system-ui, sans-serif'
export const MONO = '"DM Mono", ui-monospace, monospace'

type G = CanvasRenderingContext2D
type Ink3 = [number, number, number]

const P: Ink3 = [1, 0, 0]
const GR: Ink3 = [0, 1, 0]
const K: Ink3 = [0, 0, 1]

export const ink = (p = 0, g = 0, k = 0) =>
  `rgb(${Math.round(Math.min(1, p) * 255)},${Math.round(Math.min(1, g) * 255)},${Math.round(Math.min(1, k) * 255)})`
const inkOf = (c: Ink3, a = 1) => ink(c[0] * a, c[1] * a, c[2] * a)
const clampN = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))

let fontsPromise: Promise<void> | null = null
/** The faces the canvases set (fetched by CSS already; this waits for them). */
export function loadFonts(): Promise<void> {
  if (fontsPromise) return fontsPromise
  const fonts = document.fonts
  if (!fonts?.load) return (fontsPromise = Promise.resolve())
  const faces = [`800 60px ${FONT}`, `600 60px ${FONT}`, `500 20px ${MONO}`, `400 20px ${MONO}`]
  const all = Promise.all(faces.map(f => fonts.load(f, 'HARK Built 0123 ↗→').catch(() => []))).then(() => undefined)
  fontsPromise = Promise.race([all, new Promise<void>(r => setTimeout(r, 4000))])
  return fontsPromise
}

// ------------------------------------------------------------------ type

/**
 * Tracking (px) that text() applies by hand where the canvas has no
 * letterSpacing (Safari). Set by mono()/display()/track() before drawing.
 */
let handTrack = 0
function track(g: G, px: number, byHand: boolean) {
  const any = g as G & { letterSpacing?: string }
  if ('letterSpacing' in g) {
    any.letterSpacing = `${px.toFixed(1)}px`
    handTrack = 0
  } else handTrack = byHand ? px : 0
}

/**
 * Set the poster face: Bricolage 800, condensed (wdth 75), through the shared
 * setPrintFont. Returns the x-scale that fakes the condensing where the
 * canvas can't select width (every Safari); 1 where the browser condensed it.
 * text() applies it around fillText and width() multiplies measures by it.
 * The display type's tight tracking is dropped where canvas can't track
 * (setting it glyph by glyph would lose the kerning).
 */
export function display(g: G, size: number, weight = 800): number {
  track(g, -0.02 * size, false)
  return setPrintFont(g, weight, size, 'condensed')
}

function mono(g: G, size: number, weight = 500, trk = 0.08) {
  g.font = `${weight} ${size}px ${MONO}`
  const any = g as G & { fontStretch?: string }
  if ('fontStretch' in g) any.fontStretch = 'normal'
  track(g, trk * size, true)
}

function text(g: G, s: string, x: number, y: number, sx = 1, align: CanvasTextAlign = 'left') {
  g.save()
  g.translate(x, y)
  g.scale(sx, 1)
  const chars = handTrack ? [...s] : null
  if (chars && chars.length > 1) {
    // letter-space by hand: one glyph at a time, aligned as a whole
    const adv = chars.map(c => g.measureText(c).width)
    const total = adv.reduce((a, b) => a + b, 0) + handTrack * (chars.length - 1)
    let cx = align === 'right' || align === 'end' ? -total : align === 'center' ? -total / 2 : 0
    g.textAlign = 'left'
    for (let i = 0; i < chars.length; i++) {
      g.fillText(chars[i], cx, 0)
      cx += adv[i] + handTrack
    }
  } else {
    g.textAlign = align
    g.fillText(s, 0, 0)
  }
  g.restore()
}

const width = (g: G, s: string, sx = 1) =>
  (g.measureText(s).width + (handTrack ? handTrack * Math.max(0, [...s].length - 1) : 0)) * sx

/** Largest size at which `words` wrap into ≤ maxLines lines no wider than maxW (and ≤ maxH tall). */
function fit(g: G, words: string[], maxW: number, maxH: number, maxLines: number, maxSize: number, lead = 0.86) {
  for (let size = maxSize; size > 18; size -= 3) {
    const sx = display(g, size)
    const lines: string[] = []
    let cur = ''
    let ok = true
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w
      if (width(g, t, sx) <= maxW) cur = t
      else {
        if (!cur) {
          ok = false
          break
        }
        lines.push(cur)
        cur = w
        if (width(g, w, sx) > maxW) {
          ok = false
          break
        }
      }
    }
    if (cur) lines.push(cur)
    if (ok && lines.length <= maxLines && lines.length * size * lead <= maxH) return { size, lines, sx }
  }
  const sx = display(g, 18)
  return { size: 18, lines: [words.join(' ')], sx }
}

// ------------------------------------------------------------------ marks

function cropMarks(g: G, w: number, h: number, t: number, len: number, lw = 2) {
  g.strokeStyle = inkOf(K)
  g.lineWidth = lw
  g.beginPath()
  for (const [x, y, sx, sy] of [
    [t, t, -1, -1],
    [w - t, t, 1, -1],
    [t, h - t, -1, 1],
    [w - t, h - t, 1, 1],
  ]) {
    g.moveTo(x, y + sy * 4)
    g.lineTo(x, y + sy * (4 + len))
    g.moveTo(x + sx * 4, y)
    g.lineTo(x + sx * (4 + len), y)
  }
  g.stroke()
}

function regMark(g: G, x: number, y: number, r: number, lw = 1.6, c: Ink3 = K) {
  g.strokeStyle = inkOf(c)
  g.lineWidth = lw
  g.beginPath()
  g.arc(x, y, r, 0, Math.PI * 2)
  g.moveTo(x - r * 1.5, y)
  g.lineTo(x + r * 1.5, y)
  g.moveTo(x, y - r * 1.5)
  g.lineTo(x, y + r * 1.5)
  g.stroke()
  g.beginPath()
  g.arc(x, y, r * 0.45, 0, Math.PI * 2)
  g.fillStyle = inkOf(c)
  g.fill()
}

/** Colour bar: each drum at 100 / 60 / 30 %. */
function colourBar(g: G, x: number, y: number, s: number) {
  const inks: Ink3[] = [P, GR, K]
  let cx = x
  g.globalCompositeOperation = 'source-over'
  for (const c of inks) {
    for (const a of [1, 0.6, 0.3]) {
      g.fillStyle = inkOf(c, a)
      g.fillRect(cx, y, s, s)
      cx += s
    }
    cx += s * 0.35
  }
  g.strokeStyle = inkOf(K)
  g.lineWidth = 1
  g.strokeRect(x - 0.5, y - 0.5, cx - x - s * 0.35 + 1, s + 1)
}

/** Printer's margin furniture around a trim box of inset t. */
function proofMargin(g: G, w: number, h: number, t: number, slug: string, scale: number) {
  cropMarks(g, w, h, t, t * 0.55, Math.max(1.2, 2 * scale))
  regMark(g, w / 2, t * 0.5, t * 0.22, Math.max(1, 1.4 * scale))
  regMark(g, w / 2, h - t * 0.5, t * 0.22, Math.max(1, 1.4 * scale))
  regMark(g, t * 0.5, h / 2, t * 0.22, Math.max(1, 1.4 * scale))
  regMark(g, w - t * 0.5, h / 2, t * 0.22, Math.max(1, 1.4 * scale))
  g.fillStyle = inkOf(K)
  mono(g, Math.round(t * 0.3), 500, 0.1)
  text(g, slug, t, h - t * 0.36)
  colourBar(g, w - t - t * 3.4, t * 0.3, t * 0.36)
}

/** Draw the Hark mark (from the SVG source) centred at x,y, `size` px tall. */
let markPaths: { paths: Path2D[]; rect: [number, number, number, number, number, number] } | null = null
function drawMark(g: G, x: number, y: number, size: number) {
  if (!markPaths) {
    const ds = [...MARK_SVG.matchAll(/<path d="([^"]+)"/g)].map(m => m[1]).filter(d => d.length > 200)
    markPaths = { paths: ds.map(d => new Path2D(d)), rect: [842.2, 843.6, 208.4, 199.3, 946.4, 943.2] }
  }
  const s = size / 1889.9
  g.save()
  g.translate(x - 944.8 * s, y - 944.95 * s)
  g.scale(s, s)
  for (const p of markPaths.paths) g.fill(p)
  const [rx, ry, rw, rh, cx, cy] = markPaths.rect
  g.translate(cx, cy)
  g.rotate(-Math.PI / 4)
  g.fillRect(rx - cx, ry - cy, rw, rh)
  g.restore()
}

function halftoneRamp(g: G, x: number, y: number, w: number, h: number, c: Ink3, a0: number, a1: number, steps = 24) {
  for (let i = 0; i < steps; i++) {
    const a = a0 + (a1 - a0) * (i / (steps - 1))
    g.fillStyle = inkOf(c, a)
    g.fillRect(x + (w * i) / steps, y, w / steps + 1, h)
  }
}

// ------------------------------------------------------------------ featured posters

/** Poster canvas size (px) — A-series proportion. */
export const POSTER = { w: 768, h: 1086 }

export interface PosterSpec {
  k: number
  item: WorkItem
}

export interface PosterArt {
  /** where the shader prints the screenshot, in poster uv (0..1, y up) */
  shot: [x0: number, y0: number, x1: number, y1: number]
  /** mono print of the shot: ink rgb + mix (0 = full 3-ink separation) */
  mono: [number, number, number, number]
}

const host = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '')
const pad = (n: number, l = 3) => String(n).padStart(l, '0')

/**
 * Six house schemes, one per featured job. ground: the flood inside the trim;
 * type: the name's drum; accent: the last word's overprint.
 */
const SCHEMES: { ground: Ink3; ga: number; type: Ink3; accent: Ink3; mono: PosterArt['mono']; knock: boolean }[] = [
  { ground: [0, 0, 0], ga: 0, type: K, accent: P, mono: [0, 0, 0, 0], knock: false },
  { ground: P, ga: 0.86, type: K, accent: K, mono: [0, 0, 1, 1], knock: false },
  { ground: GR, ga: 0.9, type: K, accent: P, mono: [0, 0, 0, 0], knock: true },
  { ground: K, ga: 0.92, type: [0, 0, 0], accent: GR, mono: [0, 0, 0, 0], knock: true },
  { ground: P, ga: 0.8, type: K, accent: K, mono: [0, 0, 0, 0], knock: true },
  { ground: [0, 0, 0], ga: 0, type: GR, accent: K, mono: [1, 0, 0.35, 0.85], knock: false },
]

/** Draw a featured job poster. Returns where the screenshot prints. */
export function drawPoster(c: HTMLCanvasElement, spec: PosterSpec): PosterArt {
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  const u = w / 768
  const S = SCHEMES[spec.k % SCHEMES.length]
  const it = spec.item
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink()
  g.fillRect(0, 0, w, h)
  const T = Math.round(34 * u)
  const pad0 = Math.round(26 * u)
  const x0 = T + pad0
  const x1 = w - T - pad0
  const iw = x1 - x0

  // the flood
  if (S.ga > 0) {
    g.fillStyle = inkOf(S.ground, S.ga)
    g.fillRect(T, T, w - 2 * T, h - 2 * T)
  }
  if (spec.k === 4) {
    // split fountain: pink top, green bottom, overprinting in a band
    g.fillStyle = ink()
    g.fillRect(T, T, w - 2 * T, h - 2 * T)
    g.fillStyle = inkOf(P, 0.82)
    g.fillRect(T, T, w - 2 * T, (h - 2 * T) * 0.62)
    g.globalCompositeOperation = 'lighter'
    g.fillStyle = inkOf(GR, 0.85)
    g.fillRect(T, T + (h - 2 * T) * 0.5, w - 2 * T, (h - 2 * T) * 0.5)
    g.globalCompositeOperation = 'source-over'
  }
  const onDark = spec.k === 3
  const typeInk: Ink3 = onDark ? K : S.type
  const fg = (a = 1) => inkOf(onDark ? [0, 0, 0] : K, a)

  // top slug
  let y = T + pad0 + Math.round(16 * u)
  const slugC = onDark ? ink(0, 0, 0) : ink(0, 0, 1)
  g.fillStyle = slugC
  mono(g, Math.round(15 * u), 500, 0.1)
  if (onDark) g.globalCompositeOperation = 'multiply'
  text(g, `JOB ${pad(spec.k + 1)}`, x0, y)
  text(g, it.industry.toUpperCase(), x1, y, 1, 'right')
  y += Math.round(14 * u)
  g.fillRect(x0, y, iw, Math.max(2, Math.round(3 * u)))
  g.globalCompositeOperation = 'source-over'
  y += Math.round(18 * u)

  // the name, set big
  const words = it.name.toUpperCase().split(' ')
  const f = fit(g, words, iw, 330 * u, 3, Math.round(200 * u))
  const lead = f.size * 0.86
  const nameTop = y
  for (let i = 0; i < f.lines.length; i++) {
    const last = i === f.lines.length - 1 && f.lines.length > 1
    const ly = y + lead * (i + 1) - f.size * 0.1
    display(g, f.size)
    if (onDark) {
      // knocked out of the black, accent line overprinted in green
      g.globalCompositeOperation = 'multiply'
      g.fillStyle = ink(0, 0, 0)
      text(g, f.lines[i], x0 - 2 * u, ly, f.sx)
      if (last) {
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = inkOf(S.accent, 0.95)
        text(g, f.lines[i], x0 - 2 * u, ly, f.sx)
      }
    } else {
      g.globalCompositeOperation = 'lighter'
      // misregistered ghost from the second drum
      if (spec.k === 0 || spec.k === 5) {
        g.fillStyle = inkOf(P, 0.9)
        text(g, f.lines[i], x0 - 2 * u + 5 * u, ly + 4 * u, f.sx)
      }
      if (!(last && spec.k === 0)) {
        // CLC's last word prints pink only (the ghost IS the word); the
        // rest knock out whatever is under the glyph so the drum prints clean
        g.globalCompositeOperation = 'multiply'
        g.fillStyle = ink(0, 0, 0)
        text(g, f.lines[i], x0 - 2 * u, ly, f.sx)
        g.globalCompositeOperation = 'lighter'
        g.fillStyle = inkOf(last ? S.accent : typeInk, 1)
        text(g, f.lines[i], x0 - 2 * u, ly, f.sx)
      }
      g.globalCompositeOperation = 'source-over'
    }
  }
  g.globalCompositeOperation = 'source-over'
  y = nameTop + lead * f.lines.length + Math.round(26 * u)

  // screenshot window
  const sw = iw
  const sh = Math.round(sw * 0.625)
  const sy = Math.min(y, h - T - pad0 - sh - Math.round(150 * u))
  if (S.knock) {
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = ink(0, 0, 0)
    g.fillRect(x0, sy, sw, sh)
    g.globalCompositeOperation = 'source-over'
  }
  // misregistered block behind the image (second drum)
  g.globalCompositeOperation = 'lighter'
  if (spec.k === 0) {
    g.fillStyle = inkOf(GR, 0.9)
    g.beginPath()
    g.arc(x1 - sw * 0.12, sy + sh * 0.92, sw * 0.2, 0, Math.PI * 2)
    g.fill()
  } else if (spec.k === 2) {
    g.fillStyle = inkOf(P, 0.95)
    g.fillRect(x0 + 12 * u, sy + 12 * u, sw, sh)
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = ink(0, 0, 0)
    g.fillRect(x0, sy, sw, sh)
  } else if (spec.k === 5) {
    // sound rings
    g.strokeStyle = inkOf(GR, 0.8)
    g.lineWidth = 9 * u
    for (let r = 1; r < 6; r++) {
      g.beginPath()
      g.arc(x0 + sw * 0.08, sy + sh * 0.5, r * 42 * u, -Math.PI / 2, Math.PI / 2)
      g.stroke()
    }
  }
  g.globalCompositeOperation = 'source-over'
  g.strokeStyle = onDark ? ink(0, 0, 0) : ink(0, 0, 1)
  g.lineWidth = Math.max(1.5, 2.5 * u)
  if (onDark) g.globalCompositeOperation = 'multiply'
  g.strokeRect(x0, sy, sw, sh)
  g.globalCompositeOperation = 'source-over'

  // below the image: tags, big job number, house line
  let by = sy + sh + Math.round(34 * u)
  mono(g, Math.round(14 * u), 500, 0.08)
  let tx = x0
  for (const tag of it.tags) {
    const tw = width(g, tag.toUpperCase()) + 18 * u
    g.lineWidth = Math.max(1.2, 2 * u)
    g.strokeStyle = slugC
    if (onDark) g.globalCompositeOperation = 'multiply'
    g.strokeRect(tx, by - 17 * u, tw, 26 * u)
    g.fillStyle = slugC
    text(g, tag.toUpperCase(), tx + 9 * u, by + 1 * u)
    g.globalCompositeOperation = 'source-over'
    tx += tw + 8 * u
  }
  by += Math.round(24 * u)
  // job number, huge and cropped by the trim
  const nsx = display(g, Math.round(190 * u))
  g.globalCompositeOperation = onDark ? 'lighter' : 'lighter'
  g.fillStyle = onDark ? inkOf(P, 0.95) : inkOf(spec.k === 1 || spec.k === 4 ? K : GR, spec.k === 5 ? 0.9 : 1)
  if (spec.k === 5) g.fillStyle = inkOf(P, 0.9)
  if (spec.k === 2) g.fillStyle = inkOf(P, 0.95)
  g.save()
  g.beginPath()
  g.rect(T, T, w - 2 * T, h - 2 * T)
  g.clip()
  text(g, pad(spec.k + 1), x1 + 8 * u, h - T + 30 * u, nsx, 'right')
  g.restore()
  g.globalCompositeOperation = 'source-over'
  mono(g, Math.round(14 * u), 500, 0.1)
  g.fillStyle = slugC
  if (onDark) g.globalCompositeOperation = 'multiply'
  text(g, host(it.url).toUpperCase(), x0, by + 8 * u)
  text(g, 'HARK.DIGITAL', x0, by + 30 * u)
  g.globalCompositeOperation = 'source-over'
  if (onDark) {
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = ink(0, 0, 0)
  } else g.fillStyle = fg()
  drawMark(g, x0 + 22 * u, h - T - pad0 - 26 * u, 46 * u)
  g.globalCompositeOperation = 'source-over'

  proofMargin(g, w, h, T, `HARK PRESS · JOB ${pad(spec.k + 1)} · ${it.name.toUpperCase()} · 3-INK RISO`, u)

  return {
    shot: [x0 / w, 1 - (sy + sh) / h, (x0 + sw) / w, 1 - sy / h],
    mono: S.mono,
  }
}

// ------------------------------------------------------------------ intro poster

export const INTRO = { w: 1024, h: 1448 }

/** "BUILT / TO BE / HEARD." — the type-only opener. */
export function drawIntro(c: HTMLCanvasElement, featured: number, more: number) {
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  const u = w / 1024
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink()
  g.fillRect(0, 0, w, h)
  const T = Math.round(44 * u)
  const x0 = T + 34 * u
  const x1 = w - T - 34 * u
  const iw = x1 - x0

  // sound rings behind the last word (pink, screened)
  g.globalCompositeOperation = 'lighter'
  g.strokeStyle = inkOf(P, 0.55)
  g.lineWidth = 16 * u
  for (let r = 1; r < 9; r++) {
    g.beginPath()
    g.arc(x1 - 40 * u, h * 0.73, r * 62 * u, 0, Math.PI * 2)
    g.stroke()
  }
  g.globalCompositeOperation = 'source-over'
  // re-paper the margin (the rings bleed only inside the trim)
  g.fillStyle = ink()
  g.fillRect(0, 0, w, T)
  g.fillRect(0, h - T, w, T)
  g.fillRect(0, 0, T, h)
  g.fillRect(w - T, 0, T, h)

  // slug
  let y = T + 44 * u
  g.fillStyle = ink(0, 0, 1)
  mono(g, Math.round(19 * u), 500, 0.1)
  text(g, 'SELECTED WORK', x0, y)
  text(g, `${pad(featured, 2)} FEATURED + ${pad(more, 2)} MORE`, x1, y, 1, 'right')
  y += 18 * u
  g.fillRect(x0, y, iw, 4 * u)
  y += 26 * u

  const lines = ['BUILT', 'TO BE', 'HEARD.']
  // one size for all three lines: the widest sets it
  let size = 420 * u
  let sx = display(g, size)
  const widest = Math.max(...lines.map(l => width(g, l, sx)))
  size = Math.floor((size * iw) / widest)
  sx = display(g, size)
  const lead = size * 0.84
  for (let i = 0; i < lines.length; i++) {
    const ly = y + lead * (i + 1) - size * 0.08
    const last = i === lines.length - 1
    g.globalCompositeOperation = 'lighter'
    if (last) {
      g.fillStyle = inkOf(P, 0.95)
      text(g, lines[i], x0 + 9 * u, ly + 7 * u, sx)
      g.globalCompositeOperation = 'multiply'
      g.fillStyle = ink(0, 0, 0)
      text(g, lines[i], x0, ly, sx)
      g.globalCompositeOperation = 'lighter'
      g.fillStyle = inkOf(GR, 1)
      text(g, lines[i], x0, ly, sx)
    } else {
      g.fillStyle = inkOf(P, 0.9)
      text(g, lines[i], x0 + 7 * u, ly + 5 * u, sx)
      g.globalCompositeOperation = 'source-over'
      g.fillStyle = ink(0, 0, 1)
      text(g, lines[i], x0, ly, sx)
    }
  }
  g.globalCompositeOperation = 'source-over'

  // foot
  const fy = h - T - 40 * u
  g.fillStyle = ink(0, 0, 1)
  g.fillRect(x0, fy - 92 * u, iw, 4 * u)
  mono(g, Math.round(18 * u), 500, 0.1)
  text(g, BRAND.name.toUpperCase(), x0 + 86 * u, fy - 44 * u)
  text(g, BRAND.locale.toUpperCase(), x0 + 86 * u, fy - 14 * u)
  drawMark(g, x0 + 34 * u, fy - 36 * u, 64 * u)
  const asx = display(g, Math.round(110 * u))
  text(g, '→', x1, fy - 2 * u, asx, 'right')

  proofMargin(g, w, h, T, 'HARK PRESS · JOB 000 · PASTE-UP · 80GSM NEWSPRINT', u)
}

// ------------------------------------------------------------------ lens sheets

/**
 * Full-bleed green sheet that covers the lens at the cuts. The square canvas
 * is spread over the screen `stretch` times wider than it is tall, so type
 * and marks are drawn 1/stretch as wide and land on screen in proportion
 * (redrawn when the viewport's shape changes).
 */
export function drawSheet(c: HTMLCanvasElement, big: string, line: string, sub: string, stretch = 1) {
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  const u = w / 768
  const k = 1 / clampN(stretch, 0.25, 4)
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = inkOf(GR, 0.94)
  g.fillRect(0, 0, w, h)
  // halftone ramp band
  halftoneRamp(g, 0, h * 0.8, w, h * 0.2, K, 0, 0.28, 32)
  const cx = w / 2
  g.fillStyle = ink(0, 0.94, 1)
  // a line sets at its size unless it would run off the screen (the sheet
  // overhangs the view, so only the middle ~70% of its width shows), then it
  // shrinks whole rather than squeezing
  const set = (s: string, y: number, sx: number) => {
    const f = Math.min(1, (w * 0.62) / Math.max(1, width(g, s, sx * k)))
    g.save()
    g.translate(cx, y)
    g.scale(1, f)
    text(g, s, 0, 0, sx * k * f, 'center')
    g.restore()
  }
  set(big, h * 0.5 + 90 * u, display(g, Math.round(300 * u)))
  // set a touch larger than the posters' slugs: they print through the lens's coarse screen
  mono(g, Math.round(26 * u), 500, 0.14)
  set(line, h * 0.5 + 156 * u, 1)
  mono(g, Math.round(18 * u), 500, 0.14)
  set(sub, h * 0.5 - 190 * u, 1)
  g.strokeStyle = ink(0, 0.94, 1)
  g.lineWidth = 2 * u
  for (const [x, y] of [
    [cx, h * 0.5 - 250 * u],
    [w * 0.14, h * 0.5],
    [w * 0.86, h * 0.5],
  ]) {
    g.beginPath()
    g.ellipse(x, y, 14 * u * k, 14 * u, 0, 0, Math.PI * 2)
    g.moveTo(x - 24 * u * k, y)
    g.lineTo(x + 24 * u * k, y)
    g.moveTo(x, y - 24 * u)
    g.lineTo(x, y + 24 * u)
    g.stroke()
  }
}

// ------------------------------------------------------------------ POST NO BILLS

/** The stencil sprayed on the ply: black ink, cut by stencil bridges, with overspray. */
export function drawStencil(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  const u = h / 256
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink()
  g.fillRect(0, 0, w, h)
  g.fillStyle = ink(0, 0, 0.92)
  const word = 'POST NO BILLS'
  let sx = display(g, Math.round(190 * u))
  track(g, 8 * u, true)
  // a full-width face (no canvas condensing) must still fit the board
  const tw = width(g, word, sx)
  const maxW = w - 40 * u
  if (tw > maxW) sx *= maxW / tw
  text(g, word, w / 2, 200 * u, sx, 'center')
  // stencil bridges + overspray
  g.globalCompositeOperation = 'multiply'
  g.fillStyle = ink(0, 0, 0)
  const r = rng(9)
  for (let x = 40 * u; x < w; x += (23 + r() * 18) * u) g.fillRect(x, 0, 5 * u, h)
  g.globalCompositeOperation = 'lighter'
  for (let i = 0; i < 1400; i++) {
    g.fillStyle = ink(0, 0, (40 + Math.floor(r() * 80)) / 255)
    const x = w / 2 + (r() - 0.5) * w * 0.95
    const y = (128 + (r() - 0.5) * 220) * u
    g.fillRect(x, y, 2 * u, 2 * u)
  }
  g.globalCompositeOperation = 'source-over'
}

// ------------------------------------------------------------------ old, torn posters (wall texture)

export const OLD = { cols: 4, rows: 2, cw: 320, ch: 452 }

/** Eight house "gig posters" for the wall's older layers (faded + torn in the shader). */
export function drawOldAtlas(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  const cw = c.width / OLD.cols
  const ch = c.height / OLD.rows
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink()
  g.fillRect(0, 0, c.width, c.height)
  const u = cw / 320
  const words = ['LISTEN', 'NO. 07', 'HARK', 'SAY HELLO', 'THIS WAY', 'LOUD', 'WHO’S THERE?', 'ALL EARS']
  for (let i = 0; i < OLD.cols * OLD.rows; i++) {
    const ox = (i % OLD.cols) * cw
    const oy = Math.floor(i / OLD.cols) * ch
    const r = rng(31 + i * 7)
    g.save()
    g.beginPath()
    g.rect(ox, oy, cw, ch)
    g.clip()
    g.translate(ox, oy)
    const pad1 = 14 * u
    g.globalCompositeOperation = 'source-over'
    // grounds
    const grounds: (Ink3 | null)[] = [null, GR, P, null, K, P, GR, null]
    const gi = grounds[i]
    if (gi) {
      g.fillStyle = inkOf(gi, gi === K ? 0.85 : 0.75)
      g.fillRect(pad1, pad1, cw - 2 * pad1, ch - 2 * pad1)
    }
    g.globalCompositeOperation = 'lighter'
    // motifs
    switch (i) {
      case 0: {
        g.fillStyle = inkOf(P, 0.9)
        g.beginPath()
        g.arc(cw * 0.55, ch * 0.4, cw * 0.36, 0, Math.PI * 2)
        g.fill()
        break
      }
      case 1: {
        g.strokeStyle = inkOf(K, 0.8)
        g.lineWidth = 16 * u
        for (let k = -8; k < 12; k++) {
          g.beginPath()
          g.moveTo(k * 40 * u, ch)
          g.lineTo(k * 40 * u + ch * 0.6, 0)
          g.stroke()
        }
        break
      }
      case 2: {
        for (let k = 0; k < 8; k++) {
          g.fillStyle = inkOf(K, 0.12 * k)
          g.fillRect(pad1, pad1 + k * (ch - 2 * pad1) / 8, cw - 2 * pad1, (ch - 2 * pad1) / 8 + 1)
        }
        break
      }
      case 3: {
        g.fillStyle = inkOf(GR, 0.95)
        for (let yy = 0; yy < 7; yy++)
          for (let xx = 0; xx < 5; xx++) {
            g.beginPath()
            g.arc(pad1 + 30 * u + xx * 56 * u, pad1 + 40 * u + yy * 56 * u, (8 + r() * 14) * u, 0, Math.PI * 2)
            g.fill()
          }
        break
      }
      case 4: {
        g.fillStyle = inkOf(P, 0.95)
        g.beginPath()
        g.moveTo(cw * 0.15, ch * 0.3)
        g.lineTo(cw * 0.6, ch * 0.3)
        g.lineTo(cw * 0.6, ch * 0.18)
        g.lineTo(cw * 0.88, ch * 0.4)
        g.lineTo(cw * 0.6, ch * 0.62)
        g.lineTo(cw * 0.6, ch * 0.5)
        g.lineTo(cw * 0.15, ch * 0.5)
        g.fill()
        break
      }
      case 5: {
        const s = 40 * u
        g.fillStyle = inkOf(GR, 0.9)
        for (let yy = 0; yy < 12; yy++)
          for (let xx = 0; xx < 9; xx++) if ((xx + yy) % 2 === 0) g.fillRect(xx * s, yy * s + ch * 0.45, s, s)
        break
      }
      case 6: {
        g.fillStyle = inkOf(K, 0.9)
        const sx = display(g, Math.round(360 * u))
        text(g, '?', cw * 0.5, ch * 0.68, sx, 'center')
        break
      }
      case 7: {
        g.strokeStyle = inkOf(P, 0.9)
        g.lineWidth = 12 * u
        for (let k = 1; k < 8; k++) {
          g.beginPath()
          g.arc(cw * 0.5, ch * 0.42, k * 22 * u, 0, Math.PI * 2)
          g.stroke()
        }
        break
      }
    }
    // headline word
    const word = words[i]
    const f = fit(g, word.split(' '), cw - 2 * pad1 - 16 * u, ch * 0.4, 2, Math.round(150 * u))
    g.globalCompositeOperation = 'lighter'
    g.fillStyle = gi === K ? inkOf(GR, 0.95) : inkOf(i % 3 === 0 ? GR : K, 0.95)
    if (gi === K) {
      g.globalCompositeOperation = 'multiply'
      g.fillStyle = ink(0, 0, 0)
    }
    const top = i % 2 === 0 ? ch - pad1 - 12 * u - f.lines.length * f.size * 0.86 : pad1 + 8 * u
    for (let l = 0; l < f.lines.length; l++) {
      display(g, f.size)
      text(g, f.lines[l], pad1 + 8 * u, top + f.size * 0.86 * (l + 1) - f.size * 0.1, f.sx)
    }
    g.globalCompositeOperation = 'source-over'
    // slug
    g.fillStyle = gi === K ? ink(0, 0.9, 0.85) : ink(0, 0, 0.9)
    mono(g, Math.round(11 * u), 500, 0.1)
    text(g, `RUN ${pad(1 + ((i * 3) % 7), 2)}/40 · HARK PRESS`, pad1 + 8 * u, i % 2 === 0 ? pad1 + 22 * u : ch - pad1 - 12 * u)
    g.restore()
  }
}

// ------------------------------------------------------------------ flyers (the nine)

export const FLY = { cols: 3, rows: 3, cw: 360, ch: 510 }
/** Photo window in a flyer cell (cell px). */
export const FLY_SHOT = { x: 20, y: 52, w: 320, h: 200 }

export function drawFlyer(c: HTMLCanvasElement, j: number, n: number, total: number, item: WorkItem, img: CanvasImageSource | null) {
  const g = c.getContext('2d')!
  const cw = c.width / FLY.cols
  const ch = c.height / FLY.rows
  const u = cw / FLY.cw
  const ox = (j % FLY.cols) * cw
  const oy = Math.floor(j / FLY.cols) * ch
  g.save()
  g.beginPath()
  g.rect(ox, oy, cw, ch)
  g.clip()
  g.translate(ox, oy)
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink()
  g.fillRect(0, 0, cw, ch)
  const grounds: [Ink3, number][] = [
    [[0, 0, 0], 0],
    [P, 0.2],
    [GR, 0.22],
  ]
  const [gc, ga] = grounds[j % 3]
  if (ga) {
    g.fillStyle = inkOf(gc, ga)
    g.fillRect(0, 0, cw, ch)
  }
  const x0 = FLY_SHOT.x * u
  const x1 = cw - FLY_SHOT.x * u
  // slug
  g.fillStyle = ink(0, 0, 1)
  mono(g, Math.round(13 * u), 500, 0.1)
  text(g, `${pad(n, 2)}/${pad(total, 2)}`, x0, 36 * u)
  text(g, 'LIVE ↗', x1, 36 * u, 1, 'right')
  // photo window
  const sx0 = FLY_SHOT.x * u
  const sy0 = FLY_SHOT.y * u
  const sw = FLY_SHOT.w * u
  const sh = FLY_SHOT.h * u
  if (img) {
    g.drawImage(img, sx0, sy0, sw, sh)
  } else {
    g.fillStyle = ink(0, 0, 0)
    g.fillRect(sx0, sy0, sw, sh)
  }
  // name
  const f = fit(g, item.name.toUpperCase().split(' '), x1 - x0, 150 * u, 3, Math.round(76 * u))
  let y = sy0 + sh + 18 * u
  g.globalCompositeOperation = 'lighter'
  for (let l = 0; l < f.lines.length; l++) {
    display(g, f.size)
    g.fillStyle = inkOf(j % 3 === 2 ? P : GR, 0.9)
    text(g, f.lines[l], x0 + 3 * u, y + f.size * 0.86 * (l + 1) - f.size * 0.08 + 3 * u, f.sx)
    g.fillStyle = ink(0, 0, 1)
    text(g, f.lines[l], x0, y + f.size * 0.86 * (l + 1) - f.size * 0.08, f.sx)
  }
  g.globalCompositeOperation = 'source-over'
  y = ch - 46 * u
  g.fillStyle = ink(0, 0, 1)
  g.fillRect(x0, y - 18 * u, x1 - x0, 2 * u)
  mono(g, Math.round(12.5 * u), 500, 0.08)
  text(g, item.industry.toUpperCase(), x0, y + 2 * u)
  mono(g, Math.round(11.5 * u), 400, 0.04)
  text(g, host(item.url), x0, y + 22 * u)
  // hand-cut edge line
  g.strokeStyle = ink(0, 0, 0.35)
  g.lineWidth = 2 * u
  g.strokeRect(1 * u, 1 * u, cw - 2 * u, ch - 2 * u)
  // staples
  g.fillStyle = ink(0, 0, 1)
  for (const sxp of [0.2, 0.8]) {
    g.save()
    g.translate(cw * sxp, 14 * u)
    g.rotate(sxp < 0.5 ? -0.12 : 0.1)
    g.fillRect(-13 * u, -2 * u, 26 * u, 4 * u)
    g.restore()
  }
  g.restore()
}

// ------------------------------------------------------------------ notice board face

/** Black-painted board: brushy paint, torn scraps of old flyers, a stencil header. */
export function drawBoard(c: HTMLCanvasElement) {
  const g = c.getContext('2d')!
  const w = c.width
  const h = c.height
  const u = w / 640
  const r = rng(404)
  g.globalCompositeOperation = 'source-over'
  g.fillStyle = ink(0, 0, 0.8)
  g.fillRect(0, 0, w, h)
  // brushed paint
  for (let i = 0; i < 260; i++) {
    const y = r() * h
    const x = r() * w - 60 * u
    g.fillStyle = ink(0, 0, 0.66 + r() * 0.3)
    g.globalAlpha = 0.35
    g.fillRect(x, y, (80 + r() * 260) * u, (2 + r() * 7) * u)
  }
  g.globalAlpha = 1
  // torn scraps left behind by older flyers, still stapled
  for (let i = 0; i < 26; i++) {
    const x = r() * w
    const y = 90 * u + r() * (h - 130 * u)
    const sw = (18 + r() * 46) * u
    const sh = (10 + r() * 30) * u
    g.save()
    g.translate(x, y)
    g.rotate((r() - 0.5) * 0.8)
    g.beginPath()
    g.moveTo(-sw / 2, -sh / 2)
    const n = 7
    for (let k = 0; k <= n; k++) g.lineTo(-sw / 2 + (sw * k) / n, -sh / 2 + (r() - 0.5) * 4 * u)
    for (let k = 0; k <= n; k++) g.lineTo(sw / 2 - (sw * k) / n, sh / 2 + (r() - 0.5) * 9 * u)
    g.closePath()
    const tint = r()
    g.fillStyle = tint < 0.3 ? ink(0.35, 0, 0.05) : tint < 0.55 ? ink(0, 0.4, 0.05) : ink(0, 0, 0.05)
    g.fill()
    g.fillStyle = ink(0, 0, 0.95)
    g.fillRect(-9 * u, -sh / 2 + 3 * u, 18 * u, 3 * u)
    g.restore()
  }
  // stencil header, sprayed in paper
  g.fillStyle = ink(0, 0, 0.03)
  mono(g, Math.round(26 * u), 500, 0.34)
  text(g, 'NOTICES · POST HERE', w / 2, 52 * u, 1, 'center')
  g.fillStyle = ink(0, 0, 0.8)
  for (let x = 40 * u; x < w; x += (19 + r() * 14) * u) g.fillRect(x, 26 * u, 3 * u, 34 * u)
  // halftone shadow under the top rail
  halftoneRamp(g, 0, 0, w, 16 * u, K, 1, 0.8, 4)
}
