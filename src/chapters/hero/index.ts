import * as THREE from 'three'
import type { CameraPose, Chapter, ChapterContext, Frame } from '../../core/types'
import { clamp, lerp, smoothstep } from '../../core/math'
import { createMat } from './mat'
import { Sheet, sheetShadowMaterial, TRIM } from './sheet'
import { Block, blockShared } from './stamp'
import { HeroUI } from './ui'
import {
  PASSES,
  REG_OFFSET,
  T,
  backOut,
  easeInCubic,
  easeInOut,
  easeOutCubic,
  layoutFor,
  onTwos,
  registerError,
  sheetQuat,
  type Layout,
} from './shared'
import './hero.css'

/*
 * HERO — "Proof". The studio as a riso print shop.
 *
 *   0.00–0.10  a blank sheet feeds onto a green cutting mat; a job ticket
 *              is taped beside it (colophon + scroll hint)
 *   0.10–0.56  THREE PASSES: the key, green and pink blocks hop in, drop,
 *              squash and lift, each leaving its plate on the sheet —
 *              misregistered, until the register clicks home (0.47–0.59)
 *   0.60–0.92  PULL THE PRINT: the sheet peels off the bed, lifts and turns
 *              to the camera as a finished poster; the headline stamps in
 *   0.92–1.00  the poster is whisked off the bed and green floods the sheet
 *
 * The blocks and the sheet move "on twos" (12 drawings a second) so they
 * read as stop-motion paper; the camera stays smooth.
 */

interface Key {
  t: number
  el: number
  az: number
  zoom: number
  ox: number
  oz: number
  fov: number
}
type Prop = Exclude<keyof Key, 't'>

const D2R = Math.PI / 180
// prettier-ignore
const KEYS_LAND: Key[] = [
  { t: 0.0,  el: 72, az: -2, zoom: 1.6,  ox: -1.65, oz: -1.5,  fov: 30 },
  { t: 0.08, el: 70, az: -2, zoom: 1.56, ox: -1.45, oz: -1.45, fov: 30 },
  { t: 0.155, el: 48, az: 8, zoom: 1.3,  ox: 0.75,  oz: -1.25, fov: 30 },
  { t: 0.315, el: 45, az: -6, zoom: 1.28, ox: 0.8,  oz: -1.25, fov: 30 },
  { t: 0.475, el: 48, az: 7, zoom: 1.3,  ox: 0.75,  oz: -1.25, fov: 30 },
  { t: 0.565, el: 62, az: 0, zoom: 1.12, ox: 0.2,   oz: -0.35, fov: 30 },
  { t: 0.62, el: 64, az: 0,  zoom: 1.08, ox: 0.0,   oz: 0.0,   fov: 30 },
]
// prettier-ignore
const KEYS_PORT: Key[] = [
  { t: 0.0,  el: 72, az: -2, zoom: 1.12, ox: 0.0,  oz: -2.1,  fov: 40 },
  { t: 0.08, el: 70, az: -2, zoom: 1.1,  ox: 0.0,  oz: -2.0,  fov: 40 },
  { t: 0.155, el: 52, az: 6, zoom: 1.12, ox: 0.1,  oz: -2.4,  fov: 40 },
  { t: 0.315, el: 49, az: -5, zoom: 1.1, ox: 0.1,  oz: -2.4,  fov: 40 },
  { t: 0.475, el: 52, az: 5, zoom: 1.12, ox: 0.1,  oz: -2.4,  fov: 40 },
  { t: 0.565, el: 64, az: 0, zoom: 1.02, ox: 0.0,  oz: -0.6,  fov: 40 },
  { t: 0.62, el: 65, az: 0,  zoom: 1.02, ox: 0.0,  oz: -0.3,  fov: 40 },
]

/** Smooth monotone cubic through the keys. */
function sample(keys: Key[], t: number, prop: Prop): number {
  const n = keys.length
  if (t <= keys[0].t) return keys[0][prop]
  if (t >= keys[n - 1].t) return keys[n - 1][prop]
  let i = 0
  while (i < n - 2 && t > keys[i + 1].t) i++
  const k0 = keys[i]
  const k1 = keys[i + 1]
  const h = k1.t - k0.t
  const s = (t - k0.t) / h
  const slope = (j: number) => {
    if (j <= 0 || j >= n - 1) return 0
    const a = keys[j - 1],
      b = keys[j],
      c = keys[j + 1]
    const d0 = (b[prop] - a[prop]) / (b.t - a.t)
    const d1 = (c[prop] - b[prop]) / (c.t - b.t)
    if (d0 * d1 <= 0) return 0
    return (2 * d0 * d1) / (d0 + d1)
  }
  const m0 = slope(i) * h
  const m1 = slope(i + 1) * h
  const s2 = s * s
  const s3 = s2 * s
  return (2 * s3 - 3 * s2 + 1) * k0[prop] + (s3 - 2 * s2 + s) * m0 + (-2 * s3 + 3 * s2) * k1[prop] + (s3 - s2) * m1
}

const now = () => performance.now() / 1000
const yieldFrame = () =>
  new Promise<void>(r => {
    if (document.hidden) setTimeout(r, 0)
    else requestAnimationFrame(() => r())
  })

export default function create(): Chapter {
  const group = new THREE.Group()
  let layout: Layout = layoutFor(16 / 10)
  let aspect = 0
  let sheet: Sheet
  let ui: HeroUI
  let blocks: Block[] = []
  let sheetShadow: THREE.Mesh
  let reduced = false
  let revealAt = -1
  let held = 0
  let heldTick = -1
  let thumpNow = 0

  // world helpers
  const qSkew = new THREE.Quaternion()
  const qFlat = new THREE.Quaternion()
  const qPoster = new THREE.Quaternion()
  const qTmp = new THREE.Quaternion()
  const posterPos = new THREE.Vector3()
  const posterN = new THREE.Vector3()
  const posterUp = new THREE.Vector3()
  const posterRight = new THREE.Vector3()
  const v1 = new THREE.Vector3()
  const v2 = new THREE.Vector3()
  const v3 = new THREE.Vector3()
  const v4 = new THREE.Vector3()
  const calloutWorld = new THREE.Vector3()
  const euler = new THREE.Euler(0, 0, 0, 'YZX')

  /** poster framing (px) + camera distance, recomputed when the viewport changes */
  const pf = { key: '', D: 10, fov: 30, cx: 0, cy: 0, pw: 0, ph: 0, ppu: 100, offUp: 0 }

  /** sheet-space (x, y up the print) → world on the bed */
  const bedPoint = (x: number, y: number, out: THREE.Vector3) => out.set(x, 0, -y).applyQuaternion(qSkew)

  function setLayout(a: number) {
    const next = layoutFor(a)
    aspect = a
    if (sheet && next.port === layout.port && sheet.u.uSize.value.x === next.w) return
    layout = next
    sheet?.setLayout(layout)
    qSkew.setFromAxisAngle(new THREE.Vector3(0, 1, 0), layout.skew)
    qFlat.setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0)).premultiply(qSkew)
    // the poster: lifted off the bed, tilted up toward the viewer
    const el = (layout.port ? 47 : 40) * D2R
    posterN.set(0, Math.sin(el), Math.cos(el))
    posterUp.set(0, Math.cos(el), -Math.sin(el))
    posterRight.crossVectors(posterUp, posterN).normalize()
    posterPos.set(0, layout.port ? 3.3 : 2.7, layout.port ? 0.4 : 0.9)
    sheetQuat(posterN, posterUp, qPoster)
    pf.key = ''
  }

  /** Where the settled poster sits on screen, and the camera distance that puts it there. */
  function posterFrame(w: number, h: number) {
    const key = `${w}|${h}|${layout.port}|${ui?.safe.top}|${ui?.safe.bottom}`
    if (key === pf.key) return pf
    pf.key = key
    const safeTop = ui?.safe.top ?? 90
    const safeBot = ui?.safe.bottom ?? 80
    const fov = layout.port ? 38 : 30
    const sa = layout.w / layout.h
    let ph = Math.min(h - safeTop - safeBot + (layout.port ? 40 : 90), h * 0.9)
    let pw = ph * sa
    const maxW = w * (layout.port ? 0.93 : 0.9)
    if (pw > maxW) {
      pw = maxW
      ph = pw / sa
    }
    const cy = safeTop + (h - safeTop - safeBot) / 2 + (layout.port ? 4 : 0)
    const tanH = Math.tan((fov * D2R) / 2)
    pf.fov = fov
    pf.D = (layout.h * h) / (2 * tanH * ph)
    pf.pw = pw
    pf.ph = ph
    pf.cx = w / 2
    pf.cy = cy
    pf.ppu = ph / layout.h
    // shift the camera parallel to the poster so its centre lands on cy
    pf.offUp = (cy - h / 2) / pf.ppu
    return pf
  }

  function fitDist(keys: Key[], t: number, a: number) {
    const fov = sample(keys, t, 'fov') * D2R
    const el = sample(keys, t, 'el') * D2R
    const tanH = Math.tan(fov / 2)
    const needW = (layout.w + 1.4) / (2 * tanH * a)
    const needH = ((layout.h + 1.3) * Math.sin(el) + 0.8 * Math.cos(el)) / (2 * tanH)
    return Math.max(needW, needH)
  }

  /** where each block waits: a row on the bench beyond the sheet's head */
  const REST_YAW = [0.07, -0.035, 0.09]
  function restPoint(i: number, out: THREE.Vector3) {
    const xs = layout.port ? [-3.15, 0, 3.15] : [-3.22, 0, 3.22]
    return bedPoint(xs[i], layout.h / 2 + 1.95, out)
  }

  /**
   * Block choreography for pass i at (held) local l: wait in the row → hop
   * to the mark → hover, anticipate, drop → squash → lift → flip back home.
   */
  function blockPose(i: number, l: number, b: Block, motion: number, rt: number, gate: number, next: number) {
    const P = PASSES[i]
    const c = P.contact
    const land = bedPoint(layout.mx + REG_OFFSET[i][0], layout.my + REG_OFFSET[i][1], v1)
    const rest = restPoint(i, v2)
    const hoverY = layout.port ? 1.7 : 1.55
    const tDrop = c - 0.026
    const tHold = tDrop - 0.008
    const tLift = c + 0.014
    const tExit = c + 0.036
    let x = rest.x
    let y = 0
    let z = rest.z
    let yaw = layout.skew + REST_YAW[i]
    let roll = 0
    let tilt = 0
    let squash = 0
    if (l <= P.a || l >= P.b) {
      // waiting in the row (dropped in after the sheet feeds, on twos)
      const k = clamp((rt - 0.62 - i * 0.16) / 0.42)
      if (gate > 0) {
        y += (1 - k * k) * 6 * gate
        const s = clamp((rt - 0.62 - i * 0.16 - 0.42) / 0.2)
        if (k >= 1 && s < 1) squash = Math.sin(s * Math.PI) * 0.16 * gate * motion
      }
      // after its pass it sits a little squarer
      if (l >= P.b) yaw = layout.skew + REST_YAW[i] * 0.4
      // the next block up gets restless: a little hop every few seconds
      else if (motion > 0 && next === i && rt > 2.2) {
        const ph = (rt % 2.8) / 0.42
        if (ph < 1) {
          y += 0.16 * Math.sin(ph * Math.PI)
          tilt += 0.05 * Math.sin(ph * Math.PI * 2)
        } else if (ph < 1.45) squash = Math.sin(((ph - 1) / 0.45) * Math.PI) * 0.08
      }
    } else if (l < tHold) {
      const e = easeInOut((l - P.a) / (tHold - P.a))
      x = lerp(rest.x, land.x, e)
      z = lerp(rest.z, land.z, e)
      y = lerp(0, hoverY, e) + 2.2 * e * (1 - e) * motion
      tilt = 0.32 * Math.sin(e * Math.PI) * motion
      yaw = lerp(layout.skew + REST_YAW[i], layout.skew, e)
      // take-off crouch
      if (e < 0.12) squash = Math.sin((e / 0.12) * Math.PI) * 0.12 * motion
    } else if (l < tDrop) {
      // anticipation: a little rise before the drop
      const k = (l - tHold) / (tDrop - tHold)
      x = land.x
      z = land.z
      yaw = layout.skew
      y = hoverY + 0.32 * Math.sin(k * Math.PI * 0.5)
    } else if (l < c) {
      const k = (l - tDrop) / (c - tDrop)
      x = land.x
      z = land.z
      yaw = layout.skew
      y = (hoverY + 0.32) * (1 - easeInCubic(k))
    } else if (l < tLift) {
      const k = (l - c) / (tLift - c)
      x = land.x
      z = land.z
      yaw = layout.skew
      squash = k < 0.6 ? Math.sin((k / 0.6) * Math.PI) * 0.17 : -Math.sin(((k - 0.6) / 0.4) * Math.PI) * 0.05
    } else if (l < tExit) {
      const k = (l - tLift) / (tExit - tLift)
      x = land.x
      z = land.z
      yaw = layout.skew
      y = 1.4 * easeOutCubic(k)
      tilt = -0.22 * Math.sin(k * Math.PI) * motion
    } else {
      // home, with a full flip that flashes the freshly inked face
      const e = easeInOut((l - tExit) / (P.b - tExit))
      x = lerp(land.x, rest.x, e)
      z = lerp(land.z, rest.z, e)
      y = lerp(1.4, 0, e) + 2.6 * e * (1 - e) * motion
      yaw = lerp(layout.skew, layout.skew + REST_YAW[i] * 0.4, e)
      roll = -Math.PI * 2 * easeInOut(clamp((e - 0.08) / 0.8)) * motion
      if (e > 0.9) {
        y = Math.max(0, y)
        squash = Math.sin(((e - 0.9) / 0.1) * Math.PI) * 0.14 * motion
      }
    }
    b.root.position.set(x, y, z)
    euler.set(tilt + roll, yaw, 0)
    b.root.quaternion.setFromEuler(euler)
    b.body.scale.set(1 + squash * 0.45, 1 - squash, 1 + squash * 0.45)
    // contact shadow on the bed below
    const s = b.shadowU
    const hgt = Math.max(0, y)
    b.shadow.position.set(x + hgt * 0.22, 0.024, z + hgt * 0.1)
    b.shadow.rotation.set(-Math.PI / 2, 0, yaw)
    const spread = 1 + hgt * 0.16
    const pw = b.footprint.x * spread + 1.2
    const pd = b.footprint.y * spread + 1.2
    b.shadow.scale.set(pw, pd, 1)
    s.uPlane.value.set(pw, pd)
    s.uHalf.value.set((b.footprint.x * spread) / 2, (b.footprint.y * spread) / 2)
    s.uSoft.value = 0.1 + hgt * 0.22
    s.uStrength.value = 0.5 * clamp(1 - hgt / 7)
    return y
  }

  return {
    id: 'hero',
    group,

    async init(ctx: ChapterContext) {
      reduced = ctx.reducedMotion
      setLayout(window.innerWidth / Math.max(1, window.innerHeight))
      group.add(createMat())
      sheet = new Sheet(ctx.mobile)
      sheet.setLayout(layout)
      group.add(sheet.mesh)
      sheetShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), sheetShadowMaterial())
      sheetShadow.renderOrder = 1
      group.add(sheetShadow)
      await yieldFrame()

      const shared = blockShared()
      for (let i = 0; i < 3; i++) {
        const b = new Block(i, 2.5, shared, ctx.mobile)
        blocks.push(b)
        group.add(b.root, b.shadow)
        if (i === 1) await yieldFrame()
      }

      ui = new HeroUI(ctx.stage)

      // redraw the printed slugs once the mono face is in
      document.fonts
        ?.load('500 20px "DM Mono"')
        .then(() => sheet.drawSlug())
        .catch(() => {})

      const onReveal = () => {
        if (revealAt < 0) revealAt = now()
      }
      if (document.documentElement.dataset.ready === '1') onReveal()
      else window.addEventListener('hark:reveal', onReveal, { once: true })
    },

    update(local: number, frame: Frame, ctx: ChapterContext) {
      const a = frame.width / Math.max(1, frame.height)
      if (Math.abs(a - aspect) > 1e-3) setLayout(a)
      const L = local
      const motion = reduced ? 0 : 1
      const t = frame.time
      const rt = revealAt < 0 ? 0 : now() - revealAt

      // blocks and sheet move on twos; the camera stays smooth
      const tick = Math.floor(t * 12)
      if (reduced || tick !== heldTick || Math.abs(L - held) > 0.05) {
        heldTick = tick
        held = L
      }
      const H = reduced ? L : held
      const tw = reduced ? t : onTwos(t)

      // --- intro: the sheet feeds in after the loader hands over ---
      const introK = clamp((onTwos(rt) - 0.15) / 0.85)
      const intro = reduced ? (rt > 0 ? 1 : 0) : revealAt < 0 ? 0 : introK
      const feed = (1 - backOut(intro, 1.1)) * (1 - smoothstep(0.02, 0.08, L))

      // --- register ---
      const err = registerError(L)
      const u = sheet.u
      u.uOffK.value.set(REG_OFFSET[0][0] * err, REG_OFFSET[0][1] * err)
      u.uOffG.value.set(REG_OFFSET[1][0] * err, REG_OFFSET[1][1] * err)
      u.uOffP.value.set(REG_OFFSET[2][0] * err, REG_OFFSET[2][1] * err)

      // --- impressions + blocks ---
      let pass = 0
      let done = 0
      let thump = 0
      let next = -1
      for (let i = 0; i < 3; i++) if (next < 0 && H < PASSES[i].a) next = i
      for (let i = 0; i < 3; i++) {
        const c = PASSES[i].contact
        const amt = smoothstep(c - 0.0005, c + 0.003, H)
        u.uAmt.value.setComponent(i, amt)
        if (H >= c) done++
        if (L > PASSES[i].a + 0.02) pass = i
        const d = (L - c) / 0.005
        thump = Math.max(thump, Math.exp(-d * d))
        blockPose(i, H, blocks[i], motion, revealAt < 0 ? 0 : reduced ? 9 : onTwos(rt), 1 - smoothstep(0.02, 0.08, L), next)
      }
      if (!reduced) ctx.post.params.glitch = thump * 0.28
      ctx.post.params.misreg = 1.4 + thump * 1.6

      // --- the sheet: bed → peel → lift → poster → whisked off ---
      const peel = easeInOut((H - T.peelA) / (T.liftA + 0.02 - T.peelA))
      const lift = easeInOut((H - T.liftA) / (T.poster - T.liftA))
      const out = smoothstep(T.outA, 0.985, L)
      const settle = clamp((H - T.liftA) / (T.poster + 0.03 - T.liftA))

      qTmp.copy(qFlat).slerp(qPoster, lift)
      sheet.mesh.quaternion.copy(qTmp)
      const pos = sheet.mesh.position
      pos.set(0, 0.012, 0).lerp(posterPos, lift)
      pos.y += Math.sin(lift * Math.PI) * 0.9
      // intro feed: slid in from the right, riding on a cushion of air
      pos.x += feed * 15
      pos.y += Math.max(0, feed) * 0.3
      // out: pulled away along the poster's plane
      if (out > 0) {
        pos.addScaledVector(posterRight, -out * layout.w * 1.45)
        pos.addScaledVector(posterUp, out * 0.5)
        qTmp.setFromAxisAngle(posterN, out * 0.1)
        sheet.mesh.quaternion.premultiply(qTmp)
      }

      // peel / curl
      const peelDirX = layout.port ? -0.55 : -0.707
      const peelDirY = layout.port ? 0.835 : 0.707
      if (feed > 0.001) {
        u.uPeel.value.set(1, 0, 1.1, 0.6 * clamp(feed * 3))
      } else if (out > 0) {
        u.uPeel.value.set(-1, 0, out * 2.8, out * 1.1)
      } else {
        const unpeel = 1 - smoothstep(T.liftA, T.poster - 0.02, H)
        u.uPeel.value.set(peelDirX, peelDirY, (peel * 2.3 + lift * 0.8) * unpeel, (peel * 1.55 + lift * 0.3) * unpeel)
      }
      u.uPeelR.value = 0.34

      // ripple: settling flutter after the lift, a breath on the poster, a flap on the way out
      const flutter = Math.sin(settle * Math.PI) * (1 - settle * 0.6) * 0.2
      const idle = H > T.liftA ? 0.012 * motion : 0
      const amp = flutter * motion + idle + out * 0.16 * motion + Math.max(0, feed) * 0.05 * motion
      u.uWave.value.set(amp, 2.1, H * 70 * motion + tw * 2.4 * motion, 0.7)
      u.uWaveDir.value.set(feed > 0.001 ? -1 : layout.port ? 0 : 0.7071, feed > 0.001 ? 0 : layout.port ? 1 : 0.7071)
      u.uGuide.value = 1 - smoothstep(T.liftA, T.liftA + 0.06, H)

      // the sheet's shadow on the mat
      const sh = sheetShadow
      const ss = (sheetShadow.material as THREE.ShaderMaterial).uniforms
      const air = Math.max(0, pos.y)
      sh.position.set(pos.x + 0.12 + air * 0.3, 0.004, pos.z + 0.08 + air * 0.15)
      sh.rotation.set(-Math.PI / 2, 0, layout.skew * (1 - lift))
      const growW = layout.w * (1 + air * 0.05) + 0.25
      const growH = layout.h * (1 - lift * 0.35) * (1 + air * 0.05) + 0.25
      sh.scale.set(growW + 2, growH + 2, 1)
      ss.uPlane.value.set(growW + 2, growH + 2)
      ss.uHalf.value.set(growW / 2, growH / 2)
      ss.uSoft.value = 0.06 + air * 0.25
      ss.uStrength.value = lerp(0.42, 0.22, clamp(air / 3)) * (1 - out)
      sh.visible = feed < 0.98

      // --- the DOM ---
      const f = posterFrame(frame.width, frame.height)
      const titleSize = layout.port ? Math.min(f.pw * 0.2, f.ph * 0.11) : Math.min((f.pw * 0.47) / 3.05, f.ph * 0.19)
      ui.setPoster({
        x: f.cx - f.pw / 2,
        y: f.cy - f.ph / 2,
        w: f.pw,
        h: f.ph,
        fs: titleSize,
        port: layout.port,
      })
      // registration target, top right corner (true position)
      const cxs = layout.w / 2 - TRIM * 0.5
      const cys = layout.h / 2 - TRIM * 0.5
      calloutWorld.set(cxs, cys, 0).applyQuaternion(sheet.mesh.quaternion).add(sheet.mesh.position)
      ui.update({
        local: L,
        intro: revealAt < 0 ? 0 : clamp(rt / 1.2),
        pass,
        done,
        err,
        posterOn: L > T.titleA && L < 0.995,
        shiftX: -out * layout.w * 1.45 * f.ppu,
        shiftY: -out * 0.5 * f.ppu,
        calloutWorld,
        calloutOn: L > 0.505 && L < 0.598,
        camera: ctx.camera,
        w: frame.width,
        h: frame.height,
        dt: frame.dt,
      })

      thumpNow = thump
    },

    camera(local: number, frame: Frame, out: CameraPose) {
      const keys = layout.port ? KEYS_PORT : KEYS_LAND
      const a = frame.width / Math.max(1, frame.height)
      const t = Math.min(local, 0.62)
      const el = sample(keys, t, 'el') * D2R
      const az = sample(keys, t, 'az') * D2R
      const dist = fitDist(keys, t, a) * sample(keys, t, 'zoom')
      const tx = sample(keys, t, 'ox')
      const tz = sample(keys, t, 'oz')
      const bedFov = sample(keys, t, 'fov')
      const tgt = v1.set(tx, 0, tz)
      const cam = v2.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(dist).add(tgt)

      // the poster frame: square to the pulled print
      const f = posterFrame(frame.width, frame.height)
      const w = easeInOut((local - T.peelA) / (T.poster - T.peelA))
      if (w > 0) {
        const pTgt = v3.copy(posterPos).addScaledVector(posterUp, f.offUp)
        const pCam = v4.copy(pTgt).addScaledVector(posterN, f.D)
        tgt.lerp(pTgt, w)
        cam.lerp(pCam, w)
        // arc the move so the camera swings rather than slides
        cam.y += Math.sin(w * Math.PI) * 0.6
      }
      out.position.copy(cam)
      out.target.copy(tgt)
      out.fov = lerp(bedFov, f.fov, w)
      // the thump of each impression
      if (!reduced && thumpNow > 0.01) out.position.y -= thumpNow * 0.06
      out.parallax = w > 0.5 ? 0 : 0.22 * (1 - w * 2)
      out.roll = 0
    },
  }
}
