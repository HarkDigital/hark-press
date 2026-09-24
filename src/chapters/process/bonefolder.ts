import * as THREE from 'three'
import { inkLineMaterial, inkMaterial } from '../../print/ink'
import { ease, segment } from '../../core/math'
import { F2_Y, HH, HW, type V2 } from './fold'

/*
 * The bone folder: the maker's hand, implied. After each fold lands it comes
 * down onto the paper and burnishes the new crease (one V stroke across both
 * corner creases for folds 1 and 2, one pass along the keel for fold 3), then
 * lifts away. It lives in the sheet's own (config) space, so it rides the
 * paper wherever the paper is.
 */

const LEN = 0.7
const WID = 0.11
const THICK = 0.022

function folderGeometry() {
  // tip at the origin, body along +x: a pointed nib and a round butt
  const s = new THREE.Shape()
  const w = WID / 2
  s.moveTo(0, 0)
  s.quadraticCurveTo(0.03, w, 0.16, w)
  s.lineTo(LEN - w, w)
  s.absarc(LEN - w, 0, w, Math.PI / 2, -Math.PI / 2, true)
  s.lineTo(0.16, -w)
  s.quadraticCurveTo(0.03, -w, 0, 0)
  const g = new THREE.ExtrudeGeometry(s, { depth: THICK, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 2, curveSegments: 10 })
  g.translate(0, 0, -THICK / 2)
  return g
}

interface Stroke {
  /** local window: [press start, press end] */
  a: number
  b: number
  /** polyline in config space (z = the top of the stack) */
  path: [number, number, number][]
  /** which side of the path the tool's body trails toward (+1 / -1) */
  side: number
}

export class BoneFolder {
  group = new THREE.Group()
  private strokes: Stroke[] = []
  private m = new THREE.Matrix4()
  private x = new THREE.Vector3()
  private y = new THREE.Vector3()
  private z = new THREE.Vector3()
  private p = new THREE.Vector3()
  private q = new THREE.Vector3()

  constructor(windows: [number, number][], lagFrac: number, shadowMat?: THREE.Material) {
    const geo = folderGeometry()
    const body = new THREE.Mesh(geo, inkMaterial({ ink: [0, 0, 0.05], shadow: [0.02, 0, 0.42], lightDir: new THREE.Vector3(-0.45, 0.85, 0.5) }))
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), inkLineMaterial([0, 0, 1]))
    this.group.add(body, edges)
    if (shadowMat) {
      const sh = new THREE.Mesh(geo, shadowMat)
      sh.renderOrder = 1
      this.group.add(sh)
    }
    for (const o of this.group.children) o.frustumCulled = false
    this.group.visible = false

    // press windows start once the flap has landed (fold progress 0.68)
    const land = (a: number, b: number) => a + (b - a) * 0.66
    const [f1, f2, f3] = windows
    const L1 = (f1[1] - f1[0]) * lagFrac
    const L2 = (f2[1] - f2[0]) * lagFrac
    const v = (pts: V2[], z: number) => pts.map(([x, y]) => [x, y, z] as [number, number, number])
    this.strokes = [
      { a: land(f1[0], f1[1] - L1), b: f1[1] + 0.004, path: v([[-HW * 0.96, HH - HW * 0.96], [0, HH - 0.02], [HW * 0.96, HH - HW * 0.96]], 0.016), side: -1 },
      { a: land(f2[0], f2[1] - L2), b: f2[1] + 0.004, path: v([[-HW * 0.97, F2_Y + 0.02], [0, HH - 0.03], [HW * 0.97, F2_Y + 0.02]], 0.03), side: -1 },
      { a: land(f3[0], f3[1]), b: f3[1] + 0.006, path: v([[0.05, -HH + 0.04], [0.05, HH - 0.12]], 0.052), side: 1 },
    ]
  }

  /** Point and direction along a polyline at t (0..1, by length). */
  private along(path: [number, number, number][], t: number, out: THREE.Vector3, dir: THREE.Vector3) {
    let total = 0
    for (let i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1])
    let d = t * total
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1]
      const b = path[i]
      const seg = Math.hypot(b[0] - a[0], b[1] - a[1])
      if (d <= seg || i === path.length - 1) {
        const k = Math.min(1, d / seg)
        out.set(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)
        dir.set(b[0] - a[0], b[1] - a[1], 0).normalize()
        return
      }
      d -= seg
    }
  }

  update(l: number, t: number, calm: boolean) {
    let s: Stroke | null = null
    const IN = 0.018
    const OUT = 0.014
    for (const k of this.strokes) if (l > k.a - IN && l < k.b + OUT) s = k
    this.group.visible = !!s
    if (!s) return
    const run = ease.inOutQuad(segment(l, s.a, s.b))
    this.along(s.path, run, this.p, this.q)
    // come down onto the crease, burnish, lift away (with a hand's small wobble)
    const down = ease.outCubic(segment(l, s.a - IN, s.a))
    const up = ease.inCubic(segment(l, s.b, s.b + OUT))
    const hover = (1 - down) * 0.55 + up * 0.6
    const wob = calm ? 0 : Math.sin(t * 9.3) * 0.004
    // the body trails behind the stroke, swung off to one side, tilted up off the paper
    const tilt = 0.2 + hover * 0.6
    const swing = s.side * 0.4
    const cs = Math.cos(swing)
    const sn = Math.sin(swing)
    // back = -direction, rotated in the sheet plane by swing
    const bx = -(this.q.x * cs - this.q.y * sn)
    const by = -(this.q.x * sn + this.q.y * cs)
    this.x.set(bx * Math.cos(tilt), by * Math.cos(tilt), Math.sin(tilt)).normalize()
    this.z.set(0, 0, 1)
    this.y.crossVectors(this.z, this.x).normalize()
    this.z.crossVectors(this.x, this.y).normalize()
    this.m.makeBasis(this.x, this.y, this.z)
    this.group.quaternion.setFromRotationMatrix(this.m)
    this.group.position.set(
      this.p.x - bx * up * 0.4,
      this.p.y - by * up * 0.4,
      this.p.z + 0.012 + hover + wob + THICK * 0.5 * Math.cos(tilt),
    )
  }
}
