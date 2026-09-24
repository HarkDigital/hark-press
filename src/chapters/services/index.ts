import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, ease, lerp, segment } from '../../core/math'
import { SERVICES } from '../../content'
import { CASE_D, CASE_W, Press, TH, Z_CHASE } from './press'
import { Hud, type HudMetrics } from './hud'
import { ANCHORS, OUT_START, PH, jobAt, jobLen, jobStart, type JobPhase } from './timeline'
import { loadWoodFace } from './atlas'
import './services.css'

/*
 * TYPE CASE — services as a letterpress job (3.6 viewport heights).
 * See timeline.ts for the run sheet and press.ts for the bench.
 *
 * The camera works in four set-ups so eleven jobs read as four scenes:
 *   01–03  flat lay, straight down on the case and the chase
 *   04–06  low along the chase, the case rising behind the line
 *   07–09  close on the forme, trucking along the line
 *   10–11  high three-quarter from the right, the hops in profile
 * then square on for HARK, and down into the green ink for the cut.
 * Each set-up is solved every frame so the bench lands in the space the
 * HUD leaves free, at any aspect ratio.
 */

const SHOT_KEYS = ['az', 'el', 'fov', 'x0', 'x1', 'z0', 'z1', 'y1', 'sw', 'ax', 'ay', 'sx', 'fw', 'ic', 'fb'] as const
type Shot = Record<(typeof SHOT_KEYS)[number], number>
const S = (o: Partial<Shot>): Shot => ({
  az: 0,
  el: 1.2,
  fov: 28,
  x0: -5,
  x1: 5,
  z0: 0,
  z1: 4,
  y1: TH,
  sw: 1,
  ax: 0,
  ay: 0,
  sx: 1,
  fw: 0,
  ic: 0,
  fb: 0,
  ...o,
})

interface Region {
  l: number
  r: number
  b: number
  t: number
}

/** the camera has pulled back from the ink slab to the case (local) */
const INTRO_AT = 0.056
/** the intro title stamps in (local): the pull-back is ~97% done */
const INTRO_ON = 0.05
/** the intro frame holds to here (past the chapter's nav landing at 0.08) */
const INTRO_HOLD = 0.082

const N_PTS = 8
const _pa = new Float64Array(N_PTS)
const _pb = new Float64Array(N_PTS)
const _pc = new Float64Array(N_PTS)
const _right = new THREE.Vector3()
const _up = new THREE.Vector3()
const _back = new THREE.Vector3()

/**
 * Solve the camera for a shot: distance by bisection so the framed box fills
 * its region as asked (sw > 1 bleeds past it), then a truck that anchors it
 * in the region (ax/ay −1..1). Exact for the box corners at any aspect.
 */
function solveShot(s: Shot, reg: Region, aspect: number, out: CameraPose) {
  const tanY = Math.tan(THREE.MathUtils.degToRad(s.fov) / 2)
  const tanX = tanY * aspect
  const ce = Math.cos(s.el)
  _back.set(Math.sin(s.az) * ce, Math.sin(s.el), Math.cos(s.az) * ce)
  _right.set(Math.cos(s.az), 0, -Math.sin(s.az))
  _up.crossVectors(_back, _right)
  let n = 0
  let dMin = 0
  for (let i = 0; i < 8; i++) {
    const x = i & 1 ? s.x1 : s.x0
    const y = i & 2 ? s.y1 : 0
    const z = i & 4 ? s.z1 : s.z0
    _pa[n] = x * _right.x + y * _right.y + z * _right.z
    _pb[n] = x * _up.x + y * _up.y + z * _up.z
    const c = -(x * _back.x + y * _back.y + z * _back.z)
    _pc[n] = c
    dMin = Math.max(dMin, -c + 0.3)
    n++
  }
  const fx = (s.ax + 1) / 2
  const fy = (s.ay + 1) / 2
  let dx = 0
  let dy = 0
  const measure = (d: number) => {
    let dxL = Infinity
    let dxR = -Infinity
    let dyB = Infinity
    let dyT = -Infinity
    for (let i = 0; i < n; i++) {
      const z = _pc[i] + d
      dxL = Math.min(dxL, _pa[i] - reg.l * z * tanX)
      dxR = Math.max(dxR, _pa[i] - reg.r * z * tanX)
      dyB = Math.min(dyB, _pb[i] - reg.b * z * tanY)
      dyT = Math.max(dyT, _pb[i] - reg.t * z * tanY)
    }
    dx = lerp(dxL, dxR, fx)
    dy = lerp(dyB, dyT, fy)
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (let i = 0; i < n; i++) {
      const z = _pc[i] + d
      const X = (_pa[i] - dx) / (z * tanX)
      const Y = (_pb[i] - dy) / (z * tanY)
      x0 = Math.min(x0, X)
      x1 = Math.max(x1, X)
      y0 = Math.min(y0, Y)
      y1 = Math.max(y1, Y)
    }
    return Math.max((x1 - x0) / (s.sw * Math.max(0.05, reg.r - reg.l)), (y1 - y0) / (s.sw * Math.max(0.05, reg.t - reg.b)))
  }
  let lo = Math.log(dMin)
  let hi = Math.log(400)
  for (let it = 0; it < 32; it++) {
    const mid = (lo + hi) / 2
    if (measure(Math.exp(mid)) > 1) lo = mid
    else hi = mid
  }
  const d = Math.exp(hi)
  measure(d)
  out.target.set(0, 0, 0).addScaledVector(_right, dx).addScaledVector(_up, dy)
  out.position.copy(out.target).addScaledVector(_back, d)
  out.fov = s.fov
  return d
}

function sampleShot(keys: [number, Shot][], local: number, out: Shot) {
  let i = 0
  while (i < keys.length - 2 && local > keys[i + 1][0]) i++
  const [t0, a] = keys[i]
  const [t1, b] = keys[i + 1]
  const s = ease.inOutCubic(clamp((local - t0) / Math.max(1e-6, t1 - t0)))
  for (const k of SHOT_KEYS) out[k] = lerp(a[k], b[k], s)
  return out
}

function regionOf(s: Shot, m: HudMetrics, w: number, h: number, out: Region) {
  const nx = (px: number) => (2 * px) / w - 1
  const ny = (px: number) => 1 - (2 * px) / h
  let l: number, r: number, b: number, t: number
  if (m.tall) {
    l = -0.92
    r = 0.92
    t = ny(m.safeTop)
    b = ny(Math.max(m.safeTop + 120, lerp(m.colTop, m.introTop, s.ic) - 14))
  } else {
    l = nx(lerp(m.colRight, m.introRight, s.ic) + clamp(0.03 * w, 20, 56))
    r = nx(w - clamp(0.034 * w, 16, 48))
    t = ny(m.safeTop)
    b = ny(h - m.safeBottom)
  }
  if (s.fb > 0) {
    // the finale: the bench above a full-width caption
    l = lerp(l, -0.93, s.fb)
    r = lerp(r, 0.93, s.fb)
    t = lerp(t, ny(m.safeTop), s.fb)
    b = lerp(b, ny(Math.max(m.safeTop + 120, m.finTop - 18)), s.fb)
  }
  out.l = lerp(-1, l, s.sx)
  out.r = lerp(1, r, s.sx)
  out.b = lerp(-1, b, s.sx)
  out.t = lerp(1, t, s.sx)
  return out
}

export default function create(): Chapter {
  const group = new THREE.Group()
  let press: Press | null = null
  let hud: Hud | null = null
  let wide: [number, Shot][] = []
  let tall: [number, Shot][] = []
  const cur = S({})
  const reg: Region = { l: -1, r: 1, b: -1, t: 1 }
  const pose: CameraPose = {
    position: new THREE.Vector3(0, 10, 10),
    target: new THREE.Vector3(),
    fov: 28,
    roll: 0,
    parallax: 0,
  }
  const jp: JobPhase = { k: -1, p: 0 }
  let calm = false

  const jumpTo = (k: number) => {
    const eng = window.__hark?.engine
    if (eng) eng.gotoChapter('services', ANCHORS[k], true)
    else window.__hark?.gotoChapter('services', ANCHORS[k])
  }

  function buildShots(p: Press) {
    const B = p.bounds
    const J = (k: number, ph: number) => jobStart(k) + ph * jobLen(k)
    const slab = { x0: B.slabX - 1.05, x1: B.slabX + 1.05, z0: Z_CHASE - 0.8, z1: Z_CHASE + 0.8, y1: 0.12 }
    const chase = { x0: -B.chaseHalfX, x1: B.chaseHalfX, z0: Z_CHASE - B.chaseHalfZ, z1: Z_CHASE + B.chaseHalfZ }
    const IN0 = S({ az: 0.3, el: 1.28, fov: 30, ...slab, sw: 5.5, sx: 0 })
    const IN1 = S({ az: 0.24, el: 1.2, fov: 30, ...slab, sw: 2.2, sx: 0 })
    // the establishing shot (and the nav landing): the whole case and the bench, clear of the
    // chrome, so nothing is cropped tangent to the nav
    const INTRO = S({ az: 0.12, el: 1.12, fov: 28, x0: -CASE_W / 2 - 0.2, x1: B.slabX + 1.4, z0: -CASE_D - 0.3, z1: Z_CHASE + 2.2, sw: 1.0, ic: 1 })
    const TOP_A = S({ az: 0.0, el: 1.42, fov: 26, x0: -7.4, x1: 7.4, z0: -3.2, z1: Z_CHASE + 1.7, sw: 1.0 })
    const TOP_B = S({ az: 0.07, el: 1.38, fov: 26, x0: -7.2, x1: 7.6, z0: -3.0, z1: Z_CHASE + 1.7, sw: 1.02 })
    const LOW_A = S({ az: -0.5, el: 0.42, fov: 30, ...chase, fw: 1, sw: 1.0, ay: -0.6 })
    const LOW_B = S({ az: -0.3, el: 0.47, fov: 30, ...chase, fw: 1, sw: 1.0, ay: -0.6 })
    const CLOSE_A = S({ az: 0.26, el: 0.92, fov: 24, ...chase, fw: 1, sw: 1.14, ax: -0.7 })
    const CLOSE_B = S({ az: 0.42, el: 0.86, fov: 24, ...chase, fw: 1, sw: 1.14, ax: 0.7 })
    const SIDE_A = S({ az: 0.95, el: 0.66, fov: 28, x0: -6, x1: 6, z0: -2.4, z1: Z_CHASE + 1.3, fw: 1, sw: 1.04 })
    const SIDE_B = S({ az: 0.8, el: 0.72, fov: 28, x0: -6, x1: 6, z0: -2.4, z1: Z_CHASE + 1.3, fw: 1, sw: 1.06 })
    const fin = p.lines[p.lines.length - 1].half + 0.85
    const FIN_A = S({ az: 0.0, el: 1.26, fov: 26, x0: -fin, x1: fin, z0: Z_CHASE - 1.35, z1: Z_CHASE + 1.05, sw: 1.0, fb: 1 })
    const FIN_B = S({ az: 0.035, el: 1.3, fov: 26, x0: -fin, x1: fin, z0: Z_CHASE - 1.3, z1: Z_CHASE + 1.05, sw: 1.07, fb: 1 })
    const OUT = S({ az: 0.2, el: 1.3, fov: 30, ...slab, sw: 6, sx: 0 })
    // the pull-back from the ink slab settles by INTRO_AT, and the intro title only
    // stamps in once it has (INTRO_ON), so it never lands on the roller or the flood
    wide = [
      [0, IN0],
      [0.024, IN1],
      [INTRO_AT, INTRO],
      // hold through the nav landing (0.08) so it lands on the settled frame
      [INTRO_HOLD, INTRO],
      [J(0, 0.45), TOP_A],
      [J(2, 0.9), TOP_B],
      [J(3, 0.35), LOW_A],
      [J(5, 0.9), LOW_B],
      [J(6, 0.35), CLOSE_A],
      [J(8, 0.9), CLOSE_B],
      [J(9, 0.35), SIDE_A],
      [J(10, 0.9), SIDE_B],
      [J(11, 0.3), FIN_A],
      [OUT_START, FIN_B],
      [1, OUT],
    ]
    // portrait: less to the sides, so frame tighter on the line and let the case bleed
    tall = wide.map(([t, s]) => {
      const o: Partial<Shot> = {}
      if (s === INTRO) Object.assign(o, { x0: -7.5, x1: 7.5, z0: -5, ax: 0, ay: -0.3, sw: 1.15 })
      if (s === TOP_A || s === TOP_B) Object.assign(o, { x0: -5.6, x1: 5.6, z0: -2.4, sw: 1.06 })
      if (s === LOW_A || s === LOW_B) Object.assign(o, { sw: 1.08, fov: 34 })
      if (s === CLOSE_A || s === CLOSE_B) Object.assign(o, { sw: 1.12, fov: 28 })
      if (s === SIDE_A || s === SIDE_B) Object.assign(o, { x0: -5, x1: 5, z0: -1.2, sw: 1.1 })
      if (s === FIN_A || s === FIN_B) Object.assign(o, { sw: s === FIN_A ? 1.08 : 1.14 })
      return [t, { ...s, ...o }]
    })
  }

  return {
    id: 'services',
    group,
    anchors: ANCHORS,

    async init(ctx: ChapterContext) {
      calm = ctx.reducedMotion
      await loadWoodFace()
      const yieldFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()))
      press = new Press(ctx.mobile)
      await press.build(yieldFrame)
      group.add(press.group)
      buildShots(press)
      hud = new Hud(ctx.stage, jumpTo)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      if (!press || !hud) return
      jobAt(local, jp)
      press.update(jp, frame.time, calm || frame.reducedMotion)

      /* ---------------- HUD ---------------- */
      // The slip always names the word in the chase: it changes the moment the
      // new line starts to set (the last one is going back to the case), and
      // its PROOF stamp lands when the proof is pulled.
      const m = hud.metrics()
      const { k, p } = jp
      const last = SERVICES.length
      let shown = -1
      let proofed = true
      if (k === 0) {
        // the intro holds while the first line sets; slip 01 lands with its proof
        shown = p >= PH.pull ? 0 : -1
      } else if (k > 0 && k < last) {
        shown = p >= PH.set0 ? k : k - 1
        proofed = shown < k || p >= PH.pull
      }
      // the last proof leaves as HARK starts to set, so HARK has the stage
      else if (k === last && p < PH.set0) shown = last - 1
      const fin = k === last && local < 0.965 && p >= PH.pull ? 2 : 0
      hud.update({
        // wait for the flood to clear and the camera to settle off the ink slab,
        // so the title stamps onto a clean frame
        introOn: local > INTRO_ON && (k < 0 || (k === 0 && p < PH.pull)),
        shown,
        proofed,
        finale: fin,
        key: shown,
      })

      /* ---------------- camera ---------------- */
      sampleShot(m.tall ? tall : wide, local, cur)
      if (cur.fw > 0) {
        // frame the line being set (short lines come closer)
        const wh = Math.max(2.3, press.frameHalf(jp) + 1.1)
        cur.x0 = lerp(cur.x0, -wh, cur.fw)
        cur.x1 = lerp(cur.x1, wh, cur.fw)
      }
      regionOf(cur, m, frame.width, frame.height, reg)
      const dist = solveShot(cur, reg, frame.width / Math.max(1, frame.height), pose)
      pose.parallax = calm ? 0 : Math.min(0.5, dist * 0.012)

      /* ---------------- press ---------------- */
      const st = press.state
      const pp = ctx.post.params
      pp.misreg = 1.4 + 2.6 * st.impression
      pp.glitch = calm ? 0 : 0.12 * st.rolling
      // the final proof prints on a freshly charged drum: dense, no starved voids
      pp.grain = k === last ? lerp(0.5, 0.1, segment(p, PH.roll0, PH.roll1)) : 0.5
    },

    onPointerDown(frame: Frame, ctx: ChapterContext) {
      press?.poke(frame.pointerRaw, ctx.camera, frame.time)
    },

    camera(_local: number, _frame: Frame, out: CameraPose) {
      out.position.copy(pose.position)
      out.target.copy(pose.target)
      out.fov = pose.fov
      out.roll = 0
      out.parallax = pose.parallax
    },
  }
}
