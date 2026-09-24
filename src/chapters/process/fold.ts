import * as THREE from 'three'

/*
 * THE FOLD — a real crease pattern for a classic dart, folded rigidly.
 *
 * The sheet lives in "config space": x across (-HW..HW), y along (-HH..HH,
 * nose at +y), z = the side of the sheet facing up off the mat. Each fold is
 * a line in the configuration left by the folds before it (all of which are
 * flat), so the crease pattern is found by cutting the sheet face by face:
 * every face remembers the 2D isometry that carries it from the flat sheet
 * into the current flat configuration and a bitmask of the folds that move it.
 *
 * At runtime each vertex replays those folds in order. A fold rolls the paper
 * around its crease: an arc of length rho (soft while the fold is travelling,
 * a hair's radius once it's pressed) and then straight paper at the fold
 * angle, so flaps curl over like paper instead of hinging like tin, and the
 * residual radius stacks the layers without z-fighting.
 *
 *   1  LISTEN     top corners to the centre line (valley)
 *   2  PROTOTYPE  new edges to the centre line again (valley)
 *   3  BUILD      in half along the centre (valley: flaps inside)
 *   4  SUPPORT    wings down on either side, then the keel opens a touch
 */

export type V2 = [number, number]

/** sheet half-width / half-height (a letter-ish 1 : 1.3 sheet) */
export const HW = 1
export const HH = 1.3
/** wing crease: distance from the keel in the folded half */
export const WING = 0.3

export const B1L = 1
export const B1R = 2
export const B2L = 4
export const B2R = 8
export const B3 = 16
export const B4R = 32
export const B4L = 64

const T2 = Math.tan(Math.PI / 8)
const S8 = Math.sin(Math.PI / 8)
const C8 = Math.cos(Math.PI / 8)
/** where fold 2 meets the side edge */
export const F2_Y = HH - HW / T2

interface FoldSpec {
  bit: number
  /** crease line in the configuration before this fold */
  a: V2
  d: V2
  /** a point (in that configuration) known to be on the moving side */
  ref: V2
  /** +1 valley (flap comes up over +z), -1 mountain */
  s: 1 | -1
  /** residual crease radius once pressed (stacks layers) */
  rRes: number
  /** height of the crease axis */
  z: number
  /** a flat fold: carries faces into the next flat configuration */
  flat: boolean
  /** restrict to some faces (wings fold one half each) */
  filter?: (mask: number) => boolean
}

const n2 = (x: number, y: number): V2 => {
  const l = Math.hypot(x, y)
  return [x / l, y / l]
}

export const FOLDS: FoldSpec[] = [
  { bit: B1L, a: [0, HH], d: n2(-1, -1), ref: [-HW * 0.98, HH * 0.98], s: 1, rRes: 0.003, z: 0, flat: true },
  { bit: B1R, a: [0, HH], d: n2(1, -1), ref: [HW * 0.98, HH * 0.98], s: 1, rRes: 0.003, z: 0, flat: true },
  { bit: B2L, a: [0, HH], d: [-S8, -C8], ref: [-HW * 0.98, 0], s: 1, rRes: 0.009, z: 0, flat: true },
  { bit: B2R, a: [0, HH], d: [S8, -C8], ref: [HW * 0.98, 0], s: 1, rRes: 0.009, z: 0, flat: true },
  { bit: B3, a: [0, 0], d: [0, 1], ref: [-0.5, 0], s: 1, rRes: 0.0225, z: 0, flat: true },
  { bit: B4R, a: [WING, 0], d: [0, 1], ref: [0.9, -1.2], s: -1, rRes: 0.012, z: 0.009, flat: false, filter: m => !(m & B3) },
  { bit: B4L, a: [WING, 0], d: [0, 1], ref: [0.9, -1.2], s: 1, rRes: 0.012, z: 0.036, flat: false, filter: m => !!(m & B3) },
]

// ------------------------------------------------------------- 2D isometries

/** x' = a x + b y + tx ; y' = c x + d y + ty */
type Iso = [number, number, number, number, number, number]
const ID: Iso = [1, 0, 0, 1, 0, 0]
const isoApply = (m: Iso, p: V2): V2 => [m[0] * p[0] + m[1] * p[1] + m[4], m[2] * p[0] + m[3] * p[1] + m[5]]
const isoMul = (a: Iso, b: Iso): Iso => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[0] * b[4] + a[1] * b[5] + a[4],
  a[2] * b[4] + a[3] * b[5] + a[5],
]
function isoInv(m: Iso): Iso {
  const det = m[0] * m[3] - m[1] * m[2]
  const a = m[3] / det
  const b = -m[1] / det
  const c = -m[2] / det
  const d = m[0] / det
  return [a, b, c, d, -(a * m[4] + b * m[5]), -(c * m[4] + d * m[5])]
}
function reflectIso(a: V2, d: V2): Iso {
  const r00 = 2 * d[0] * d[0] - 1
  const r01 = 2 * d[0] * d[1]
  const r11 = 2 * d[1] * d[1] - 1
  return [r00, r01, r01, r11, a[0] - (r00 * a[0] + r01 * a[1]), a[1] - (r01 * a[0] + r11 * a[1])]
}
const cross = (d: V2, v: V2) => d[0] * v[1] - d[1] * v[0]

export interface Face {
  poly: V2[]
  /** flat sheet → flat configuration after the last flat fold */
  T: Iso
  mask: number
}

export interface Crease {
  a: V2
  b: V2
  /** index into FOLDS */
  fold: number
}

/** Split a convex polygon by the zero line of a per-vertex signed value. */
function split(poly: V2[], s: number[]): { pos: V2[]; neg: V2[]; chord: V2[] } {
  const pos: V2[] = []
  const neg: V2[] = []
  const chord: V2[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const p = poly[i]
    const q = poly[(i + 1) % n]
    const sp = s[i]
    const sq = s[(i + 1) % n]
    if (sp >= 0) pos.push(p)
    if (sp <= 0) neg.push(p)
    if (sp === 0) chord.push(p)
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq)
      const x: V2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]
      pos.push(x)
      neg.push(x)
      chord.push(x)
    }
  }
  return { pos, neg, chord }
}

/** Cut the sheet into faces along every crease, in fold order. */
export function buildCreasePattern() {
  let faces: Face[] = [
    {
      poly: [
        [-HW, -HH],
        [HW, -HH],
        [HW, HH],
        [-HW, HH],
      ],
      T: ID,
      mask: 0,
    },
  ]
  const creases: Crease[] = []
  const EPS = 1e-9
  FOLDS.forEach((f, fi) => {
    const refSide = Math.sign(cross(f.d, [f.ref[0] - f.a[0], f.ref[1] - f.a[1]]))
    const R = reflectIso(f.a, f.d)
    const next: Face[] = []
    for (const face of faces) {
      if (f.filter && !f.filter(face.mask)) {
        next.push(face)
        continue
      }
      const s = face.poly.map(p => {
        const c = isoApply(face.T, p)
        const v = cross(f.d, [c[0] - f.a[0], c[1] - f.a[1]]) * refSide
        return Math.abs(v) < EPS ? 0 : v
      })
      const moved = (poly: V2[]): Face => ({
        poly,
        T: f.flat ? isoMul(R, face.T) : face.T,
        mask: face.mask | f.bit,
      })
      if (s.every(v => v >= 0)) {
        next.push(moved(face.poly))
        continue
      }
      if (s.every(v => v <= 0)) {
        next.push(face)
        continue
      }
      const { pos, neg, chord } = split(face.poly, s)
      if (pos.length >= 3) next.push(moved(pos))
      if (neg.length >= 3) next.push({ poly: neg, T: face.T, mask: face.mask })
      if (chord.length >= 2) creases.push({ a: chord[0], b: chord[chord.length - 1], fold: fi })
    }
    faces = next
  })
  return { faces, creases }
}

/** Flat sheet point → flat configuration after the last flat fold, for a face. */
export function toConfig(face: Face, p: V2): V2 {
  return isoApply(face.T, p)
}
export function fromConfig(face: Face, c: V2): V2 {
  return isoApply(isoInv(face.T), c)
}
/** true when the face shows its back once folded flat (odd number of flips) */
export function isFlipped(face: Face) {
  return face.T[0] * face.T[3] - face.T[1] * face.T[2] < 0
}
export function pointInConvex(poly: V2[], p: V2) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
    if (Math.abs(c) < 1e-12) continue
    const s = Math.sign(c)
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

// ------------------------------------------------------------- 3D folding

interface Fold3 {
  bit: number
  P: THREE.Vector3
  D: THREE.Vector3
  U: THREE.Vector3
  N: THREE.Vector3
  K: THREE.Vector3
  s: number
  rRes: number
}

export const FOLD3: Fold3[] = FOLDS.map(f => {
  const D = new THREE.Vector3(f.d[0], f.d[1], 0)
  const N = new THREE.Vector3(0, 0, 1)
  let U = new THREE.Vector3(-f.d[1], f.d[0], 0)
  if (U.x * (f.ref[0] - f.a[0]) + U.y * (f.ref[1] - f.a[1]) < 0) U.negate()
  U = U.normalize()
  const K = new THREE.Vector3().crossVectors(U, N).multiplyScalar(f.s)
  return { bit: f.bit, P: new THREE.Vector3(f.a[0], f.a[1], f.z), D, U, N, K, s: f.s, rRes: f.rRes }
})

/** the keel: fold 3's crease, for opening the halves a little once the wings are down */
const KEEL_P = new THREE.Vector3(0, 0, FOLDS[4].rRes)
const KEEL_K = new THREE.Vector3(0, 1, 0)

/** Per-fold angle (0..PI) and bend arc length, plus the keel opening. */
export interface FoldState {
  theta: Float32Array
  rho: Float32Array
  keel: number
}

export function foldState(): FoldState {
  return { theta: new Float32Array(FOLDS.length), rho: new Float32Array(FOLDS.length), keel: 0 }
}

const _rel = new THREE.Vector3()

function rotate(v: THREE.Vector3, k: THREE.Vector3, c: number, s: number) {
  // Rodrigues, in place
  const kx = k.x
  const ky = k.y
  const kz = k.z
  const x = v.x
  const y = v.y
  const z = v.z
  const dot = kx * x + ky * y + kz * z
  const cx = ky * z - kz * y
  const cy = kz * x - kx * z
  const cz = kx * y - ky * x
  v.set(x * c + cx * s + kx * dot * (1 - c), y * c + cy * s + ky * dot * (1 - c), z * c + cz * s + kz * dot * (1 - c))
}

/**
 * Fold one point (p: flat sheet position with z = height off the sheet,
 * n: its normal) through every fold in its mask. In place.
 */
export function foldPoint(p: THREE.Vector3, n: THREE.Vector3, mask: number, st: FoldState) {
  for (let i = 0; i < FOLD3.length; i++) {
    const f = FOLD3[i]
    if (!(mask & f.bit)) continue
    const theta = st.theta[i]
    if (theta < 1e-5) continue
    const rho = Math.max(st.rho[i], theta * f.rRes)
    _rel.subVectors(p, f.P)
    const a = _rel.dot(f.D)
    const u = Math.max(0, _rel.dot(f.U))
    const h = _rel.dot(f.N)
    const R = rho / theta
    let phi: number
    let cu: number
    let cn: number
    if (u <= rho) {
      phi = (theta * u) / rho
      cu = R * Math.sin(phi)
      cn = f.s * R * (1 - Math.cos(phi))
    } else {
      phi = theta
      const ct = Math.cos(theta)
      const stt = Math.sin(theta)
      cu = R * stt + (u - rho) * ct
      cn = f.s * (R * (1 - ct) + (u - rho) * stt)
    }
    const sp = Math.sin(phi)
    const cp = Math.cos(phi)
    const ku = cu - h * f.s * sp
    const kn = cn + h * cp
    p.copy(f.P)
      .addScaledVector(f.D, a)
      .addScaledVector(f.U, ku)
      .addScaledVector(f.N, kn)
    rotate(n, f.K, cp, sp)
  }
  if (st.keel !== 0 && mask & B3) {
    const c = Math.cos(-st.keel)
    const s = Math.sin(-st.keel)
    p.sub(KEEL_P)
    rotate(p, KEEL_K, c, s)
    p.add(KEEL_P)
    rotate(n, KEEL_K, c, s)
  }
}

// ------------------------------------------------------------- mesh

/** Clip a convex polygon to an axis-aligned box. */
function clipBox(poly: V2[], x0: number, y0: number, x1: number, y1: number): V2[] {
  let out = poly
  const planes: [number, number, number][] = [
    [1, 0, -x0],
    [-1, 0, x1],
    [0, 1, -y0],
    [0, -1, y1],
  ]
  for (const [nx, ny, c] of planes) {
    if (out.length < 3) return []
    const s = out.map(p => nx * p[0] + ny * p[1] + c)
    const res: V2[] = []
    for (let i = 0; i < out.length; i++) {
      const p = out[i]
      const q = out[(i + 1) % out.length]
      const sp = s[i]
      const sq = s[(i + 1) % out.length]
      if (sp >= 0) res.push(p)
      if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
        const t = sp / (sp - sq)
        res.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
      }
    }
    out = res
  }
  return out
}

export interface SheetMesh {
  geometry: THREE.BufferGeometry
  /** flat positions (x, y, z) per vertex */
  base: Float32Array
  mask: Uint8Array
  count: number
}

/**
 * Tessellate the faces on a grid (fine enough for the paper to curl), sharing
 * vertices inside each face so normals stay smooth along a roll.
 */
export function buildSheetMesh(faces: Face[], cell: number): SheetMesh {
  const pos: number[] = []
  const uv: number[] = []
  const masks: number[] = []
  const index: number[] = []
  const nx = Math.ceil((2 * HW) / cell)
  const ny = Math.ceil((2 * HH) / cell)
  const dx = (2 * HW) / nx
  const dy = (2 * HH) / ny
  faces.forEach((face, fi) => {
    const keys = new Map<string, number>()
    const vert = (p: V2) => {
      const k = `${Math.round(p[0] * 1e5)}:${Math.round(p[1] * 1e5)}`
      let i = keys.get(k)
      if (i === undefined) {
        i = masks.length
        keys.set(k, i)
        pos.push(p[0], p[1], 0)
        uv.push((p[0] + HW) / (2 * HW), (p[1] + HH) / (2 * HH))
        masks.push(face.mask)
      }
      return i
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const p of face.poly) {
      minX = Math.min(minX, p[0])
      minY = Math.min(minY, p[1])
      maxX = Math.max(maxX, p[0])
      maxY = Math.max(maxY, p[1])
    }
    const i0 = Math.max(0, Math.floor((minX + HW) / dx))
    const i1 = Math.min(nx - 1, Math.floor((maxX + HW - 1e-9) / dx))
    const j0 = Math.max(0, Math.floor((minY + HH) / dy))
    const j1 = Math.min(ny - 1, Math.floor((maxY + HH - 1e-9) / dy))
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const x0 = -HW + i * dx
        const y0 = -HH + j * dy
        const c = clipBox(face.poly, x0, y0, x0 + dx, y0 + dy)
        if (c.length < 3) continue
        // drop slivers
        let area = 0
        for (let k = 0; k < c.length; k++) {
          const p = c[k]
          const q = c[(k + 1) % c.length]
          area += p[0] * q[1] - q[0] * p[1]
        }
        if (Math.abs(area) < 1e-9) continue
        const ids = c.map(vert)
        const ccw = area > 0
        for (let k = 1; k < ids.length - 1; k++) {
          if (ccw) index.push(ids[0], ids[k], ids[k + 1])
          else index.push(ids[0], ids[k + 1], ids[k])
        }
      }
    }
    void fi
  })
  const g = new THREE.BufferGeometry()
  const base = new Float32Array(pos)
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3).setUsage(THREE.DynamicDrawUsage))
  const nrm = new Float32Array(masks.length * 3)
  for (let i = 0; i < masks.length; i++) nrm[i * 3 + 2] = 1
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3).setUsage(THREE.DynamicDrawUsage))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2))
  g.setIndex(index)
  return { geometry: g, base, mask: new Uint8Array(masks), count: masks.length }
}

const _p = new THREE.Vector3()
const _n = new THREE.Vector3()

/**
 * Re-fold a mesh's vertices. `extra(i, p)` may displace the flat position
 * first (the landing flutter). Returns the folded bounding box.
 */
export function refold(
  m: { geometry: THREE.BufferGeometry; base: Float32Array; mask: Uint8Array; count: number },
  st: FoldState,
  flipNormal = false,
  extra?: (x: number, y: number) => number,
) {
  const P = m.geometry.getAttribute('position') as THREE.BufferAttribute
  const Nn = m.geometry.getAttribute('normal') as THREE.BufferAttribute
  const pa = P.array as Float32Array
  const na = Nn.array as Float32Array
  const b = m.base
  for (let i = 0; i < m.count; i++) {
    const x = b[i * 3]
    const y = b[i * 3 + 1]
    _p.set(x, y, b[i * 3 + 2] + (extra ? extra(x, y) : 0))
    _n.set(0, 0, flipNormal ? -1 : 1)
    foldPoint(_p, _n, m.mask[i], st)
    pa[i * 3] = _p.x
    pa[i * 3 + 1] = _p.y
    pa[i * 3 + 2] = _p.z
    na[i * 3] = _n.x
    na[i * 3 + 1] = _n.y
    na[i * 3 + 2] = _n.z
  }
  P.needsUpdate = true
  Nn.needsUpdate = true
}
