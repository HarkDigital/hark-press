import * as THREE from 'three'
import { lerp } from '../../core/math'

/*
 * Camera framing: fit a set of world points into a screen region (NDC) at a
 * given azimuth / elevation / fov. Distance by bisection so the projected
 * points span `fill` of the region, then a truck so they sit where the region
 * wants them. Exact at every aspect ratio.
 */

export interface Shot {
  /** world points to frame (xyz triplets) */
  p: number[]
  /** azimuth around +Y (0 = camera on +Z looking toward -Z) */
  az: number
  /** elevation above the table, radians */
  el: number
  fov: number
  /** fraction of the region the points span (> 1 overfills) */
  fill: number
  /** 0 = full frame region, 1 = the region the copy leaves */
  band: number
  roll: number
}

export interface Region {
  x0: number
  x1: number
  y0: number
  y1: number
}

type V3 = [number, number, number]

/** the 8 corners of a box (centre, half extents) */
export function box(c: V3, e: V3): number[] {
  const p: number[] = []
  for (let i = 0; i < 8; i++)
    p.push(c[0] + (i & 1 ? 1 : -1) * e[0], c[1] + (i & 2 ? 1 : -1) * e[1], c[2] + (i & 4 ? 1 : -1) * e[2])
  return p
}

export const shot = (s: Partial<Shot> & Pick<Shot, 'p'>): Shot => ({
  az: 0,
  el: 1.1,
  fov: 32,
  fill: 1,
  band: 0,
  roll: 0,
  ...s,
  p: s.p.slice(),
})

export function mixShot(a: Shot, b: Shot, k: number, out: Shot) {
  const n = Math.min(a.p.length, b.p.length)
  out.p.length = n
  for (let i = 0; i < n; i++) out.p[i] = lerp(a.p[i], b.p[i], k)
  out.az = lerp(a.az, b.az, k)
  out.el = lerp(a.el, b.el, k)
  out.fov = lerp(a.fov, b.fov, k)
  out.fill = lerp(a.fill, b.fill, k)
  out.band = lerp(a.band, b.band, k)
  out.roll = lerp(a.roll, b.roll, k)
  return out
}

const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _back = new THREE.Vector3()
const MAXP = 16
const _ca = new Float64Array(MAXP)
const _cb = new Float64Array(MAXP)
const _cz = new Float64Array(MAXP)

export function solve(s: Shot, reg: Region, aspect: number, outP: THREE.Vector3, outT: THREE.Vector3) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(s.fov) / 2)
  const tanX = tanY * aspect
  const ce = Math.cos(s.el)
  _back.set(Math.sin(s.az) * ce, Math.sin(s.el), Math.cos(s.az) * ce)
  _right.set(Math.cos(s.az), 0, -Math.sin(s.az))
  _up.crossVectors(_back, _right)
  const n = Math.min(MAXP, Math.floor(s.p.length / 3))
  let cx = 0
  let cy = 0
  let cz = 0
  for (let i = 0; i < n; i++) {
    cx += s.p[i * 3] / n
    cy += s.p[i * 3 + 1] / n
    cz += s.p[i * 3 + 2] / n
  }
  let zMax = 0
  for (let i = 0; i < n; i++) {
    const x = s.p[i * 3] - cx
    const y = s.p[i * 3 + 1] - cy
    const z = s.p[i * 3 + 2] - cz
    _ca[i] = x * _right.x + y * _right.y + z * _right.z
    _cb[i] = x * _up.x + y * _up.y + z * _up.z
    _cz[i] = x * _back.x + y * _back.y + z * _back.z
    zMax = Math.max(zMax, _cz[i])
  }
  const rw = Math.max(0.05, reg.x1 - reg.x0)
  const rh = Math.max(0.05, reg.y1 - reg.y0)
  let lo = zMax + 0.2
  let hi = 400
  let mx = 0
  let my = 0
  for (let it = 0; it < 30; it++) {
    const d = (lo + hi) / 2
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < n; i++) {
      const depth = d - _cz[i]
      const nx = _ca[i] / (depth * tanX)
      const ny = _cb[i] / (depth * tanY)
      if (nx < x0) x0 = nx
      if (nx > x1) x1 = nx
      if (ny < y0) y0 = ny
      if (ny > y1) y1 = ny
    }
    const f = Math.max((x1 - x0) / rw, (y1 - y0) / rh)
    mx = (x0 + x1) / 2
    my = (y0 + y1) / 2
    if (f > s.fill) lo = d
    else hi = d
  }
  const d = (lo + hi) / 2
  const wantX = (reg.x0 + reg.x1) / 2
  const wantY = (reg.y0 + reg.y1) / 2
  const tx = -(wantX - mx) * d * tanX
  const ty = -(wantY - my) * d * tanY
  outT.set(cx, cy, cz).addScaledVector(_right, tx).addScaledVector(_up, ty)
  outP.copy(outT).addScaledVector(_back, d)
}
