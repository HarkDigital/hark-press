/*
 * Condensed type on a 2D canvas, everywhere. ctx.fontStretch is missing in
 * every Safari, so 'condensed' falls back to full width there. setPrintFont
 * sets the font (keyword in the shorthand + fontStretch when available),
 * measures whether condensing actually happened, and returns an x-scale to
 * apply around fillText (1 when the browser condensed it for us):
 *
 *   const sx = setPrintFont(ctx, 800, 96, 'condensed')
 *   ctx.save(); ctx.scale(sx, 1); ctx.fillText(text, x / sx, y); ctx.restore()
 *   const width = ctx.measureText(text).width * sx
 */

export type Stretch = 'normal' | 'semi-condensed' | 'condensed' | 'extra-condensed'

const FAMILY = "'Bricolage Grotesque Variable', 'Bricolage Grotesque', system-ui, sans-serif"
const TARGET: Record<Stretch, number> = {
  normal: 1,
  'semi-condensed': 0.87,
  condensed: 0.78,
  'extra-condensed': 0.7,
}
const cache = new Map<string, number>()

export function setPrintFont(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  weight: number,
  size: number,
  stretch: Stretch = 'condensed',
  family = FAMILY,
): number {
  const kw = stretch === 'normal' ? '' : `${stretch} `
  ctx.font = `${weight} ${kw}${size}px ${family}`
  const c = ctx as CanvasRenderingContext2D & { fontStretch?: string }
  if ('fontStretch' in c) c.fontStretch = stretch
  if (stretch === 'normal') return 1
  const key = `${weight}|${stretch}|${family}`
  let sx = cache.get(key)
  if (sx === undefined) {
    // did the browser actually condense? compare against the normal width
    const probe = 'HARK PRESS 0123'
    const got = ctx.measureText(probe).width
    const saved = ctx.font
    ctx.font = `${weight} ${size}px ${family}`
    if ('fontStretch' in c) c.fontStretch = 'normal'
    const normal = ctx.measureText(probe).width
    ctx.font = saved
    if ('fontStretch' in c) c.fontStretch = stretch
    sx = normal > 0 && got / normal < 0.95 ? 1 : TARGET[stretch]
    cache.set(key, sx)
  }
  return sx
}
