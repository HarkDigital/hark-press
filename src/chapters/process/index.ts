import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment, smoothstep } from '../../core/math'
import {
  B3,
  B4L,
  B4R,
  FOLDS,
  HH,
  buildCreasePattern,
  buildSheetMesh,
  foldPoint,
  foldState,
  fromConfig,
  isFlipped,
  pointInConvex,
  refold,
  toConfig,
  type Face,
  type FoldState,
  type V2,
} from './fold'
import { BLACK, GREEN, MAT, PINK, drawBack, drawFront, drawMat, drawStamp, loadPrintFonts } from './print'
import { matMaterial, planarShadowMaterial, sheetMaterial, stampMaterial } from './materials'
import { FoldHud, WING_STATS } from './hud'
import { BoneFolder } from './bonefolder'
import './process.css'

/*
 * THE FOLD — "We listen first. Then we build."
 *
 * One printed sheet on a green cutting mat, its crease pattern printed on it
 * like a fold-up template. Each process step is one fold, and each fold's
 * name is printed on the panel that moves: LISTEN on the corners, PROTOTYPE
 * up the long edges, BUILD on the half that folds over, SUPPORT under the
 * wings. The paper rolls over its creases, lands with a little springback and
 * is pressed flat; it moves "on twos" (12 fps) like stop-motion while the
 * camera stays smooth. The finished dart stands on its keel, the three stats
 * are stamped onto its wings, and it launches off the mat toward the camera
 * (Airmail picks it up gliding in).
 *
 *   0.00–0.08  the sheet is fed onto the mat (flutter, settle) under the ink flood
 *   0.10–0.625 folds 1–4: Listen · Prototype · Build · Support
 *   0.64–0.84  the wings are stamped: 10 YEARS · $1M+ · 15
 *   0.845–0.95 launch: a wind-up, then off the table past the lens into the flood
 */

const IN_END = 0.08
/** fold windows (local) — fold 1 has landed by the engine's nav landing (~0.18) */
const FW: [number, number][] = [
  [0.1, 0.2],
  [0.225, 0.335],
  [0.36, 0.47],
  [0.495, 0.625],
]
/** step 4's parts: stand on the keel, wings down, keel opens */
const STAND: [number, number] = [0.495, 0.555]
const WINGS: [number, number] = [0.535, 0.61]
const KEEL: [number, number] = [0.585, 0.625]
const STAMP_AT = [0.65, 0.685, 0.72]
const LAUNCH: [number, number] = [0.845, 0.955]
/** keyboard stops: each fold landed with its card open */
const ANCHORS = [0.19, 0.325, 0.46, 0.62]

const DEG = Math.PI / 180
/** the plane's heading once it's flying (nose toward camera-right) */
const HERO_YAW = -125 * DEG
const WING_ANGLE = 80 * DEG
const KEEL_OPEN = 0.1

/** Yield a frame between heavy init steps (rAF never fires in a hidden tab, so time out too). */
const yieldFrame = () =>
  new Promise<void>(resolve => {
    let done = false
    const go = () => {
      if (!done) {
        done = true
        resolve()
      }
    }
    if (typeof document !== 'undefined' && document.hidden) {
      setTimeout(go, 0)
      return
    }
    requestAnimationFrame(go)
    setTimeout(go, 120)
  })

// ------------------------------------------------------------------ fold timing

/** Fold angle over a fold's own progress: roll over, land, spring back, pressed. */
function foldAngle(p: number) {
  if (p <= 0) return 0
  if (p < 0.68) {
    const x = p / 0.68
    return Math.PI * (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)
  }
  const y = clamp((p - 0.68) / 0.32)
  return Math.PI - 0.2 * Math.sin(Math.PI * y) * (1 - y)
}
/** soft roll while travelling, zero once pressed */
const foldRoll = (p: number, soft: number) => soft * Math.sin(Math.PI * clamp(p / 0.68))

function setFolds(st: FoldState, l: number) {
  const pair = (i: number, [a, b]: [number, number], soft: number) => {
    const lag = (b - a) * 0.16
    const pL = segment(l, a, b - lag)
    const pR = segment(l, a + lag, b)
    st.theta[i] = foldAngle(pL)
    st.rho[i] = foldRoll(pL, soft)
    st.theta[i + 1] = foldAngle(pR)
    st.rho[i + 1] = foldRoll(pR, soft)
  }
  pair(0, FW[0], 0.42)
  pair(2, FW[1], 0.5)
  const p3 = segment(l, FW[2][0], FW[2][1])
  st.theta[4] = foldAngle(p3)
  st.rho[4] = foldRoll(p3, 0.8)
  // wings: down past square, then settle to the dihedral
  const lagW = (WINGS[1] - WINGS[0]) * 0.18
  const wR = segment(l, WINGS[0], WINGS[1] - lagW)
  const wL = segment(l, WINGS[0] + lagW, WINGS[1])
  const wing = (p: number) => {
    if (p <= 0) return 0
    if (p < 0.7) return WING_ANGLE * 1.12 * ease.inOutCubic(p / 0.7)
    return lerp(WING_ANGLE * 1.12, WING_ANGLE, ease.outCubic((p - 0.7) / 0.3))
  }
  st.theta[5] = wing(wR)
  st.rho[5] = 0.25 * Math.sin(Math.PI * clamp(wR / 0.7))
  st.theta[6] = wing(wL)
  st.rho[6] = 0.25 * Math.sin(Math.PI * clamp(wL / 0.7))
  st.keel = KEEL_OPEN * ease.outBack(segment(l, KEEL[0], KEEL[1]))
}

// ------------------------------------------------------------------ stamps

interface StampDef {
  value: string
  ink: string
  /** which wing: R = the half that stays put, L = the half that folds over */
  half: 'L' | 'R'
  /** centre, reading direction and cap direction in the folded-half config */
  q: V2
  dirX: V2
  dirUp: V2
  w: number
  h: number
  at: number
}

interface Stamp {
  def: StampDef
  mesh: THREE.Mesh
  mat: THREE.ShaderMaterial
  mask: number
  c: V2
  dx: V2
  du: V2
  zSign: number
  base: number
}

const STAMPS: StampDef[] = [
  { value: WING_STATS[0].value, ink: PINK, half: 'R', q: [0.62, -0.84], dirX: [0, 1], dirUp: [-1, 0], w: 0.66, h: 0.25, at: STAMP_AT[0] },
  { value: WING_STATS[1].value, ink: GREEN, half: 'L', q: [0.62, -0.84], dirX: [0, 1], dirUp: [1, 0], w: 0.6, h: 0.25, at: STAMP_AT[1] },
  { value: WING_STATS[2].value, ink: BLACK, half: 'R', q: [0.43, -0.2], dirX: [0, 1], dirUp: [-1, 0], w: 0.3, h: 0.19, at: STAMP_AT[2] },
]

function buildStamp(def: StampDef, i: number, faces: Face[], aniso: number): Stamp {
  const st3 = foldState()
  for (let k = 0; k < 5; k++) st3.theta[k] = Math.PI
  const wingBit = def.half === 'R' ? B4R : B4L
  let host: Face | null = null
  let best = def.half === 'R' ? -Infinity : Infinity
  const p = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (const f of faces) {
    if (!(f.mask & wingBit)) continue
    const cfg = f.poly.map(v => toConfig(f, v))
    if (!pointInConvex(cfg, def.q)) continue
    const flat = fromConfig(f, def.q)
    p.set(flat[0], flat[1], 0)
    n.set(0, 0, 1)
    // heights after folds 1–3 only (mask the wing bits out)
    foldPoint(p, n, f.mask & ~(B4L | B4R), st3)
    if (def.half === 'R' ? p.z > best : p.z < best) {
      best = p.z
      host = f
    }
  }
  if (!host) throw new Error(`stamp ${def.value}: no wing face under it`)
  const flipped = isFlipped(host)
  const zSign = def.half === 'R' ? (flipped ? -1 : 1) : flipped ? 1 : -1
  const c = fromConfig(host, def.q)
  const cx = fromConfig(host, [def.q[0] + def.dirX[0], def.q[1] + def.dirX[1]])
  const cu = fromConfig(host, [def.q[0] + def.dirUp[0], def.q[1] + def.dirUp[1]])
  const canvas = drawStamp(def.value, def.ink, i, def.w / def.h > 2 ? 640 : 420, 256)
  const mat = stampMaterial(canvas, aniso)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3).setUsage(THREE.DynamicDrawUsage))
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2))
  g.setIndex([0, 1, 2, 0, 2, 3])
  const mesh = new THREE.Mesh(g, mat)
  mesh.frustumCulled = false
  mesh.renderOrder = 3
  mesh.visible = false
  return {
    def,
    mesh,
    mat,
    mask: host.mask,
    c,
    dx: [cx[0] - c[0], cx[1] - c[1]],
    du: [cu[0] - c[0], cu[1] - c[1]],
    zSign,
    base: 0.024,
  }
}

const _sp = new THREE.Vector3()
const _sn = new THREE.Vector3()
const CORNERS: V2[] = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
]

function placeStamp(s: Stamp, st: FoldState, lift: number, scale: number) {
  const pos = s.mesh.geometry.getAttribute('position') as THREE.BufferAttribute
  const a = pos.array as Float32Array
  CORNERS.forEach(([u, v], k) => {
    const x = s.c[0] + (s.dx[0] * u * s.def.w + s.du[0] * v * s.def.h) * scale
    const y = s.c[1] + (s.dx[1] * u * s.def.w + s.du[1] * v * s.def.h) * scale
    _sp.set(x, y, s.zSign * (s.base + lift))
    _sn.set(0, 0, s.zSign)
    foldPoint(_sp, _sn, s.mask, st)
    a[k * 3] = _sp.x
    a[k * 3 + 1] = _sp.y
    a[k * 3 + 2] = _sp.z
  })
  pos.needsUpdate = true
}

// ------------------------------------------------------------------ camera

interface Shot {
  t: number
  p: [number, number, number]
  az: number
  el: number
  /** world size of the subject to fit into the free band */
  w: number
  h: number
  fov: number
  e?: (t: number) => number
}

const inOutSine = (t: number) => 0.5 - 0.5 * Math.cos(Math.PI * t)

/** Landscape: the sheet to the right of the copy column, looking down; the plane at 3/4. */
const WIDE: Shot[] = [
  { t: 0, p: [0.1, 0, -0.1], az: -22, el: 70, w: 3.3, h: 3.2, fov: 30 },
  { t: 0.09, p: [0, 0, 0], az: -14, el: 60, w: 2.5, h: 2.75, fov: 30, e: ease.outCubic },
  { t: 0.21, p: [0, 0, -0.05], az: -10, el: 57, w: 2.4, h: 2.7, fov: 30, e: inOutSine },
  { t: 0.345, p: [0, 0, 0.05], az: -6, el: 55, w: 2.3, h: 2.6, fov: 30, e: inOutSine },
  { t: 0.48, p: [0.45, 0, 0.05], az: -4, el: 54, w: 1.9, h: 2.6, fov: 30, e: inOutSine },
  { t: 0.57, p: [0.15, 0.75, 0.25], az: -16, el: 46, w: 2.9, h: 2.3, fov: 30, e: ease.inOutCubic },
  { t: 0.64, p: [0.25, 0.85, 0.34], az: -12, el: 50, w: 2.75, h: 2.0, fov: 30, e: inOutSine },
  { t: 0.845, p: [0.25, 0.85, 0.34], az: -19, el: 48, w: 2.7, h: 1.95, fov: 30, e: (t: number) => t },
  { t: 0.94, p: [0.35, 0.9, 0.45], az: -17, el: 45, w: 2.9, h: 2.1, fov: 32, e: ease.inOutCubic },
  { t: 1, p: [0.4, 0.9, 0.5], az: -16, el: 44, w: 3.0, h: 2.2, fov: 32, e: (t: number) => t },
]

/** Portrait: the sheet between the headline and the card. */
const TALL: Shot[] = [
  { t: 0, p: [0.1, 0, -0.1], az: -18, el: 72, w: 2.8, h: 3.0, fov: 38 },
  { t: 0.09, p: [0, 0, 0], az: -10, el: 62, w: 2.25, h: 2.55, fov: 38, e: ease.outCubic },
  { t: 0.21, p: [0, 0, -0.05], az: -8, el: 60, w: 2.2, h: 2.5, fov: 38, e: inOutSine },
  { t: 0.345, p: [0, 0, 0.05], az: -5, el: 58, w: 2.1, h: 2.45, fov: 38, e: inOutSine },
  { t: 0.48, p: [0.45, 0, 0.05], az: -3, el: 58, w: 1.6, h: 2.4, fov: 38, e: inOutSine },
  { t: 0.57, p: [0.15, 0.75, 0.25], az: -16, el: 50, w: 2.6, h: 2.1, fov: 38, e: ease.inOutCubic },
  { t: 0.64, p: [0.0, 0.85, 0.16], az: -12, el: 54, w: 2.95, h: 1.7, fov: 38, e: inOutSine },
  { t: 0.845, p: [0.0, 0.85, 0.16], az: -19, el: 51, w: 2.9, h: 1.65, fov: 38, e: (t: number) => t },
  { t: 0.94, p: [0.35, 0.9, 0.45], az: -17, el: 48, w: 2.8, h: 2.1, fov: 40, e: ease.inOutCubic },
  { t: 1, p: [0.4, 0.9, 0.5], az: -16, el: 47, w: 2.9, h: 2.2, fov: 40, e: (t: number) => t },
]

function shotAt(keys: Shot[], l: number, out: Shot) {
  let i = 1
  while (i < keys.length - 1 && l > keys[i].t) i++
  const a = keys[i - 1]
  const b = keys[i]
  const k = (b.e ?? ease.inOutCubic)(segment(l, a.t, b.t))
  for (let j = 0; j < 3; j++) out.p[j] = lerp(a.p[j], b.p[j], k)
  out.az = lerp(a.az, b.az, k)
  out.el = lerp(a.el, b.el, k)
  out.w = lerp(a.w, b.w, k)
  out.h = lerp(a.h, b.h, k)
  out.fov = lerp(a.fov, b.fov, k)
  return out
}

const _dir = new THREE.Vector3()
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()

/** Place the camera so the subject (w × h world units) fills the free band in px. */
function applyShot(s: Shot, W: number, H: number, band: { l: number; r: number; t: number; b: number }, out: CameraPose) {
  const aspect = W / Math.max(1, H)
  const tv = Math.tan((s.fov * DEG) / 2)
  const th = tv * aspect
  const wn = Math.max(0.2, ((band.r - band.l) / W) * 2)
  const hn = Math.max(0.2, ((band.b - band.t) / H) * 2)
  const dist = Math.max(s.w / (th * wn), s.h / (tv * hn))
  const sx = (band.l + band.r) / W - 1
  const sy = 1 - (band.t + band.b) / H
  const az = s.az * DEG
  const el = s.el * DEG
  _dir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el))
  _right.set(Math.cos(az), 0, -Math.sin(az))
  _up.crossVectors(_dir, _right)
  out.target
    .set(s.p[0], s.p[1], s.p[2])
    .addScaledVector(_right, -sx * dist * th)
    .addScaledVector(_up, -sy * dist * tv)
  out.position.copy(out.target).addScaledVector(_dir, dist)
  out.fov = s.fov
}

// ------------------------------------------------------------------ chapter

export default function create(): Chapter {
  const group = new THREE.Group()
  const planeRoot = new THREE.Group()
  const lie = new THREE.Group()
  const stand = new THREE.Group()
  lie.rotation.x = -Math.PI / 2
  planeRoot.add(lie)
  lie.add(stand)
  group.add(planeRoot)

  let sheet: ReturnType<typeof buildSheetMesh>
  let sheetMesh: THREE.Mesh
  let stamps: Stamp[] = []
  let folder: BoneFolder | null = null
  let hud: FoldHud
  const st = foldState()
  let lastFold = -1
  let held = -1
  let heldTick = -1
  let flutterAmp = 0
  let flutterPhase = 0
  const shot: Shot = { t: 0, p: [0, 0, 0], az: 0, el: 0, w: 1, h: 1, fov: 30 }
  const nose = new THREE.Vector3()

  /** free screen band for the subject, px (kept current by the HUD layout) */
  const band = { l: 0, r: 1, t: 0, b: 1 }
  const bandStats = { l: 0, r: 1, t: 0, b: 1 }
  const bandNow = { l: 0, r: 1, t: 0, b: 1 }
  let shortPortrait = false

  const flutter = (x: number, y: number) =>
    flutterAmp * (Math.sin(2.3 * y - flutterPhase) * 0.8 + Math.sin(2.9 * x + flutterPhase * 0.7) * 0.35) * (0.6 + 0.4 * (y / HH + 1))

  /** Plane (sheet) pose in the world, from the held local. */
  function pose(l: number, t: number, calm: boolean) {
    // in: fed across the mat from upper right, settling with a small overshoot
    const inP = segment(l, 0, IN_END)
    const inE = ease.outBack(inP)
    const x0 = 2.9
    const z0 = -2.4
    let px = lerp(x0, 0, inE)
    let pz = lerp(z0, 0, inE)
    let py = 0.03 + (1 - ease.outCubic(inP)) * 0.7
    let yaw = lerp(34 * DEG, 0, ease.outCubic(inP))
    let pitch = 0
    let roll = 0

    // step 4: stand on the keel and lift off the mat, turning to its heading
    const sp = ease.inOutCubic(segment(l, STAND[0], STAND[1]))
    const lift = ease.outBack(segment(l, STAND[0] + 0.01, STAND[1] + 0.03))
    stand.rotation.y = -Math.PI / 2 * sp
    py += lift * 0.82
    yaw = lerp(yaw, HERO_YAW, ease.inOutCubic(segment(l, STAND[0] + 0.005, WINGS[1])))
    px += lift * 0.08
    pz += lift * 0.2

    // hover: a paper plane held on a breath of air (on twos, like everything paper)
    const hover = smoothstep(STAND[1], WINGS[1], l) * (1 - smoothstep(LAUNCH[0], LAUNCH[0] + 0.02, l))
    if (!calm && hover > 0) {
      py += Math.sin(t * 1.7) * 0.035 * hover
      roll += Math.sin(t * 1.25 + 0.6) * 0.045 * hover
      pitch += Math.sin(t * 1.05) * 0.03 * hover
    }
    // stamp hits: a little dip each time a stamp lands
    for (const at of STAMP_AT) {
      const k = l - at - 0.012
      if (k > 0 && k < 0.03) py -= Math.sin((k / 0.03) * Math.PI) * 0.05 * (1 - k / 0.03)
    }

    // launch: pull back (anticipation), then off past the camera
    const a = segment(l, LAUNCH[0], LAUNCH[0] + 0.03)
    const b = segment(l, LAUNCH[0] + 0.025, LAUNCH[1])
    // wind up turning toward the camera, then go: banked into the turn (near
    // wing down, so the stamped tops face us) and growing past the lens
    yaw -= 0.42 * ease.inOutCubic(a) + 0.22 * b
    nose.set(-Math.sin(yaw), 0, -Math.cos(yaw))
    const back = Math.sin(Math.PI * a) * 0.3 * (1 - b)
    const fly = b * b * 7 + b * 0.8
    px += nose.x * (fly - back)
    pz += nose.z * (fly - back)
    py += b * 0.75 - b * b * 0.2
    pitch += 0.18 * Math.sin(Math.PI * a) * (1 - b) + 0.04 * b
    roll -= 0.32 * Math.sin(Math.PI * a) * (1 - b) + 0.22 * Math.sin(Math.PI * Math.min(1, b * 1.3))

    planeRoot.position.set(px, py, pz)
    planeRoot.rotation.set(0, 0, 0)
    planeRoot.rotateY(yaw)
    planeRoot.rotateX(pitch)
    planeRoot.rotateZ(roll)
    // landing flutter (the only non-rigid motion before the first fold)
    flutterAmp = 0.16 * Math.pow(1 - inP, 2)
    flutterPhase = inP * 9
  }

  return {
    id: 'process',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      const mobile = ctx.mobile
      const aniso = Math.min(8, ctx.renderer.capabilities.getMaxAnisotropy())
      hud = new FoldHud(ctx.stage)
      await loadPrintFonts()
      const { faces, creases } = buildCreasePattern()
      sheet = buildSheetMesh(faces, mobile ? 0.075 : 0.055)
      await yieldFrame()

      const S = mobile ? 360 : 512
      const front = drawFront(creases, S)
      await yieldFrame()
      const back = drawBack(S)
      await yieldFrame()
      const mat = drawMat(mobile ? 200 : 280)
      await yieldFrame()

      sheetMesh = new THREE.Mesh(sheet.geometry, sheetMaterial(front, back, aniso))
      sheetMesh.frustumCulled = false
      sheetMesh.renderOrder = 2
      stand.add(sheetMesh)

      const shadow = new THREE.Mesh(sheet.geometry, planarShadowMaterial())
      shadow.frustumCulled = false
      shadow.renderOrder = 1
      stand.add(shadow)

      const matMesh = new THREE.Mesh(new THREE.PlaneGeometry(MAT.w, MAT.h), matMaterial(mat, aniso))
      matMesh.rotation.x = -Math.PI / 2
      matMesh.renderOrder = 0
      group.add(matMesh)

      stamps = STAMPS.map((d, i) => buildStamp(d, i, faces, aniso))
      for (const s of stamps) stand.add(s.mesh)

      folder = new BoneFolder(FW.slice(0, 3), 0.16, planarShadowMaterial())
      stand.add(folder.group)

      // keep the subject's free band in step with where the copy actually is
      const measure = () => {
        const W = ctx.stage.clientWidth || window.innerWidth
        const H = ctx.stage.clientHeight || window.innerHeight
        const r = hud.layout(W, H)
        Object.assign(band, r.steps)
        Object.assign(bandStats, r.stats)
        shortPortrait = r.short
      }
      if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(measure)
        ro.observe(ctx.stage)
        for (const n of hud.measured()) ro.observe(n)
      }
      window.addEventListener('resize', measure)
      measure()
      void FOLDS
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const calm = frame.reducedMotion
      // paper moves on twos: sample the scroll at 12 fps (jumps snap at once)
      const tick = Math.floor(frame.time * 12)
      if (calm || held < 0 || Math.abs(local - held) > 0.04 || tick !== heldTick) {
        held = local
        heldTick = tick
      }
      const l = held
      const tHeld = heldTick / 12

      pose(l, tHeld, calm)
      if (l !== lastFold) {
        setFolds(st, l)
        refold(sheet, st, false, flutterAmp > 1e-4 ? flutter : undefined)
        lastFold = l
      }
      folder?.update(l, tHeld, calm)

      // stamps: slam down, squash, ink bites
      let kick = 0
      for (const s of stamps) {
        const k = segment(l, s.def.at, s.def.at + 0.024)
        s.mesh.visible = k > 0 && l < LAUNCH[1] + 0.02
        if (!s.mesh.visible) continue
        const fall = clamp(k / 0.45)
        const drop = (1 - fall * fall) * 0.45
        const settle = clamp((k - 0.45) / 0.55)
        const scale = k < 0.45 ? lerp(1.35, 1, fall * fall) : 1 + 0.06 * Math.sin(Math.PI * settle) * (1 - settle)
        s.mat.uniforms.uInk.value = k < 0.45 ? 0.35 * fall : 1
        placeStamp(s, st, drop, scale)
        const since = local - (s.def.at + 0.024 * 0.45)
        if (since > 0) kick = Math.max(kick, Math.exp(-since * 90))
      }

      // press: a touch coarser than default, drums jolt when a stamp hits
      const p = ctx.post.params
      p.cell = 5.5
      if (calm) kick = 0
      p.misreg = 1.4 + kick * 3.2
      p.grain = 0.5
      p.glitch = kick * 0.25

      // HUD
      let step = -1
      for (let i = 0; i < 4; i++) if (local >= FW[i][0] - 0.012) step = i
      if (local >= KEEL[1] + 0.008) step = -1
      let done = 0
      for (let i = 0; i < 4; i++) if (local >= FW[i][1] - 0.01) done = i + 1
      hud.update({
        // short phones give the headline's room to the stats once the plane is done
        head: local > 0.045 && local < 0.93 && !(shortPortrait && local >= KEEL[1] + 0.008),
        step,
        done,
        steps: local >= FW[0][0] - 0.012 && step >= 0,
        stats: STAMP_AT.map(a => local >= a + 0.011 && local < 0.93),
        statsOn: local >= STAMP_AT[0] - 0.012 && local < 0.93,
      })
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const W = Math.max(1, frame.width)
      const H = Math.max(1, frame.height)
      const tall = W / H < 0.8
      shotAt(tall ? TALL : WIDE, local, shot)
      if (!frame.reducedMotion) {
        shot.az += Math.sin(frame.time * 0.16) * 0.8
        shot.el += Math.sin(frame.time * 0.12 + 1) * 0.5
      }
      // the free band moves from the card's to the stats' as the plane finishes
      const k = smoothstep(KEEL[1] - 0.01, STAMP_AT[0], local)
      bandNow.l = lerp(band.l, bandStats.l, k)
      bandNow.r = lerp(band.r, bandStats.r, k)
      bandNow.t = lerp(band.t, bandStats.t, k)
      bandNow.b = lerp(band.b, bandStats.b, k)
      applyShot(shot, W, H, bandNow, out)
      out.roll = 0
      out.parallax = 0.1
    },

    onEnter() {
      held = -1
      lastFold = -1
    },
  }
}
