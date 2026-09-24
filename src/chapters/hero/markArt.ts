import * as THREE from 'three'
import { logoParts, logoShapes } from '../../logo/logo'

/*
 * The mark as flat art: a three-channel separation mask the sheet shader
 * prints from, and the little index prints on top of each block.
 *
 *   R = loops (the green plate)
 *   G = keyline around every contour (the black plate)
 *   B = diamond (the pink plate; its loops' shadow comes from R, offset)
 */

export interface MarkFrame {
  /** bbox centre (mark units) */
  cx: number
  cy: number
  bw: number
  bh: number
  /** side of the square the mask covers, in mark units */
  span: number
}

/** keyline weight in mark units */
export const KEY_W = 0.03
/** pink shadow offset (mark units, x right / y up) */
export const SHADOW_OFF = new THREE.Vector2(0.05, -0.05)

let _frame: MarkFrame | null = null

export function markFrame(): MarkFrame {
  if (_frame) return _frame
  const box = new THREE.Box2()
  for (const s of logoShapes()) for (const p of s.getPoints(24)) box.expandByPoint(p)
  const c = box.getCenter(new THREE.Vector2())
  const size = box.getSize(new THREE.Vector2())
  _frame = { cx: c.x, cy: c.y, bw: size.x, bh: size.y, span: Math.max(size.x, size.y) * 1.34 }
  return _frame
}

function shapePath(shapes: THREE.Shape[], map: (p: THREE.Vector2) => [number, number]) {
  const path = new Path2D()
  const add = (pts: THREE.Vector2[]) => {
    pts.forEach((p, i) => {
      const [x, y] = map(p)
      if (i === 0) path.moveTo(x, y)
      else path.lineTo(x, y)
    })
    path.closePath()
  }
  for (const s of shapes) {
    add(s.getPoints(40))
    for (const h of s.holes) add(h.getPoints(40))
  }
  return path
}

/** Maps mark units into a square canvas region (y down), optionally mirrored. */
function mapper(f: MarkFrame, x0: number, y0: number, size: number, mirror = false) {
  return (p: THREE.Vector2): [number, number] => {
    const u = (p.x - f.cx) / f.span
    const v = (p.y - f.cy) / f.span
    return [x0 + (0.5 + (mirror ? -u : u)) * size, y0 + (0.5 - v) * size]
  }
}

/** The separation mask the sheet prints from. */
export function buildMaskCanvas(n = 1024): HTMLCanvasElement {
  const f = markFrame()
  const cv = document.createElement('canvas')
  cv.width = cv.height = n
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, n, n)
  ctx.globalCompositeOperation = 'lighter'
  const map = mapper(f, 0, 0, n)
  const parts = logoParts()
  ctx.fillStyle = 'rgb(255,0,0)'
  ctx.fill(shapePath([...parts.loopA, ...parts.loopB], map), 'evenodd')
  ctx.fillStyle = 'rgb(0,0,255)'
  ctx.fill(shapePath(parts.diamond, map), 'evenodd')
  ctx.strokeStyle = 'rgb(0,255,0)'
  ctx.lineJoin = 'round'
  ctx.lineWidth = (KEY_W * n) / f.span
  ctx.stroke(shapePath(logoShapes(), map))
  return cv
}

/**
 * The index print on a block's top: that block's plate, printed the way the
 * sheet will receive it, plus the drum code. Canvas channels are ink
 * densities (R pink, G green, B black).
 */
export function buildIndexCanvas(plate: number, n = 512): HTMLCanvasElement {
  const f = markFrame()
  const cv = document.createElement('canvas')
  cv.width = cv.height = n
  const ctx = cv.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, n, n)
  const parts = logoParts()
  const inset = n * 0.16
  const size = n - inset * 2
  const map = mapper(f, inset, inset * 0.82, size)
  const ink = plate === 0 ? 'rgb(0,0,255)' : plate === 1 ? 'rgb(0,255,0)' : 'rgb(255,0,0)'
  if (plate === 0) {
    ctx.strokeStyle = ink
    ctx.lineJoin = 'round'
    ctx.lineWidth = ((KEY_W * 1.5) * size) / f.span
    ctx.stroke(shapePath(logoShapes(), map))
  } else if (plate === 1) {
    ctx.fillStyle = ink
    ctx.fill(shapePath([...parts.loopA, ...parts.loopB], map), 'evenodd')
  } else {
    ctx.fillStyle = 'rgb(150,0,0)'
    const off = mapper(f, inset + (SHADOW_OFF.x * size) / f.span, inset * 0.82 - (SHADOW_OFF.y * size) / f.span, size)
    ctx.fill(shapePath([...parts.loopA, ...parts.loopB], off), 'evenodd')
    // knock the loops out of the shadow (zero ink, still opaque)
    ctx.fillStyle = '#000'
    ctx.fill(shapePath([...parts.loopA, ...parts.loopB], map), 'evenodd')
    ctx.fillStyle = ink
    ctx.fill(shapePath(parts.diamond, map), 'evenodd')
  }
  // the drum code and a rule, in black, along the foot of the block
  ctx.globalCompositeOperation = 'lighter'
  ctx.fillStyle = 'rgb(0,0,235)'
  ctx.font = `500 ${Math.round(n * 0.062)}px "DM Mono", ui-monospace, monospace`
  ctx.textBaseline = 'alphabetic'
  const code = ['K · KEY', 'G · GREEN', 'P · PINK'][plate]
  ctx.fillText(code, n * 0.08, n * 0.93)
  const r = ctx.measureText('PLATE 0' + (plate + 1))
  ctx.fillText('PLATE 0' + (plate + 1), n * 0.92 - r.width, n * 0.93)
  ctx.fillRect(n * 0.08, n * 0.855, n * 0.84, Math.max(2, n * 0.006))
  return cv
}

/** Every k-th point of a closed polyline, so it keeps at most `max` points. */
function decimate(pts: THREE.Vector2[], max: number) {
  const closed = pts.length > 2 && pts[0].distanceToSquared(pts[pts.length - 1]) < 1e-12
  const src = closed ? pts.slice(0, -1) : pts
  if (src.length <= max) return src
  const step = src.length / max
  const out: THREE.Vector2[] = []
  for (let i = 0; i < max; i++) out.push(src[Math.floor(i * step)])
  return out
}

const _simple = new Map<string, THREE.Shape[]>()

/** Light versions of the mark's shapes for relief geometry (the print uses the full-res mask). */
export function simpleShapes(which: 'loops' | 'diamond' | 'all', max = 150): THREE.Shape[] {
  const key = `${which}|${max}`
  const hit = _simple.get(key)
  if (hit) return hit
  const parts = logoParts()
  const src = which === 'loops' ? [...parts.loopA, ...parts.loopB] : which === 'diamond' ? parts.diamond : logoShapes()
  const out = src.map(s => {
    const shape = new THREE.Shape(decimate(s.getPoints(), max))
    for (const h of s.holes) shape.holes.push(new THREE.Path(decimate(h.getPoints(), Math.max(24, max / 2))))
    return shape
  })
  _simple.set(key, out)
  return out
}

/** Extruded keyline ring around every contour (the key block's relief). */
export function keylineShapes(width = KEY_W, max = 150): THREE.Shape[] {
  const out: THREE.Shape[] = []
  for (const s of logoShapes()) {
    const loops = [decimate(s.getPoints(), max), ...s.holes.map(h => decimate(h.getPoints(), Math.max(24, max / 2)))]
    for (const pts of loops) {
      const a = offsetLoop(pts, width / 2)
      const b = offsetLoop(pts, -width / 2)
      const areaA = Math.abs(THREE.ShapeUtils.area(a))
      const areaB = Math.abs(THREE.ShapeUtils.area(b))
      const outer = areaA >= areaB ? a : b
      const inner = areaA >= areaB ? b : a
      if (THREE.ShapeUtils.isClockWise(outer)) outer.reverse()
      if (!THREE.ShapeUtils.isClockWise(inner)) inner.reverse()
      const shape = new THREE.Shape(outer)
      shape.holes.push(new THREE.Path(inner))
      out.push(shape)
    }
  }
  return out
}

function offsetLoop(pts: THREE.Vector2[], d: number): THREE.Vector2[] {
  const n = pts.length
  const out: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[(i - 1 + n) % n]
    const q = pts[(i + 1) % n]
    const tx = q.x - p.x
    const ty = q.y - p.y
    const l = Math.hypot(tx, ty) || 1
    out.push(new THREE.Vector2(pts[i].x + (ty / l) * d, pts[i].y - (tx / l) * d))
  }
  return out
}
