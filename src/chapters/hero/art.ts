import { setPrintFont } from '../../print/type'
import type { Layout } from './shared'

/*
 * The headline as print art. The three passes print the promise:
 *
 *   KEY    MAKE THE / INTERNET, and LISTEN. as a hollow keyline with a
 *          drop shadow (the trap the green fills)
 *   GREEN  LISTEN.
 *   PINK   the mark (drawn from markArt's separation mask)
 *
 * Everything is laid out in SHEET UNITS (x right, y up the print, origin
 * at the sheet centre) so the sheet, the block faces and the block labels
 * all draw the same art. Canvas type is condensed Bricolage through
 * setPrintFont, so Safari (no ctx.fontStretch) gets the same widths.
 */

export const LINES = ['MAKE THE', 'INTERNET', 'LISTEN.'] as const

/** tracking, in em (final, after any condensing) */
const TRACK = -0.02
/** LISTEN.'s key trap: keyline (outside the letter) and drop-shadow offset (em, y up) */
const TRAP_W = 0.034
const TRAP_SH = { x: 0.045, y: -0.032 }
/** clear space around each plate's art on its block (sheet units) */
export const PLATE_PAD = 0.18

export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface HeadArt {
  /** font size (sheet units) */
  fs: number
  /** cap height (sheet units) */
  cap: number
  /** left edge of the type */
  x0: number
  /** baselines of the three lines */
  base: number[]
  /** set widths of the three lines */
  widths: number[]
  /** the key plate's art, the green plate's art (sheet units, y up) */
  keyRect: Rect
  greenRect: Rect
}

/** Type metrics at 1 unit, measured once the display face is in. */
interface Metrics {
  /** per line: x of each glyph, in em (tracking and condensing applied) */
  pos: number[][]
  widths: number[]
  cap: number
}
let _metrics: Metrics | null = null

const REF = 200
let _probe: CanvasRenderingContext2D | null = null
function probe() {
  if (!_probe) _probe = document.createElement('canvas').getContext('2d')!
  return _probe
}

function metrics(): Metrics {
  if (_metrics) return _metrics
  const ctx = probe()
  // twice: the helper's first call per face measures, then restores ctx.font
  // from its getter, which drops the stretch keyword; the second call (cached)
  // leaves the context set exactly as every later draw will set it
  setPrintFont(ctx, 800, REF, 'condensed')
  const sx = setPrintFont(ctx, 800, REF, 'condensed')
  const pos: number[][] = []
  const widths: number[] = []
  for (const line of LINES) {
    const xs: number[] = []
    for (let i = 0; i < line.length; i++) xs.push((ctx.measureText(line.slice(0, i)).width * sx) / REF + i * TRACK)
    pos.push(xs)
    widths.push((ctx.measureText(line).width * sx) / REF + (line.length - 1) * TRACK)
  }
  const capPx = ctx.measureText('H').actualBoundingBoxAscent
  const cap = Number.isFinite(capPx) && capPx > 0 ? capPx / REF : 0.68
  _metrics = { pos, widths, cap }
  return _metrics
}

/** Forget cached metrics (call when the display face finishes loading). */
export function resetMetrics() {
  _metrics = null
}

/** Where the headline sits on a sheet of this layout. */
export function headFor(l: Layout): HeadArt {
  const m = metrics()
  const x0 = -l.w / 2 + (l.port ? 0.09 : 0.085) * l.w
  const capTop = l.port ? -0.15 : l.h / 2 - 0.215 * l.h
  const maxW = (l.port ? 0.82 : 0.44) * l.w
  const maxFs = (l.port ? 0.115 : 0.205) * l.h
  const widest = Math.max(...m.widths)
  const fs = Math.min(maxFs, maxW / Math.max(0.5, widest + TRAP_SH.x))
  const cap = m.cap * fs
  const pitch = 0.84 * fs
  const base = [0, 1, 2].map(i => capTop - cap - i * pitch)
  const widths = m.widths.map(w => w * fs)
  const P = PLATE_PAD
  const keyRect = {
    x0: x0 - P,
    x1: x0 + Math.max(...widths) + TRAP_SH.x * fs + P,
    y0: base[2] + TRAP_SH.y * fs - P,
    y1: capTop + P,
  }
  const greenRect = {
    x0: x0 - P,
    x1: x0 + widths[2] + P,
    y0: base[2] - P,
    y1: base[2] + cap + P,
  }
  return { fs, cap, x0, base, widths, keyRect, greenRect }
}

/** sheet units → canvas px */
export interface Mapper {
  /** px per sheet unit */
  k: number
  X(x: number): number
  Y(y: number): number
}

/** A mapper that fits `rect` (sheet units) into a canvas box, centred. */
export function fitMapper(rect: Rect, bx: number, by: number, bw: number, bh: number): Mapper {
  const k = Math.min(bw / (rect.x1 - rect.x0), bh / (rect.y1 - rect.y0))
  const cx = (rect.x0 + rect.x1) / 2
  const cy = (rect.y0 + rect.y1) / 2
  return {
    k,
    X: x => bx + bw / 2 + (x - cx) * k,
    Y: y => by + bh / 2 - (y - cy) * k,
  }
}

/* ------------------------------------------------------------------ */
/*  drawing: every shape goes onto a scratch layer in white, then is  */
/*  tinted into one ink channel of the target with 'lighter'          */
/* ------------------------------------------------------------------ */

let _scratch: HTMLCanvasElement | null = null
function scratch(w: number, h: number) {
  if (!_scratch) _scratch = document.createElement('canvas')
  if (_scratch.width !== w || _scratch.height !== h) {
    _scratch.width = w
    _scratch.height = h
  }
  const ctx = _scratch.getContext('2d')!
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  ctx.clearRect(0, 0, w, h)
  return ctx
}

/** Free the scratch layer once the art is drawn (it is recreated on demand). */
export function releaseScratch() {
  if (_scratch) _scratch.width = _scratch.height = 0
}

/** Draw `paint` in white on a scratch layer, then ADD it to `target` in `ink` (e.g. 'rgb(0,0,255)'). */
export function inkLayer(target: CanvasRenderingContext2D, ink: string, paint: (ctx: CanvasRenderingContext2D) => void) {
  const { width: w, height: h } = target.canvas
  const ctx = scratch(w, h)
  ctx.fillStyle = '#fff'
  ctx.strokeStyle = '#fff'
  paint(ctx)
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.globalCompositeOperation = 'source-in'
  ctx.fillStyle = ink
  ctx.fillRect(0, 0, w, h)
  target.save()
  target.setTransform(1, 0, 0, 1, 0, 0)
  target.globalAlpha = 1
  target.globalCompositeOperation = 'lighter'
  target.drawImage(ctx.canvas, 0, 0)
  target.restore()
}

/**
 * One line of the headline, glyph by glyph (kerned, tracked, condensed).
 * `grow` > 0 draws it dilated by that much (sheet units) — a union of
 * offset copies — which is how keylines are built: the display face is
 * variable, so its glyphs keep overlapping contours that strokeText would
 * draw inside the letters.
 */
function typeLine(ctx: CanvasRenderingContext2D, m: Mapper, head: HeadArt, line: number, dx = 0, dy = 0, grow = 0) {
  const px = head.fs * m.k
  const sx = setPrintFont(ctx, 800, px, 'condensed')
  const pos = metrics().pos[line]
  const text = LINES[line]
  const r = grow * m.k
  const steps = r > 0.5 ? Math.max(12, Math.min(28, Math.round(r * 2.2))) : 1
  ctx.save()
  ctx.textBaseline = 'alphabetic'
  ctx.scale(sx, 1)
  for (let j = 0; j < steps; j++) {
    const a = (j / steps) * Math.PI * 2
    const ox = steps > 1 ? Math.cos(a) * r : 0
    const oy = steps > 1 ? Math.sin(a) * r : 0
    const y = m.Y(head.base[line] + dy) + oy
    for (let i = 0; i < text.length; i++) {
      if (text[i] === ' ') continue
      const x = m.X(head.x0 + dx + pos[i] * head.fs) + ox
      ctx.fillText(text[i], x / sx, y)
    }
  }
  ctx.restore()
}

/** The key plate: two solid lines, then LISTEN. hollow: an outside keyline and a drop shadow. */
export function paintKey(target: CanvasRenderingContext2D, ink: string, m: Mapper, head: HeadArt) {
  inkLayer(target, ink, ctx => {
    typeLine(ctx, m, head, 0)
    typeLine(ctx, m, head, 1)
  })
  inkLayer(target, ink, ctx => {
    typeLine(ctx, m, head, 2, TRAP_SH.x * head.fs, TRAP_SH.y * head.fs)
    typeLine(ctx, m, head, 2, 0, 0, TRAP_W * head.fs)
    ctx.globalCompositeOperation = 'destination-out'
    typeLine(ctx, m, head, 2)
  })
}

/** The green plate: LISTEN. */
export function paintGreen(target: CanvasRenderingContext2D, ink: string, m: Mapper, head: HeadArt) {
  inkLayer(target, ink, ctx => typeLine(ctx, m, head, 2))
}

/** The layout ghost: every line as a pencil keyline (outside the letter) over a faint tint. */
export function paintGhost(target: CanvasRenderingContext2D, ink: string, m: Mapper, head: HeadArt, line: number) {
  inkLayer(target, ink, ctx => {
    ctx.globalAlpha = 0.2
    for (let i = 0; i < 3; i++) typeLine(ctx, m, head, i)
  })
  inkLayer(target, ink, ctx => {
    for (let i = 0; i < 3; i++) typeLine(ctx, m, head, i, 0, 0, line)
    ctx.globalCompositeOperation = 'destination-out'
    for (let i = 0; i < 3; i++) typeLine(ctx, m, head, i)
  })
}

/** A rect grown by d on every side. */
export function grow(r: Rect, d: number): Rect {
  return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d }
}
