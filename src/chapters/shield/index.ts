import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { Callout, el, reveal, rise, setRise } from '../../core/dom'
import { clamp, ease, lerp, rng, segment, smoothstep, window01 } from '../../core/math'
import { SECURITY, STATS } from '../../content'
import { BREACH_ASPECT, PAGE_H, PAGE_W, canvasTexture, drawBreachStamp, drawPage, drawSeal, loadPrintFonts } from './print'
import { newPose, Strips, type RestPose, type StripPose } from './strips'
import { HEAD, Shredder, StampTool, decalMaterial, matMaterial, overprint } from './props'
import { box, mixShot, shot, solve, type Region, type Shot } from './framing'
import './shield.css'

/*
 * SHREDDER — "Hacked? Breathe."
 *
 * Hark's homepage, printed as a proof, lies on the cutting mat in front of a
 * strip-cut shredder.
 *
 *   0.00–0.09  in-beat under the ink flood: the sheet feeds in from the top
 *   0.09–0.20  BREACH: the shredder pulls the page through (roller wobble,
 *              the lamp blinks pink, callout 'Intrusion detected'); strips
 *              curl and fan out of the mouth
 *   0.20–0.29  the strips are flung across the mat and land every which way
 *   0.285–0.33 three pink BREACH stamps slam down across the mess
 *   0.335–0.40 the shredder is yanked away; the copy stamps in
 *   0.35–0.45  the strips peel up off the mat (the pink ink lifts off them)
 *              and hover over the page's footprint, exploded, in order
 *   0.45–0.61  ZIP: left to right each strip drops into its column
 *   0.625–0.66 press: the seams close, the proof is whole again
 *   0.715      a big green RESTORED seal slams onto it; 24/7 + CTA
 *   0.93–1.00  out-beat: the camera drops into the green seal (ink flood)
 *
 * Every pose is derived from `local`; frame.time only drives idle boil
 * (paper flutter, the lamp, the machine's shudder), stepped at 12 fps.
 */

const STAT = STATS.find(s => s.value === '24/7') ?? STATS[STATS.length - 1]

// ------------------------------------------------------------ timeline
const T = {
  slide: [0.0, 0.09],
  feed: [0.09, 0.2],
  launch: 0.2,
  launchSpread: 0.032,
  flight: 0.052,
  hits: [0.285, 0.305, 0.325],
  headOut: [0.335, 0.4],
  gather: 0.345,
  gatherSpread: 0.025,
  gatherDur: 0.05,
  zip: [0.45, 0.61],
  zipDur: 0.042,
  press: [0.625, 0.66],
  seal: 0.715,
} as const

const L = PAGE_H
/** head mouth: the page enters at z = -d/2 and the strips leave at z = +d/2 */
const Z_EXIT = HEAD.d / 2
/** page top edge before the feed */
const Z0 = -HEAD.d / 2 - 0.28 - L
const FEED = Z_EXIT - Z0
const BASE_Y = 0.004
/** the stamps */
const BREACH_W = 2.45
const BREACH_HALF = new THREE.Vector2(BREACH_W / 2, BREACH_W / BREACH_ASPECT / 2)
const SEAL_D = 2.35

interface StripRand {
  r: number[]
}

/** portrait factor: 0 landscape .. 1 phone portrait */
const portrait = (w: number, h: number) => smoothstep(1.15, 0.62, w / Math.max(1, h))

export default function create(): Chapter {
  const group = new THREE.Group()
  let N = 24
  let strips: Strips
  let head: Shredder
  let rectTool: StampTool
  let sealTool: StampTool
  const breachDecals: THREE.Mesh[] = []
  let seal: THREE.Mesh
  let sealMat: THREE.ShaderMaterial
  let mat: THREE.Mesh
  let matMat: THREE.ShaderMaterial

  const rand: StripRand[] = []
  const poses: StripPose[] = []
  const restP: StripPose[] = []
  const hoverP: StripPose[] = []
  const placeP: StripPose[] = []
  const rest: RestPose[] = []
  const tmpA = newPose()
  const tmpB = newPose()

  /** scatter region (half extents) and centre z */
  const scat = { ax: 4, az: 3, zc: 3.9 }
  /** page target: centre + yaw */
  const target = { x: 0, z: 3.9, yaw: -0.045 }
  const stampAt: { x: number; z: number; a: number }[] = [
    { x: 0, z: 0, a: 0 },
    { x: 0, z: 0, a: 0 },
    { x: 0, z: 0, a: 0 },
  ]
  const sealAt = { x: 0, z: 0, a: -0.24 }

  // DOM
  let stage: HTMLElement
  let probe: HTMLElement
  let copy: HTMLElement
  const dom: Record<string, HTMLElement> = {}
  let alert: Callout
  let counter: Callout
  let counterV: HTMLElement
  let counterK: HTMLElement
  let counterText = ''
  const m = { w: 0, h: 0, wide: true, copyR: 0, bodyB: 0, calmB: 0, headB: 0, safeTop: 96, safeBottom: 86, gutter: 24 }

  // shots (rebuilt on resize)
  let shotsW: Shot[] = []
  const KEYS: [number, (t: number) => number][] = [
    [0.0, ease.outCubic],
    [0.09, ease.inOutQuad],
    [0.2, ease.inOutCubic],
    [0.285, ease.inOutQuad],
    [0.34, ease.inOutCubic],
    [0.45, ease.inOutQuad],
    [0.9, ease.inCubic],
    [1.0, ease.inCubic],
  ]
  const _s = shot({ p: box([0, 0, 0], [1, 1, 1]) })
  const _v = new THREE.Vector3()
  const _p = new THREE.Vector3()

  let lastTick = -1
  let lastLocal = -1
  let layoutKey = ''

  // ------------------------------------------------------------ layout
  function colRoot(i: number, cx: number, cz: number, yaw: number, spread = 1) {
    const w = PAGE_W / N
    const xl = (-PAGE_W / 2 + (i + 0.5) * w) * spread
    const zl = -L / 2
    const c = Math.cos(yaw)
    const s = Math.sin(yaw)
    // page +x = (cos, -sin), page +z = (sin, cos)
    return { x: cx + xl * c + zl * s, z: cz - xl * s + zl * c }
  }

  function buildLayout(w: number, h: number) {
    const a = w / Math.max(1, h)
    const f = 0.87
    const area = 8
    let az = Math.sqrt(area / (a * f))
    let ax = a * f * az
    ax = clamp(ax, 2.1, 7)
    az = clamp(area / ax, 2.2, 6)
    scat.ax = ax
    scat.az = az
    scat.zc = Z_EXIT + 0.55 + az
    target.x = 0
    target.z = scat.zc - 0.1
    target.yaw = -0.045

    // three stamp spots spread across the mess
    const spots: [number, number, number][] = [
      [-0.5, -0.42, -0.2],
      [0.46, -0.02, 0.12],
      [-0.08, 0.5, -0.05],
    ]
    const sw = Math.min(1, (ax * 2) / (BREACH_W * 1.35))
    spots.forEach((s, k) => {
      stampAt[k].x = s[0] * Math.max(0.3, ax - BREACH_W * 0.5 * sw)
      stampAt[k].z = scat.zc + s[1] * (az - 0.5)
      stampAt[k].a = s[2]
    })
    breachDecals.forEach((d, k) => {
      d.position.set(stampAt[k].x, 0.002, stampAt[k].z)
      d.rotation.set(-Math.PI / 2, 0, -stampAt[k].a)
      d.scale.setScalar(sw)
    })
    BREACH_HALF.set((BREACH_W / 2) * sw, (BREACH_W / BREACH_ASPECT / 2) * sw)

    // strips: a few are thrown across each stamp spot, the rest anywhere
    const r = rng(77)
    for (let i = 0; i < N; i++) {
      const k = i % 8
      let cx: number
      let cz: number
      let yaw = (r() - 0.5) * Math.PI * 2
      if (k < 3) {
        cx = stampAt[k].x + (r() - 0.5) * 0.9
        cz = stampAt[k].z + (r() - 0.5) * 0.5
        yaw = stampAt[k].a + (r() < 0.5 ? 0 : Math.PI) + (r() - 0.5) * 1.9
      } else {
        cx = (r() * 2 - 1) * ax * 0.95
        cz = scat.zc + (r() * 2 - 1) * az * 0.92
      }
      const dx = Math.sin(yaw) * L * 0.5
      const dz = Math.cos(yaw) * L * 0.5
      // keep clear of the shredder
      const minZ = Math.min(cz - dz, cz + dz)
      if (minZ < Z_EXIT + 0.35) cz += Z_EXIT + 0.35 - minZ
      const flip = r() < 0.28
      const sFlat = L * (0.66 + r() * 0.24)
      const kBend = r() < 0.7 ? (r() - 0.5) * 0.34 : 0
      rest[i] = { x: cx - dx, z: cz - dz, yaw, sFlat, flip, kBend }
      const p = restP[i]
      Object.assign(p, newPose())
      p.x = cx - dx
      p.y = BASE_Y
      p.z = cz - dz
      p.yaw = yaw
      p.sFlat = sFlat
      p.kGrow = 1.2 + r() * 2.6
      p.wave = r() < 0.5 ? 0.06 + r() * 0.1 : 0
      p.kBend = kBend
      p.phase = r() * 6.28
      p.roll = flip ? Math.PI : 0
      p.seam = 1
      p.breach = 1
      p.sCut = -1
    }
    strips.setRest(rest)

    // hover (exploded page above its footprint) and placed poses
    for (let i = 0; i < N; i++) {
      const rr = rand[i].r
      const c = colRoot(i, target.x, target.z, target.yaw, 1.22)
      const hp = hoverP[i]
      Object.assign(hp, newPose())
      hp.x = c.x + (rr[0] - 0.5) * 0.06
      hp.y = 0.5 + rr[1] * 0.75
      hp.z = c.z + (rr[2] - 0.5) * 0.55
      hp.yaw = target.yaw + (rr[3] - 0.5) * 0.24
      hp.pitch = (rr[4] - 0.5) * 0.12
      hp.kUp = (rr[5] - 0.5) * 0.08
      hp.wave = 0.1 + rr[6] * 0.12
      hp.phase = rr[7] * 6.28
      hp.roll = (rr[8] - 0.5) * 0.5
      hp.twist = (rr[9] - 0.5) * 0.16
      hp.seam = 1
      hp.sCut = -1
      const pc = colRoot(i, target.x, target.z, target.yaw)
      const pp = placeP[i]
      Object.assign(pp, newPose())
      pp.x = pc.x
      pp.y = BASE_Y
      pp.z = pc.z
      pp.yaw = target.yaw
      pp.sFlat = L + 1
      pp.seam = 0.6
      pp.sCut = -1
    }

    // the seal lands on the restored proof, over the hero's lower edge
    const sc = { x: 0.4, z: 0.64 }
    const cy = Math.cos(target.yaw)
    const sy = Math.sin(target.yaw)
    sealAt.x = target.x + sc.x * cy + sc.z * sy
    sealAt.z = target.z - sc.x * sy + sc.z * cy
    seal.position.set(sealAt.x, 0.05, sealAt.z)
    seal.rotation.set(-Math.PI / 2, 0, -(sealAt.a + target.yaw))

    // mat grid follows the action
    ;(matMat.uniforms.uCenter.value as THREE.Vector2).set(0, (Z0 + scat.zc + scat.az) / 2)
    ;(matMat.uniforms.uRadius.value as THREE.Vector2).set(ax + 3.2, (scat.zc + scat.az - Z0) / 2 + 1.5)

    // ---- camera shots
    const pf = portrait(w, h)
    const fov = lerp(30, 38, pf)
    const pageBox = (cx: number, cz: number, hy: number, pad: number) => {
      const p: number[] = []
      for (let i = 0; i < 8; i++) {
        const xl = (i & 1 ? 1 : -1) * (PAGE_W / 2 + pad)
        const zl = (i & 4 ? 1 : -1) * (L / 2 + pad)
        const c = Math.cos(target.yaw)
        const s = Math.sin(target.yaw)
        p.push(cx + xl * c + zl * s, i & 2 ? hy : 0, cz - xl * s + zl * c)
      }
      return p
    }
    const zFar = scat.zc + az + 0.3
    // phones: let the wide machine bleed off the sides instead of shrinking it
    const pfill = lerp(1, 1.16, pf)
    shotsW = [
      shot({ p: box([0, 0.2, -1.6], [2.0, 0.3, 1.9]), az: -0.3, el: 0.92, fov, fill: 1.25, roll: -0.07 }),
      shot({ p: box([0, 0.25, (Z0 - 0.1 + Z_EXIT + 0.3) / 2], [2.45, 0.3, (Z_EXIT + 0.3 - Z0 + 0.1) / 2]), az: -0.14, el: 1.0, fov, fill: 0.94 * pfill, roll: -0.05 }),
      shot({ p: box([0, 0.35, (-0.75 + Z_EXIT + L * 0.95) / 2], [2.9, 0.35, (Z_EXIT + L * 0.95 + 0.75) / 2]), az: -0.06, el: 1.06, fov, fill: 0.96 * pfill, roll: -0.03 }),
      shot({ p: box([0, 0.3, (zFar - 0.75) / 2], [ax + 0.3, 0.3, (zFar + 0.75) / 2]), az: 0.02, el: 1.12, fov, fill: 1.0, roll: 0 }),
      shot({ p: box([0, 0.3, (zFar - 0.6) / 2], [ax + 0.2, 0.3, (zFar + 0.6) / 2]), az: 0.05, el: 1.15, fov, fill: 1.04, roll: 0.012 }),
      shot({ p: pageBox(target.x, target.z, 1.1, 0.16), az: 0.06, el: 1.2, fov, fill: 0.94, band: 1 }),
      shot({ p: pageBox(target.x, target.z, 0.3, 0.1), az: -0.03, el: 1.3, fov, fill: 0.96, band: 1 }),
      shot({ p: box([sealAt.x, 0.02, sealAt.z], [0.3, 0.02, 0.3]), az: -0.02, el: 1.36, fov, fill: 2.6, band: 1 }),
    ]
  }

  // ------------------------------------------------------------ DOM measure
  function measure(w: number, h: number) {
    m.w = w
    m.h = h
    if (!copy) return
    const wide = w / Math.max(1, h) > 1.1 && w >= 880
    stage.classList.toggle('sh-wide', wide)
    m.wide = wide
    const cs = getComputedStyle(probe)
    m.safeTop = parseFloat(cs.paddingTop) || 96
    m.safeBottom = parseFloat(cs.paddingBottom) || 86
    m.gutter = parseFloat(cs.paddingLeft) || 24
    const t = dom.title.getBoundingClientRect()
    const b = dom.body.getBoundingClientRect()
    const c = dom.calm.getBoundingClientRect()
    m.headB = t.bottom
    m.copyR = Math.max(t.right, b.right, c.right)
    m.bodyB = b.bottom
    m.calmB = c.bottom
    const key = `${w}x${h}`
    if (key !== layoutKey) {
      layoutKey = key
      buildLayout(w, h)
      lastTick = -1
    }
  }

  const reg: Region = { x0: -1, x1: 1, y0: -1, y1: 1 }
  function region(band: number, calmK: number, w: number, h: number) {
    const nx = (px: number) => (px / w) * 2 - 1
    const ny = (py: number) => 1 - (py / h) * 2
    // full frame (breach): nearly edge to edge
    const f = { x0: nx(m.gutter * 0.4), x1: nx(w - m.gutter * 0.4), y0: ny(h - m.safeBottom * 0.6), y1: ny(m.safeTop * 0.92) }
    let b: Region
    if (m.wide) {
      b = { x0: nx(m.copyR + Math.max(24, w * 0.025)), x1: nx(w - m.gutter), y0: ny(h - m.safeBottom * 1.08), y1: ny(m.safeTop * 0.95) }
    } else {
      const top = lerp(m.bodyB, m.calmB, calmK) + 14
      b = { x0: nx(m.gutter * 0.6), x1: nx(w - m.gutter * 0.6), y0: ny(h - m.safeBottom * 0.72), y1: ny(Math.min(top, h - m.safeBottom - 140)) }
    }
    reg.x0 = lerp(f.x0, b.x0, band)
    reg.x1 = lerp(f.x1, b.x1, band)
    reg.y0 = lerp(f.y0, b.y0, band)
    reg.y1 = lerp(f.y1, b.y1, band)
    return reg
  }

  // ------------------------------------------------------------ poses
  function lerpPose(a: StripPose, b: StripPose, k: number, out: StripPose) {
    for (const key of Object.keys(a) as (keyof StripPose)[]) out[key] = lerp(a[key], b[key], k)
    return out
  }

  function feedPose(i: number, zTop: number, out: StripPose) {
    const rr = rand[i].r
    const w = PAGE_W / N
    Object.assign(out, newPose())
    out.x = -PAGE_W / 2 + (i + 0.5) * w
    out.y = BASE_Y
    out.z = zTop
    out.sFlat = Z_EXIT - zTop
    out.pitch = 0.16 + rr[0] * 0.1
    out.kUp = -0.06 + rr[1] * 0.1
    out.kGrow = 0.05 + rr[2] * 0.09
    out.kSide = 0.17 * (((i + 0.5) / N) * 2 - 1) + (rr[3] - 0.5) * 0.06
    out.wave = 0.3 + rr[4] * 0.3
    out.phase = rr[5] * 6.28
    out.twist = (rr[6] - 0.5) * 0.16
    out.seam = 1
    out.sCut = -zTop
    out.breach = 0
    return out
  }

  /** shortest signed angle from a to b */
  const dAng = (a: number, b: number) => {
    let d = (b - a) % (Math.PI * 2)
    if (d > Math.PI) d -= Math.PI * 2
    if (d < -Math.PI) d += Math.PI * 2
    return d
  }

  function stripPose(i: number, local: number, time: number, rm: boolean, out: StripPose) {
    const rr = rand[i].r
    // --- before and during the feed
    if (local < T.launch + rr[10] * T.launchSpread) {
      let zTop: number
      if (local < T.feed[0]) {
        const k = ease.outCubic(segment(local, T.slide[0], T.slide[1]))
        zTop = Z0 - 7 * (1 - k)
      } else {
        const k = segment(local, T.feed[0], T.feed[1])
        zTop = Z0 + FEED * lerp(k, k * k * (3 - 2 * k), 0.4)
      }
      return feedPose(i, zTop, out)
    }
    // --- flung across the mat
    const l0 = T.launch + rr[10] * T.launchSpread
    const kl = segment(local, l0, l0 + T.flight * (0.85 + rr[11] * 0.3))
    const g0 = T.gather + rr[12] * T.gatherSpread
    if (local < g0) {
      const a = feedPose(i, Z_EXIT, tmpA)
      const b = restP[i]
      if (kl >= 1) return Object.assign(out, b)
      const ke = ease.outCubic(kl)
      lerpPose(a, b, ke, out)
      const arc = Math.sin(Math.PI * kl)
      out.x = lerp(a.x, b.x, ke)
      out.z = lerp(a.z, b.z, ke)
      out.y = BASE_Y + arc * (0.7 + rr[13] * 1.5)
      const spin = rr[14] < 0.33 ? -1 : rr[14] < 0.66 ? 0 : 1
      out.roll = lerp(0, b.roll + spin * Math.PI * 2, ke)
      out.yaw = lerp(0, b.yaw, ke)
      out.pitch = lerp(a.pitch, 0, ke) + arc * (rr[15] - 0.5) * 0.9
      out.kUp = lerp(a.kUp, 0, ke) + arc * (rr[16] - 0.5) * 0.6
      out.wave = lerp(a.wave, b.wave, ke) + arc * 0.35
      out.phase = a.phase + kl * 5
      out.twist = arc * (rr[17] - 0.5) * 1.4
      out.sFlat = lerp(0, b.sFlat, ke)
      out.breach = 1
      return out
    }
    // --- peeled up, hovering over the footprint (exploded)
    const hover = hoverPose(i, time, rm, tmpB)
    const arrive = T.zip[0] + (i / Math.max(1, N - 1)) * (T.zip[1] - T.zip[0])
    const z0 = arrive - T.zipDur
    if (local < z0) {
      const kg = segment(local, g0, g0 + T.gatherDur)
      if (kg >= 1) return Object.assign(out, hover)
      const a = restP[i]
      const ke = ease.inOutCubic(kg)
      lerpPose(a, hover, ke, out)
      const arc = Math.sin(Math.PI * kg)
      out.y = lerp(a.y, hover.y, ke) + arc * (0.8 + rr[18] * 0.8)
      out.yaw = a.yaw + dAng(a.yaw, hover.yaw) * ke
      // face-down strips flip over in the air
      out.roll = lerp(a.roll, hover.roll + (a.roll > 1 ? Math.PI * 2 * (rr[19] < 0.5 ? 1 : 0) : 0), ke)
      out.kGrow = lerp(a.kGrow, 0, ease.outCubic(kg))
      out.sFlat = lerp(a.sFlat, 0, ease.outCubic(kg))
      out.wave = lerp(a.wave, hover.wave, ke) + arc * 0.3
      out.twist = hover.twist + arc * (rr[17] - 0.5) * 1.1
      out.breach = 1 - smoothstep(0.0, 0.45, kg)
      return out
    }
    // --- zip: drop into the column
    const kz = segment(local, z0, arrive)
    const place = placeP[i]
    if (kz < 1) {
      const ke = kz * kz
      lerpPose(hover, place, ke, out)
      out.yaw = hover.yaw + dAng(hover.yaw, place.yaw) * ke
      // the tail trails a little curl as it drops, then slaps flat (below)
      out.sFlat = lerp(0, L * 0.65, kz)
      out.kGrow = lerp(0, 0.3, kz)
      out.seam = 1
      return out
    }
    Object.assign(out, place)
    // settle: the strip slaps down and flattens
    const after = local - arrive
    const settle = Math.exp(-after / 0.006) * (after < 0.03 ? 1 : 0)
    out.sFlat = L * (1 - 0.35 * settle)
    out.kGrow = 0.3 * settle
    // press: seams close
    out.seam = lerp(0.6, 0, smoothstep(T.press[0], T.press[1], local))
    return out
  }

  function hoverPose(i: number, time: number, rm: boolean, out: StripPose) {
    Object.assign(out, hoverP[i])
    if (!rm) {
      const rr = rand[i].r
      // paper flutter, boiled at 12 fps
      const t = Math.floor(time * 12) / 12
      out.roll += Math.sin(t * (1.6 + rr[20]) + i) * 0.12
      out.phase += t * (1.2 + rr[21] * 0.8)
      out.y += Math.sin(t * 1.3 + i * 0.7) * 0.05
    }
    return out
  }

  // ------------------------------------------------------------ chapter
  return {
    id: 'shield',
    group,
    // the one item in the copy layer is the CTA: land where it's on screen
    anchors: [0.8],

    async init(ctx: ChapterContext) {
      N = ctx.mobile ? 16 : 24
      for (let i = 0; i < N; i++) {
        const r = rng(1000 + i * 17)
        rand.push({ r: Array.from({ length: 24 }, () => r()) })
        poses.push(newPose())
        restP.push(newPose())
        hoverP.push(newPose())
        placeP.push(newPose())
        rest.push({ x: 0, z: 0, yaw: 0, sFlat: L, flip: false, kBend: 0 })
      }

      // ---------------- DOM
      stage = ctx.stage
      probe = el('div', 'sh-probe', undefined, stage)
      copy = el('div', 'sh-copy', undefined, stage)
      const eyebrow = el('p', 'hud-eyebrow sh-eyebrow', undefined, copy)
      dom.eyebrow = eyebrow
      dom.eyebrowText = rise(el('span', 'sh-eyebrow-text', undefined, eyebrow), SECURITY.eyebrow)
      dom.title = rise(el('h2', 'hud-title sh-title', undefined, copy), 'Hacked? <br><em>Breathe.</em>')
      const slot = el('div', 'sh-slot', undefined, copy)
      dom.body = rise(el('p', 'hud-body sh-body', undefined, slot), SECURITY.body)
      dom.calm = el('div', 'sh-calm', undefined, slot)
      const statRow = el('div', 'sh-stat-row', undefined, dom.calm)
      dom.stat = rise(el('p', 'sh-stat', undefined, statRow), STAT.value)
      dom.statLabel = rise(el('p', 'hud-body sh-stat-label', undefined, statRow), STAT.label)
      const cta = el('a', 'hud-btn sh-cta', SECURITY.cta, dom.calm)
      cta.href = SECURITY.href
      dom.cta = cta

      alert = new Callout(stage, { side: 'right', offset: { x: 64, y: 58 } })
      alert.root.classList.add('sh-alert')
      alert.label.innerHTML = '<span class="sh-alert-dot"></span><span>Intrusion detected</span>'
      reveal(alert.root, 0, 0)
      counter = new Callout(stage, { side: 'right', offset: { x: 52, y: -46 } })
      counter.root.classList.add('sh-count')
      counterK = el('span', 'sh-count-k', 'Strips', counter.label)
      counterV = el('span', 'sh-count-v', '', counter.label)
      reveal(counter.root, 0, 0)

      // ---------------- print art
      await loadPrintFonts()
      const pageArt = drawPage(ctx.mobile ? 768 : 1024)
      const printTex = canvasTexture(pageArt.screen)
      const lineTex = canvasTexture(pageArt.crisp)
      const breachTex = canvasTexture(drawBreachStamp(), 4)
      const sealTex = canvasTexture(drawSeal(), 4)
      await new Promise(r => requestAnimationFrame(r))

      // ---------------- scene
      matMat = matMaterial()
      mat = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), overprint(matMat, -3))
      mat.renderOrder = -3
      mat.rotation.x = -Math.PI / 2
      group.add(mat)

      strips = new Strips(N, PAGE_W, PAGE_H, printTex, lineTex, breachTex, BREACH_HALF)
      group.add(strips.shadow, strips.mesh)

      head = new Shredder(N)
      group.add(head.group)

      for (let k = 0; k < 3; k++) {
        const dm = overprint(decalMaterial(breachTex, [1, 0, 0], k * 3.1), -1)
        const d = new THREE.Mesh(new THREE.PlaneGeometry(BREACH_W, BREACH_W / BREACH_ASPECT), dm)
        d.renderOrder = -1
        breachDecals.push(d)
        group.add(d)
      }
      sealMat = overprint(decalMaterial(sealTex, [0, 1, 0], 7.7), 1)
      sealMat.uniforms.uHalftone.value = 0
      sealMat.uniforms.uAmt.value = 1
      seal = new THREE.Mesh(new THREE.PlaneGeometry(SEAL_D, SEAL_D), sealMat)
      seal.renderOrder = 1
      group.add(seal)

      rectTool = new StampTool('rect', BREACH_W, BREACH_W / BREACH_ASPECT, [0.95, 0, 0.1], [1, 0, 0])
      sealTool = new StampTool('round', SEAL_D, SEAL_D, [0, 0.95, 0.1], [0, 0.9, 0])
      group.add(rectTool.group, rectTool.shadowMesh, sealTool.group, sealTool.shadowMesh)

      const remeasure = () => measure(m.w || window.innerWidth, m.h || window.innerHeight)
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => remeasure()).observe(copy)
      document.fonts?.ready.then(remeasure).catch(() => {})
      measure(window.innerWidth, window.innerHeight)
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const w = frame.width
      const h = frame.height
      if (w !== m.w || h !== m.h) measure(w, h)
      const rm = frame.reducedMotion
      const t = frame.time
      const tick = Math.floor(t * 12)

      // ---- objects animate on twos (12 fps), the camera stays smooth
      if (tick !== lastTick || Math.abs(local - lastLocal) > 0.04 || lastTick < 0) {
        lastTick = tick
        lastLocal = local
        for (let i = 0; i < N; i++) stripPose(i, local, t, rm, poses[i])
        strips.write(poses)
        const st = strips.stamps
        for (let k = 0; k < 3; k++) st[k].set(stampAt[k].x, stampAt[k].z, stampAt[k].a, local >= T.hits[k] ? 1 : 0)

        // shredder: in place, shudders while it chews, yanked away after the stamps
        const out = ease.inCubic(segment(local, T.headOut[0], T.headOut[1]))
        head.group.visible = local < T.headOut[1]
        head.group.position.set(0, 0, -out * 9)
        const chewing = window01(local, T.feed[0], T.feed[1] + 0.012, 0.01)
        const q = rm ? 0 : chewing
        const hs = (n: number) => Math.sin(tick * 12.9898 + n * 78.233) * 43758.5453 % 1
        head.body.position.set(hs(1) * 0.018 * q, Math.abs(hs(2)) * 0.012 * q, hs(3) * 0.014 * q)
        head.body.rotation.z = hs(4) * 0.006 * q
        const alarm = local >= T.feed[0] - 0.005
        const blink = rm || tick % 6 < 4
        head.setLamp(alarm ? (blink ? [1, 0, 0] : [0.25, 0, 0.1]) : [0, 1, 0])

        // BREACH stamp: slams down on each spot, hops between them
        placeRectTool(local)
        placeSealTool(local)
      }

      // stamp impressions
      const lift = 1 - smoothstep(T.gather, T.gather + 0.05, local)
      breachDecals.forEach((d, k) => {
        const on = local >= T.hits[k]
        d.visible = on && lift > 0
        ;(d.material as THREE.ShaderMaterial).uniforms.uAmt.value = on ? lift : 0
      })
      seal.visible = local >= T.seal

      // ---- DOM beats (headline + body settled by the 0.45 nav landing)
      const headOn = local > 0.37 && local < 0.955
      setRise(dom.eyebrowText, headOn)
      dom.eyebrow.classList.toggle('is-on', headOn)
      setRise(dom.title, headOn)
      setRise(dom.body, local > 0.4 && local < 0.705)
      const calmOn = local > 0.72 && local < 0.955
      setRise(dom.stat, calmOn)
      setRise(dom.statLabel, calmOn)
      dom.cta.classList.toggle('is-in', calmOn)

      head.lampPosition(_v)
      // label above the lamp, unless the machine is up under the nav
      _p.copy(_v).project(ctx.camera)
      alert.offset.y = (1 - _p.y) * 0.5 * h > m.safeTop + 70 ? -52 : 58
      alert.update(_v, ctx.camera, w, h, window01(local, 0.1, 0.33, 0.02))

      // strip counter pinned to the proof's top-right corner while it re-forms
      let placed = 0
      for (let i = 0; i < N; i++) if (local >= T.zip[0] + (i / Math.max(1, N - 1)) * (T.zip[1] - T.zip[0])) placed++
      const whole = local >= T.press[1]
      const txt = whole ? `${N} / ${N} · whole` : `${String(placed).padStart(2, '0')} / ${N}`
      if (txt !== counterText) {
        counterText = txt
        counterV.textContent = txt
        counterK.textContent = whole ? 'Proof' : 'Strips'
        counter.root.classList.toggle('is-whole', whole)
      }
      const cc = Math.cos(target.yaw)
      const cs = Math.sin(target.yaw)
      _v.set(target.x + (PAGE_W / 2) * cc + (-L / 2) * cs, 0.02, target.z - (PAGE_W / 2) * cs + (-L / 2) * cc)
      counter.update(_v, ctx.camera, w, h, window01(local, 0.44, 0.705, 0.015))

      // ---- the press
      const p = ctx.post.params
      const breach = window01(local, T.feed[0], 0.345, 0.03)
      p.misreg = lerp(1.3, 2.4, breach)
      let glitch = window01(local, T.feed[0], T.feed[1] + 0.02, 0.02) * (0.14 + 0.1 * Math.abs(Math.sin(tick * 1.7)))
      for (const hk of T.hits) glitch = Math.max(glitch, 0.4 * Math.exp(-Math.max(0, local - hk) / 0.004) * (local >= hk ? 1 : 0))
      p.glitch = rm ? 0 : glitch
      const press = local >= T.press[0] + 0.02 ? Math.exp(-(local - T.press[0] - 0.02) / 0.008) : 0
      const sealHit = local >= T.seal ? Math.exp(-(local - T.seal) / 0.006) : 0
      p.flash = Math.max(press * 0.14, sealHit * 0.1)
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const w = frame.width
      const h = frame.height
      if (w !== m.w || h !== m.h) measure(w, h)
      if (!shotsW.length) {
        out.position.set(0, 9, 6)
        out.target.set(0, 0, 0)
        return
      }
      let i = 0
      while (i < KEYS.length - 2 && local >= KEYS[i + 1][0]) i++
      const k = KEYS[i][1](segment(local, KEYS[i][0], KEYS[i + 1][0]))
      mixShot(shotsW[i], shotsW[i + 1], k, _s)
      const calmK = smoothstep(0.66, 0.74, local)
      solve(_s, region(_s.band, calmK, w, h), w / Math.max(1, h), out.position, out.target)
      // stamp impacts nudge the camera
      let bump = 0
      for (const hk of [...T.hits, T.seal]) if (local >= hk) bump = Math.max(bump, Math.exp(-(local - hk) / 0.005))
      if (!frame.reducedMotion) {
        const t = frame.time
        out.position.x += Math.sin(t * 0.21) * 0.05
        out.position.z += Math.sin(t * 0.17 + 1.3) * 0.04
        out.position.y -= bump * 0.12
      }
      out.fov = _s.fov
      out.roll = _s.roll
      out.parallax = 0.25 * (1 - smoothstep(0.92, 1, local))
    },
  }

  // ------------------------------------------------------------ stamp tools
  function placeRectTool(local: number) {
    const H0 = 8.5
    const [h0, h1, h2] = T.hits
    const approach = 0.02
    let x = stampAt[0].x
    let z = stampAt[0].z
    let a = stampAt[0].a
    let y = 10
    let squash = 0
    let tilt = 0
    if (local >= h0 - approach && local < h0) {
      const k = segment(local, h0 - approach, h0)
      y = H0 * (1 - k * k)
      tilt = (1 - k) * 0.12
    } else if (local >= h0 && local < h2 + 0.022) {
      const hops = [h0, h1, h2]
      let j = 0
      while (j < 2 && local >= hops[j + 1]) j++
      if (j < 2 && local >= hops[j] + 0.004) {
        // hop from spot j to spot j+1
        const k = segment(local, hops[j] + 0.004, hops[j + 1])
        const ke = ease.inOutCubic(k)
        x = lerp(stampAt[j].x, stampAt[j + 1].x, ke)
        z = lerp(stampAt[j].z, stampAt[j + 1].z, ke)
        a = lerp(stampAt[j].a, stampAt[j + 1].a, ke)
        y = Math.sin(Math.PI * Math.min(1, k * 1.08)) * 1.6 * (k < 0.93 ? 1 : 0)
        tilt = Math.sin(Math.PI * k) * 0.14
      } else if (j === 2 && local >= h2 + 0.004) {
        // lift off fast so the last impression reads
        const k = segment(local, h2 + 0.004, h2 + 0.022)
        x = stampAt[2].x
        z = stampAt[2].z
        a = stampAt[2].a
        y = H0 * 1.2 * ease.outCubic(k)
        tilt = k * 0.1
      } else {
        x = stampAt[j].x
        z = stampAt[j].z
        a = stampAt[j].a
        y = 0
      }
      const since = local - hops[j]
      squash = since >= 0 && since < 0.006 ? 1 - since / 0.006 : 0
    }
    rectTool.set(x, z, y, -a, squash, tilt)
  }

  function placeSealTool(local: number) {
    const H0 = 8.5
    const hit = T.seal
    let y = 10
    let squash = 0
    let tilt = 0
    if (local >= hit - 0.024 && local < hit) {
      const k = segment(local, hit - 0.024, hit)
      y = H0 * (1 - k * k)
      tilt = (1 - k) * 0.1
    } else if (local >= hit && local < hit + 0.035) {
      const since = local - hit
      squash = since < 0.007 ? 1 - since / 0.007 : 0
      const k = segment(local, hit + 0.006, hit + 0.035)
      y = H0 * k * k
      tilt = k * 0.08
    }
    sealTool.set(sealAt.x, sealAt.z, y, -(sealAt.a + target.yaw), squash, tilt)
  }
}
