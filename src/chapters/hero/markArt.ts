import * as THREE from 'three'
import { logoParts, logoShapes } from '../../logo/logo'
import { inkLayer, type Mapper, type Rect } from './art'

/*
 * The mark as flat art: a three-channel separation mask the sheet shader
 * prints from, and the pink plate as canvas art (block label + face).
 *
 *   R = loops, B = diamond (together: the pink plate; its shadow is the
 *       same shapes, offset and knocked out)
 *   G = keyline around every contour (the pencil layout ghost)
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

/** keyline weight in mark units (the layout ghost, and the paper hairline between the pieces) */
export const KEY_W = 0.02
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
 * The pink plate: the whole mark (loops + diamond) in solid pink, each
 * piece kept apart by a hairline of paper, over a half-tint drop shadow
 * that is knocked out under the mark. Draws in sheet
 * units through `m`, with the mark centred at (mx, my) and mh tall.
 */
export function paintMark(
  target: CanvasRenderingContext2D,
  m: Mapper,
  at: { mx: number; my: number; mh: number },
  ink: string,
  shadowInk: string,
) {
  const f = markFrame()
  const parts = logoParts()
  const all = [...parts.loopA, ...parts.loopB, ...parts.diamond]
  const map = (dx: number, dy: number) => (p: THREE.Vector2): [number, number] => [
    m.X(at.mx + (p.x - f.cx) * at.mh + dx),
    m.Y(at.my + (p.y - f.cy) * at.mh + dy),
  ]
  inkLayer(target, shadowInk, ctx => {
    ctx.fill(shapePath(all, map(SHADOW_OFF.x * at.mh, SHADOW_OFF.y * at.mh)), 'evenodd')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fill(shapePath(all, map(0, 0)), 'evenodd')
  })
  // one ink: a hairline of paper between the pieces keeps the diamond apart from the loops
  inkLayer(target, ink, ctx => {
    ctx.fill(shapePath(all, map(0, 0)), 'evenodd')
    ctx.globalCompositeOperation = 'destination-out'
    ctx.lineJoin = 'round'
    ctx.lineWidth = KEY_W * at.mh * m.k
    ctx.stroke(shapePath(all, map(0, 0)))
  })
}

/** The mark's footprint in sheet units (mark bbox, no shadow). */
export function markRect(at: { mx: number; my: number; mh: number }): Rect {
  const f = markFrame()
  return {
    x0: at.mx - (f.bw * at.mh) / 2,
    x1: at.mx + (f.bw * at.mh) / 2,
    y0: at.my - (f.bh * at.mh) / 2,
    y1: at.my + (f.bh * at.mh) / 2,
  }
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
