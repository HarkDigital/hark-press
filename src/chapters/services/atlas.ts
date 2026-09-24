/*
 * Wood type glyph atlas for the Type Case.
 *
 * One canvas holds every sort in the case (A–Z, figures, a little
 * punctuation and four ornaments, one of them the Hark diamond), each drawn
 * white-on-black into a square cell that covers CELL_WORLD × CELL_WORLD
 * world units (the type body is 1 unit deep). The block shader samples the
 * cell through the block's top face, so the letter sits on the wood exactly
 * as it was measured here.
 *
 * Letters are set in Bricolage Grotesque at 800 / condensed, which reads as
 * an old gothic wood face. Each glyph reports its block width (ink width
 * plus a sliver of shoulder), so an M is a fat sort and an I a thin one.
 */

/** world units covered by one atlas cell (square) */
export const CELL_WORLD = 1.36
/** cap height as a fraction of the body */
const CAP = 0.76
/** wood shoulder either side of the ink, world units */
const SIDE = 0.075
const MIN_W = 0.34

/** Case layout, back row first. Ornaments: ◆ (the Hark diamond) ★ ● ➜ */
export const CASE_ROWS = ['ABCDEFGH', 'IJKLMNOP', 'QRSTUVWX', 'YZ&/!?.,', '12345678', '90◆★●➜-#']

export interface Glyph {
  ch: string
  /** atlas cell origin (uv, bottom-left) */
  u: number
  v: number
  /** block width in world units (body depth is 1) */
  w: number
}

export interface Atlas {
  canvas: HTMLCanvasElement
  cols: number
  rows: number
  /** uv size of one cell */
  cu: number
  cv: number
  glyphs: Map<string, Glyph>
  /** ink metrics for drawing the same letters elsewhere (the proof print) */
  font: (px: number) => string
  condensed: boolean
  capRatio: number
}

const FAMILY = "'Bricolage Grotesque Variable', 'Bricolage Grotesque', system-ui, sans-serif"

function setFont(ctx: CanvasRenderingContext2D, px: number): boolean {
  ctx.font = `800 ${px}px ${FAMILY}`
  const c = ctx as CanvasRenderingContext2D & { fontStretch?: string }
  if ('fontStretch' in c) {
    c.fontStretch = 'condensed'
    return c.fontStretch === 'condensed'
  }
  return false
}

/** Ornament paths, centred on (0,0), cap-high `h` px. */
function ornament(ctx: CanvasRenderingContext2D, ch: string, h: number) {
  ctx.beginPath()
  if (ch === '◆') {
    const r = h * 0.56
    ctx.moveTo(0, -r)
    ctx.lineTo(r * 0.78, 0)
    ctx.lineTo(0, r)
    ctx.lineTo(-r * 0.78, 0)
    ctx.closePath()
  } else if (ch === '★') {
    const R = h * 0.56
    const r = R * 0.45
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5
      const rr = i % 2 ? r : R
      ctx.lineTo(Math.cos(a) * rr, Math.sin(a) * rr + h * 0.04)
    }
    ctx.closePath()
  } else if (ch === '●') {
    ctx.arc(0, 0, h * 0.42, 0, Math.PI * 2)
  } else if (ch === '➜') {
    const s = h * 0.5
    ctx.moveTo(-s * 0.95, -s * 0.28)
    ctx.lineTo(s * 0.15, -s * 0.28)
    ctx.lineTo(s * 0.15, -s * 0.72)
    ctx.lineTo(s * 0.95, 0)
    ctx.lineTo(s * 0.15, s * 0.72)
    ctx.lineTo(s * 0.15, s * 0.28)
    ctx.lineTo(-s * 0.95, s * 0.28)
    ctx.closePath()
  }
  ctx.fill()
}

const ORNAMENT_W: Record<string, number> = { '◆': 0.9, '★': 1.0, '●': 0.84, '➜': 0.98 }

export function buildAtlas(cellPx: number): Atlas {
  const chars = CASE_ROWS.join('')
  const cols = 8
  const rows = Math.ceil(chars.length / cols)
  const canvas = document.createElement('canvas')
  canvas.width = cols * cellPx
  canvas.height = rows * cellPx
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  const pxPerUnit = cellPx / CELL_WORLD
  // cap height ratio of the face (measure an H at 200px)
  const condensed = setFont(ctx, 200)
  const hm = ctx.measureText('H')
  const capRatio = (hm.actualBoundingBoxAscent || 140) / 200
  const fontPx = (CAP * pxPerUnit) / capRatio
  setFont(ctx, fontPx)
  // without a condensed face, squeeze the drawing a touch so sorts stay gothic
  const squeeze = condensed ? 1 : 0.8
  ctx.textBaseline = 'alphabetic'
  ctx.textAlign = 'left'

  const glyphs = new Map<string, Glyph>()
  const capPx = CAP * pxPerUnit
  for (let i = 0; i < chars.length; i++) {
    // Array.from would split surrogates; every char here is BMP
    const ch = chars[i]
    const col = i % cols
    const row = Math.floor(i / cols)
    const cx = col * cellPx + cellPx / 2
    const cy = row * cellPx + cellPx / 2
    ctx.save()
    ctx.beginPath()
    ctx.rect(col * cellPx + 1, row * cellPx + 1, cellPx - 2, cellPx - 2)
    ctx.clip()
    ctx.fillStyle = '#fff'
    let w: number
    if (ch in ORNAMENT_W) {
      ctx.translate(cx, cy)
      ornament(ctx, ch, capPx)
      w = ORNAMENT_W[ch] * CAP + SIDE * 2
    } else {
      const m = ctx.measureText(ch)
      const left = m.actualBoundingBoxLeft
      const right = m.actualBoundingBoxRight
      const inkW = (left + right) * squeeze
      ctx.translate(cx, cy + capPx / 2)
      ctx.scale(squeeze, 1)
      // centre the ink (not the advance) on the block
      ctx.fillText(ch, -(right - left) / 2, 0)
      w = inkW / pxPerUnit + SIDE * 2
    }
    ctx.restore()
    glyphs.set(ch, {
      ch,
      u: col / cols,
      // canvas rows run down; texture v runs up (flipY)
      v: 1 - (row + 1) / rows,
      w: Math.max(MIN_W, Math.min(CELL_WORLD - 0.04, w)),
    })
  }
  return {
    canvas,
    cols,
    rows,
    cu: 1 / cols,
    cv: 1 / rows,
    glyphs,
    font: px => `800 ${px}px ${FAMILY}`,
    condensed,
    capRatio,
  }
}

/** Load the face before drawing (canvas text never waits for fonts). */
export async function loadWoodFace() {
  if (!document.fonts?.load) return
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`800 100px ${FAMILY}`, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789&/'),
        document.fonts.load(`500 12px 'DM Mono'`, 'PROOF 0123456789'),
      ]),
      new Promise(r => setTimeout(r, 2500)),
    ])
  } catch {
    /* draw with the fallback face */
  }
}
