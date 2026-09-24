import * as THREE from 'three'

/*
 * A paper DART folded from the postcard itself (3 × 2 units, nose at +x,
 * side A = the message side = +z in sheet space).
 *
 * The folds are modelled as a sequence of rigid hinge rotations. At build
 * time every op is applied FULLY (π) to a stack of flat facets, splitting
 * each facet along the op's crease (its pre-image in that facet), which
 * gives us: the facet polygons (convex, in flat sheet coords), which ops
 * move each facet, and each op's 3D hinge axis in the frame it was folded
 * in. At render time the ops are replayed in order with arbitrary angles:
 * exact for any pose where only the most recent folds are partial, which is
 * how paper is really unfolded (last fold first).
 *
 * Order (the -y wing is creased before the centre fold so the keel can
 * open a little in flight without tearing):
 *   0 F1+  1 F1-   top corners to the centre line
 *   2 F2+  3 F2-   the new edges to the centre line again
 *   4 W-          the -y wing crease (folded under, toward side B)
 *   5 F3          the centre fold (the -y half over onto the +y half)
 *   6 W+          the +y wing crease (folded under)
 *
 * Folded, sheet +y is the plane's up (keel along y = 0), x is forward and
 * the wings open along ±z.
 */

export const SHEET_W = 3
export const SHEET_H = 2
const HW = SHEET_W / 2
const HH = SHEET_H / 2
/** keel height (wing crease distance from the centre fold) */
export const KEEL = 0.3
/** layer spacing so stacked paper never z-fights */
const EPS = 0.0025

type V2 = [number, number]

interface Iso {
  a: number
  b: number
  c: number
  d: number
  tx: number
  ty: number
}

interface Op {
  p: V2
  dir: V2
  /** moving side: sign(cross(dir, x - p)) === side */
  side: 1 | -1
  /** fold toward +z (1) or -z (-1) */
  up: 1 | -1
  /**
   * which facets the op touches: 'skip' leaves it, 'split' cuts it along the
   * crease and moves the part on the moving side, 'move' moves it whole
   */
  select?: (f: Facet) => 'skip' | 'split' | 'move'
  h: number
  /** mountain (+1) / valley (-1) as seen from side A once unfolded */
  relief: number
}

interface Facet {
  poly: V2[]
  iso: Iso
  mask: number
  z: number
}

export interface Crease {
  a: V2
  b: V2
  op: number
  relief: number
}

const cross = (ax: number, ay: number, bx: number, by: number) => ax * by - ay * bx
const applyIso = (m: Iso, x: number, y: number): V2 => [m.a * x + m.b * y + m.tx, m.c * x + m.d * y + m.ty]
function invIso(m: Iso): Iso {
  // isometries: inverse linear part = transpose
  const a = m.a,
    b = m.c,
    c = m.b,
    d = m.d
  return { a, b, c, d, tx: -(a * m.tx + b * m.ty), ty: -(c * m.tx + d * m.ty) }
}
function reflectIso(p: V2, dir: V2): Iso {
  // reflection across the line through p with unit direction dir
  const [dx, dy] = dir
  const a = 2 * dx * dx - 1,
    b = 2 * dx * dy,
    c = 2 * dx * dy,
    d = 2 * dy * dy - 1
  return { a, b, c, d, tx: p[0] - (a * p[0] + b * p[1]), ty: p[1] - (c * p[0] + d * p[1]) }
}
function mulIso(m: Iso, n: Iso): Iso {
  // m ∘ n
  return {
    a: m.a * n.a + m.b * n.c,
    b: m.a * n.b + m.b * n.d,
    c: m.c * n.a + m.d * n.c,
    d: m.c * n.b + m.d * n.d,
    tx: m.a * n.tx + m.b * n.ty + m.tx,
    ty: m.c * n.tx + m.d * n.ty + m.ty,
  }
}
const area = (poly: V2[]) => {
  let s = 0
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i],
      q = poly[(i + 1) % poly.length]
    s += p[0] * q[1] - q[0] * p[1]
  }
  return s / 2
}
const centroid = (poly: V2[]): V2 => {
  let x = 0,
    y = 0
  for (const p of poly) {
    x += p[0]
    y += p[1]
  }
  return [x / poly.length, y / poly.length]
}

/** split a convex polygon by a line; returns [left (cross>0), right] (either may be null) */
function split(poly: V2[], p: V2, dir: V2): { l: V2[] | null; r: V2[] | null; seg: V2[] } {
  const s = poly.map(v => cross(dir[0], dir[1], v[0] - p[0], v[1] - p[1]))
  const l: V2[] = []
  const r: V2[] = []
  const seg: V2[] = []
  const e = 1e-7
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length
    const a = poly[i],
      b = poly[j]
    const sa = s[i],
      sb = s[j]
    if (sa >= -e) l.push(a)
    if (sa <= e) r.push(a)
    if ((sa > e && sb < -e) || (sa < -e && sb > e)) {
      const t = sa / (sa - sb)
      const m: V2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]
      l.push(m)
      r.push(m)
      seg.push(m)
    } else if (Math.abs(sa) <= e) seg.push(a)
  }
  const ok = (q: V2[]) => q.length >= 3 && Math.abs(area(q)) > 1e-6
  return { l: ok(l) ? l : null, r: ok(r) ? r : null, seg }
}

/** the half of the ORIGINAL sheet a facet came from (folds never move paper across the centre line) */
const upper = (f: Facet) => centroid(f.poly)[1] > 0
const onlyUpper = (f: Facet) => (upper(f) ? 'split' : 'skip') as 'split' | 'skip'
const onlyLower = (f: Facet) => (upper(f) ? 'skip' : 'split') as 'split' | 'skip'

function buildOps(): Op[] {
  const N: V2 = [HW, 0]
  const c22 = Math.cos(Math.PI / 8),
    s22 = Math.sin(Math.PI / 8)
  const r2 = Math.SQRT1_2
  return [
    { p: N, dir: [-r2, r2], side: -1, up: 1, h: 0, relief: -1, select: onlyUpper },
    { p: N, dir: [-r2, -r2], side: 1, up: 1, h: 0, relief: -1, select: onlyLower },
    { p: N, dir: [-c22, s22], side: -1, up: 1, h: 0, relief: -1, select: onlyUpper },
    { p: N, dir: [-c22, -s22], side: 1, up: 1, h: 0, relief: -1, select: onlyLower },
    { p: [0, -KEEL], dir: [1, 0], side: -1, up: -1, h: 0, relief: 1, select: onlyLower },
    // the centre fold takes the whole lower half, including its (already creased) wing
    {
      p: [0, 0],
      dir: [1, 0],
      side: -1,
      up: 1,
      h: 0,
      relief: -1,
      select: f => (upper(f) ? 'skip' : 'move'),
    },
    { p: [0, KEEL], dir: [1, 0], side: 1, up: -1, h: 0, relief: 1, select: f => (f.mask & (1 << 5) ? 'skip' : 'split') },
  ]
}

export const OP_COUNT = 7

export interface FoldModel {
  geometry: THREE.BufferGeometry
  creases: Crease[]
  /** write the pose for these op angles (radians, 0 = flat, π = folded) */
  pose(angles: ArrayLike<number>): void
}

export function buildFold(): FoldModel {
  const ops = buildOps()
  // the sheet starts as its two halves (the centre crease is the first thing you make)
  const id: Iso = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
  let facets: Facet[] = [
    {
      poly: [
        [-HW, 0],
        [HW, 0],
        [HW, HH],
        [-HW, HH],
      ],
      iso: id,
      mask: 0,
      z: 0,
    },
    {
      poly: [
        [-HW, -HH],
        [HW, -HH],
        [HW, 0],
        [-HW, 0],
      ],
      iso: id,
      mask: 0,
      z: 0,
    },
  ]
  const creases: Crease[] = [{ a: [-HW, 0], b: [HW, 0], op: 5, relief: -1 }]

  ops.forEach((op, k) => {
    let zmax = -Infinity,
      zmin = Infinity
    for (const f of facets) {
      if (op.select && op.select(f) === 'skip') continue
      zmax = Math.max(zmax, f.z)
      zmin = Math.min(zmin, f.z)
    }
    op.h = op.up > 0 ? zmax + EPS / 2 : zmin - EPS / 2
    const R = reflectIso(op.p, op.dir)
    const next: Facet[] = []
    for (const f of facets) {
      const mode = op.select ? op.select(f) : 'split'
      if (mode === 'skip') {
        next.push(f)
        continue
      }
      if (mode === 'move') {
        next.push({ poly: f.poly, iso: mulIso(R, f.iso), mask: f.mask | (1 << k), z: 2 * op.h - f.z })
        continue
      }
      const inv = invIso(f.iso)
      const p = applyIso(inv, op.p[0], op.p[1])
      const q = applyIso(inv, op.p[0] + op.dir[0], op.p[1] + op.dir[1])
      const dir: V2 = [q[0] - p[0], q[1] - p[1]]
      const { l, r, seg } = split(f.poly, p, dir)
      const parts = [l, r].filter(Boolean) as V2[][]
      if (parts.length === 2 && seg.length >= 2) creases.push({ a: seg[0], b: seg[1], op: k, relief: op.relief })
      for (const part of parts) {
        const c = centroid(part)
        const w = applyIso(f.iso, c[0], c[1])
        const s = cross(op.dir[0], op.dir[1], w[0] - op.p[0], w[1] - op.p[1])
        const moving = Math.sign(s) === op.side
        if (moving) next.push({ poly: part, iso: mulIso(R, f.iso), mask: f.mask | (1 << k), z: 2 * op.h - f.z })
        else next.push({ poly: part, iso: f.iso, mask: f.mask, z: f.z })
      }
    }
    facets = next
  })

  // geometry: each facet fan-triangulated, vertices duplicated per facet
  const verts: number[] = []
  const uvs: number[] = []
  const owner: number[] = []
  const index: number[] = []
  facets.forEach((f, fi) => {
    const base = verts.length / 3
    // keep CCW in flat space so the front face is side A
    const poly = area(f.poly) < 0 ? [...f.poly].reverse() : f.poly
    for (const v of poly) {
      verts.push(v[0], v[1], 0)
      uvs.push((v[0] + HW) / SHEET_W, (v[1] + HH) / SHEET_H)
      owner.push(fi)
    }
    for (let i = 1; i < poly.length - 1; i++) index.push(base, base + i, base + i + 1)
  })
  const flat = new Float32Array(verts)
  const geometry = new THREE.BufferGeometry()
  const pos = new THREE.BufferAttribute(new Float32Array(flat), 3)
  pos.setUsage(THREE.DynamicDrawUsage)
  const nor = new THREE.BufferAttribute(new Float32Array(flat.length), 3)
  nor.setUsage(THREE.DynamicDrawUsage)
  geometry.setAttribute('position', pos)
  geometry.setAttribute('normal', nor)
  geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uvs), 2))
  geometry.setIndex(index)

  // hinge axes (3D, in the frame each op folded in)
  const axes = ops.map(op => ({
    p: new THREE.Vector3(op.p[0], op.p[1], op.h),
    d: new THREE.Vector3(op.dir[0], op.dir[1], 0).normalize(),
    sign: op.side * op.up,
  }))
  const mats = facets.map(() => new THREE.Matrix4())
  const nmats = facets.map(() => new THREE.Matrix3())
  const R = new THREE.Matrix4()
  const T = new THREE.Matrix4()
  const Ti = new THREE.Matrix4()
  const opM = ops.map(() => new THREE.Matrix4())
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()

  function pose(angles: ArrayLike<number>) {
    for (let k = 0; k < ops.length; k++) {
      const ax = axes[k]
      const th = (angles[k] ?? 0) * ax.sign
      T.makeTranslation(ax.p.x, ax.p.y, ax.p.z)
      Ti.makeTranslation(-ax.p.x, -ax.p.y, -ax.p.z)
      R.makeRotationAxis(ax.d, th)
      opM[k].multiplyMatrices(T, R).multiply(Ti)
    }
    for (let fi = 0; fi < facets.length; fi++) {
      const m = mats[fi].identity()
      const mask = facets[fi].mask
      for (let k = 0; k < ops.length; k++) if (mask & (1 << k)) m.premultiply(opM[k])
      nmats[fi].setFromMatrix4(m)
    }
    const P = pos.array as Float32Array
    const Nn = nor.array as Float32Array
    for (let i = 0; i < owner.length; i++) {
      const fi = owner[i]
      v.set(flat[i * 3], flat[i * 3 + 1], 0).applyMatrix4(mats[fi])
      P[i * 3] = v.x
      P[i * 3 + 1] = v.y
      P[i * 3 + 2] = v.z
      n.set(0, 0, 1).applyMatrix3(nmats[fi]).normalize()
      Nn[i * 3] = n.x
      Nn[i * 3 + 1] = n.y
      Nn[i * 3 + 2] = n.z
    }
    pos.needsUpdate = true
    nor.needsUpdate = true
  }

  pose(new Float32Array(ops.length))
  // the dart never leaves this sphere (meshes also opt out of culling)
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2)
  return { geometry, creases, pose }
}
